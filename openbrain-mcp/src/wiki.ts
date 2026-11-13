// Compiled-wiki layer (Karpathy llm-wiki pattern): raw thoughts are the
// sources; wiki_pages hold LLM-maintained synthesis (entity pages for people,
// concept pages for topics). get_index returns a catalog small enough to sit
// in one context window, so a client LLM can navigate without vector search.

import { EMBED_STAMP } from "./config.ts";
import { getState, logOp, setState, withConn } from "./db.ts";
import { chat, embedDocs, parseJsonReply } from "./llm.ts";

export interface WikiPage {
  id: string;
  name: string;
  title: string;
  summary: string;
  content: string;
  kind: string;
  sources: string[];
  created_at: Date | string;
  updated_at: Date | string;
}

// Text a page is embedded from: what it is about first, then the body.
export function pageEmbedText(p: { title: string; summary: string; content: string }): string {
  return `${p.title}\n${p.summary}\n\n${p.content}`;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// ── Page CRUD ─────────────────────────────────────────────────────────────────

export async function getIndex(): Promise<string> {
  const pages = await withConn(async (c) => {
    const r = await c.queryObject<Pick<WikiPage, "name" | "summary" | "kind" | "updated_at">>(
      `SELECT name, summary, kind, updated_at FROM wiki_pages ORDER BY kind, name`,
    );
    return r.rows;
  });
  if (pages.length === 0) {
    return "The wiki is empty. Pages are created by write_page or the consolidate job.";
  }
  const byKind = new Map<string, typeof pages>();
  for (const p of pages) {
    if (!byKind.has(p.kind)) byKind.set(p.kind, []);
    byKind.get(p.kind)!.push(p);
  }
  const lines: string[] = [`# Wiki index (${pages.length} pages)`];
  for (const [kind, group] of byKind) {
    lines.push(`\n## ${kind}`);
    for (const p of group) {
      const d = new Date(p.updated_at).toISOString().slice(0, 10);
      lines.push(`- [[${p.name}]] — ${p.summary || "(no summary)"} (${d})`);
    }
  }
  return lines.join("\n");
}

export async function readPage(name: string): Promise<WikiPage | null> {
  return await withConn(async (c) => {
    const r = await c.queryObject<WikiPage>(
      `SELECT id, name, title, summary, content, kind, sources, created_at, updated_at
       FROM wiki_pages WHERE name = $1`,
      [slugify(name)],
    );
    return r.rows.length ? r.rows[0] : null;
  });
}

// Where a page's content came from, and whether those sources still stand.
export interface Provenance {
  total: number;
  current: number;
  superseded: string[];   // source thoughts since replaced by newer ones
  missing: string[];      // source thoughts since deleted
}

export async function pageProvenance(page: Pick<WikiPage, "sources">): Promise<Provenance> {
  const ids = page.sources ?? [];
  if (ids.length === 0) return { total: 0, current: 0, superseded: [], missing: [] };
  const rows = await withConn(async (c) => {
    const r = await c.queryObject<{ id: string; superseded_by: string | null }>(
      `SELECT id, superseded_by FROM thoughts WHERE id = ANY($1::uuid[])`, [ids],
    );
    return r.rows;
  });
  const found = new Map(rows.map((r) => [r.id, r.superseded_by]));
  const superseded = ids.filter((i) => found.get(i));
  const missing = ids.filter((i) => !found.has(i));
  return { total: ids.length, current: ids.length - superseded.length - missing.length, superseded, missing };
}

export function formatProvenance(p: Provenance): string {
  if (p.total === 0) return "Sources: none recorded (written by hand, or compiled before provenance was tracked).";
  const parts = [`Sources: ${p.total} thought(s), ${p.current} still current`];
  if (p.superseded.length) parts.push(`${p.superseded.length} since superseded (${p.superseded.join(", ")})`);
  if (p.missing.length) parts.push(`${p.missing.length} since deleted`);
  const warn = p.superseded.length || p.missing.length
    ? " This page may state things that are no longer true; refresh it."
    : "";
  return parts.join("; ") + "." + warn;
}

// `sources`: thought ids this page was compiled from. undefined = keep whatever
// the page already records (a hand edit does not erase provenance).
export async function writePage(
  page: { name: string; title: string; summary: string; content: string; kind: string; sources?: string[] },
  source: string,
): Promise<string> {
  const name = slugify(page.name);
  let embedding: number[] | null = null;
  try {
    embedding = (await embedDocs([pageEmbedText(page)]))[0];
  } catch { /* Node A offline: the backfill worker embeds the page later */ }
  const id = await withConn(async (c) => {
    const r = await c.queryObject<{ id: string }>(
      `INSERT INTO wiki_pages (name, title, summary, content, kind, sources, embedding, embedding_model)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::uuid[], '{}'), $7::vector(768), $8)
       ON CONFLICT (name) DO UPDATE SET
         title = EXCLUDED.title, summary = EXCLUDED.summary,
         content = EXCLUDED.content, kind = EXCLUDED.kind,
         sources = COALESCE($6::uuid[], wiki_pages.sources),
         embedding = EXCLUDED.embedding, embedding_model = EXCLUDED.embedding_model
       RETURNING id`,
      [
        name, page.title, page.summary, page.content, page.kind,
        page.sources ? [...new Set(page.sources)] : null,
        embedding ? `[${embedding.join(",")}]` : null,
        embedding ? EMBED_STAMP : null,
      ],
    );
    return r.rows[0].id;
  });
  await logOp("wiki_write", source, name, { kind: page.kind, sources: page.sources?.length ?? null });
  return id;
}

export async function deletePage(name: string, source: string): Promise<boolean> {
  const deleted = await withConn(async (c) => {
    const r = await c.queryObject(
      `DELETE FROM wiki_pages WHERE name = $1 RETURNING id`, [slugify(name)],
    );
    return r.rows.length > 0;
  });
  if (deleted) await logOp("wiki_delete", source, slugify(name));
  return deleted;
}

// ── Consolidation ─────────────────────────────────────────────────────────────
// Reads thoughts captured since the last run, picks the most-mentioned people
// and topics, and has the chat model create/update their wiki pages. Bounded
// per run so a nightly trigger does a little work often.

const WATERMARK_KEY = "last_consolidate_watermark";
const MAX_PAGES_PER_RUN = 8;
const MAX_THOUGHTS_PER_RUN = 200;
const MAX_THOUGHTS_PER_PAGE = 30;

interface RecentThought {
  id: string;
  content: string;
  metadata: { people?: string[]; topics?: string[]; [k: string]: unknown };
  updated_at: Date | string;
}

export async function consolidate(trigger: string): Promise<string> {
  const watermark = (await getState<string>(WATERMARK_KEY)) ?? "1970-01-01T00:00:00Z";

  const thoughts = await withConn(async (c) => {
    const r = await c.queryObject<RecentThought>(
      `SELECT id, content, metadata, updated_at FROM thoughts
       WHERE updated_at > $1::timestamptz AND superseded_by IS NULL
       ORDER BY updated_at ASC LIMIT ${MAX_THOUGHTS_PER_RUN}`,
      [watermark],
    );
    return r.rows;
  });
  if (thoughts.length === 0) return "Nothing to consolidate — no new thoughts since last run.";

  // Rank candidate pages by mention count across the new thoughts.
  const counts = new Map<string, { kind: "entity" | "concept"; label: string; thoughts: RecentThought[] }>();
  for (const t of thoughts) {
    for (const person of t.metadata.people ?? []) {
      const key = `entity:${slugify(person)}`;
      if (!counts.has(key)) counts.set(key, { kind: "entity", label: person, thoughts: [] });
      counts.get(key)!.thoughts.push(t);
    }
    for (const topic of t.metadata.topics ?? []) {
      if (topic === "uncategorized") continue;
      const key = `concept:${slugify(topic)}`;
      if (!counts.has(key)) counts.set(key, { kind: "concept", label: topic, thoughts: [] });
      counts.get(key)!.thoughts.push(t);
    }
  }

  const candidates = [...counts.values()]
    .toSorted((a, b) => b.thoughts.length - a.thoughts.length)
    .slice(0, MAX_PAGES_PER_RUN);

  const updated: string[] = [];
  const failed: string[] = [];

  for (const cand of candidates) {
    const name = slugify(cand.label);
    try {
      const existing = await readPage(name);
      const used = cand.thoughts.slice(0, MAX_THOUGHTS_PER_PAGE);
      // Provenance: keep the existing page's sources that still stand, drop the
      // ones superseded or deleted since, add the notes used now.
      let keptSources: string[] = [];
      let outdatedNote = "";
      if (existing) {
        const prov = await pageProvenance(existing);
        const gone = new Set([...prov.superseded, ...prov.missing]);
        keptSources = (existing.sources ?? []).filter((i) => !gone.has(i));
        if (gone.size) {
          outdatedNote = `\nNote: ${gone.size} of the notes the existing page was built from have since been replaced or deleted. Where the new notes disagree with the existing page, the new notes are right.`;
        }
      }
      const sources = used
        .map((t) => `- (${new Date(t.updated_at).toISOString().slice(0, 10)}) ${t.content}`)
        .join("\n");

      const prompt = `You maintain a personal knowledge wiki. ${
        existing
          ? `Update the existing page below by integrating the new notes. Preserve still-valid information, resolve contradictions in favor of newer notes, and keep it concise.`
          : `Create a new wiki page about "${cand.label}" from the notes below.`
      }
Use markdown. Link related concepts/people with [[wikilinks]] (kebab-case slugs). Do not invent facts not present in the notes${existing ? " or the existing page" : ""}.
${existing ? `\nExisting page:\n${existing.content}\n${outdatedNote}` : ""}
New notes:
${sources}

Reply with JSON only: {"title": string, "summary": string (one line, <120 chars), "content": string (the full markdown page)}`;

      const raw = await chat(prompt, { json: true });
      const parsed = parseJsonReply<{ title: string; summary: string; content: string }>(raw);
      if (!parsed.content || !parsed.title) throw new Error("model returned incomplete page");

      await writePage(
        {
          name,
          title: parsed.title,
          summary: parsed.summary ?? "",
          content: parsed.content,
          kind: cand.kind,
          sources: [...keptSources, ...used.map((t) => t.id)],
        },
        "consolidate",
      );
      updated.push(name);
    } catch (e) {
      failed.push(`${name}: ${(e as Error).message}`);
    }
  }

  // Advance the watermark only past what was actually examined.
  const newWatermark = new Date(thoughts[thoughts.length - 1].updated_at).toISOString();
  await setState(WATERMARK_KEY, newWatermark);
  await logOp("consolidate", trigger, updated.join(","), {
    thoughts_examined: thoughts.length,
    pages_updated: updated.length,
    failures: failed.length,
  });

  return [
    `Consolidated ${thoughts.length} thought(s) into ${updated.length} page(s): ${updated.map((n) => `[[${n}]]`).join(", ") || "none"}`,
    failed.length ? `Failures:\n${failed.join("\n")}` : "",
    `Watermark advanced to ${newWatermark}.`,
  ].filter(Boolean).join("\n");
}

// ── Audit ─────────────────────────────────────────────────────────────────────
// Structural lint: orphans, broken links, stale pages, hot topics with no
// page, pending backfill. Semantic contradiction-checking is left to the
// calling LLM, which can read pages via read_page.

export async function audit(): Promise<string> {
  const pages = await withConn(async (c) => {
    const r = await c.queryObject<Pick<WikiPage, "name" | "content" | "updated_at" | "sources">>(
      `SELECT name, content, updated_at, sources FROM wiki_pages`,
    );
    return r.rows;
  });

  const names = new Set(pages.map((p) => p.name));
  const inbound = new Map<string, number>();
  const broken = new Set<string>();
  for (const p of pages) {
    for (const m of p.content.matchAll(/\[\[([^\]|#]+)/g)) {
      const target = slugify(m[1]);
      if (target === p.name) continue;
      if (names.has(target)) inbound.set(target, (inbound.get(target) ?? 0) + 1);
      else broken.add(`[[${target}]] (from [[${p.name}]])`);
    }
  }
  const orphans = pages.filter((p) => !(inbound.get(p.name) ?? 0)).map((p) => p.name);

  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const stale = pages
    .filter((p) => new Date(p.updated_at) < cutoff)
    .map((p) => `${p.name} (${new Date(p.updated_at).toISOString().slice(0, 10)})`);

  // Provenance: pages built from thoughts that were later superseded or deleted.
  const outdated: string[] = [];
  let untracked = 0;
  for (const p of pages) {
    if (!p.sources?.length) { untracked++; continue; }
    const prov = await pageProvenance(p);
    if (prov.superseded.length || prov.missing.length) {
      outdated.push(`[[${p.name}]]: ${prov.superseded.length} source(s) superseded, ${prov.missing.length} deleted, of ${prov.total}`);
    }
  }
  const { pendingConflicts, evalLine } = await withConn(async (c) => {
    const pc = await c.queryObject<{ n: number }>(`SELECT COUNT(*)::int AS n FROM thought_conflicts WHERE status = 'pending'`);
    const ev = await c.queryObject<{ ts: Date; cases: number; hit5: number; hit10: number; mrr: number }>(
      `SELECT ts, cases, hit5, hit10, mrr FROM eval_runs ORDER BY ts DESC LIMIT 1`,
    );
    const e = ev.rows[0];
    return {
      pendingConflicts: pc.rows[0].n,
      evalLine: e
        ? `Last retrieval test (${new Date(e.ts).toISOString().slice(0, 10)}, ${e.cases} cases): hit@5 ${(Number(e.hit5) * 100).toFixed(0)}%, hit@10 ${(Number(e.hit10) * 100).toFixed(0)}%, MRR ${Number(e.mrr).toFixed(2)}`
        : "",
    };
  });

  const { missingTopics, pendingCount } = await withConn(async (c) => {
    const topics = await c.queryObject<{ topic: string; n: number }>(
      `SELECT t.topic, COUNT(*)::int AS n
       FROM thoughts, jsonb_array_elements_text(metadata->'topics') AS t(topic)
       WHERE t.topic != 'uncategorized'
       GROUP BY t.topic HAVING COUNT(*) >= 3 ORDER BY n DESC LIMIT 20`,
    );
    const pending = await c.queryObject<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM thoughts WHERE embedding IS NULL`,
    );
    return {
      missingTopics: topics.rows.filter((t) => !names.has(slugify(t.topic))),
      pendingCount: pending.rows[0].n,
    };
  });

  return [
    `# Brain audit`,
    `Pages: ${pages.length}`,
    orphans.length ? `\n## Orphan pages (no inbound links)\n${orphans.map((n) => `- [[${n}]]`).join("\n")}` : "",
    broken.size ? `\n## Broken links\n${[...broken].map((b) => `- ${b}`).join("\n")}` : "",
    stale.length ? `\n## Stale pages (>30 days)\n${stale.map((s) => `- ${s}`).join("\n")}` : "",
    missingTopics.length
      ? `\n## Frequently-mentioned topics with no page\n${missingTopics.map((t) => `- ${t.topic} (${t.n} thoughts)`).join("\n")}`
      : "",
    outdated.length ? `\n## Pages built on outdated sources (re-run consolidate, or rewrite)\n${outdated.map((o) => `- ${o}`).join("\n")}` : "",
    untracked ? `\n## Provenance\n${untracked} page(s) have no recorded sources (hand-written, or compiled before v1.3.0).` : "",
    pendingConflicts ? `\n## Possible outdated facts\n${pendingConflicts} proposal(s) waiting in review_conflicts.` : "",
    evalLine ? `\n## Retrieval quality\n${evalLine}` : "",
    pendingCount ? `\n## Backfill\n${pendingCount} thought(s) awaiting embedding (Node A offline?)` : "",
    `\nTip: run consolidate to fill gaps, or use read_page/write_page to fix issues manually. For semantic contradiction checks, read suspect pages and compare against recent thoughts.`,
  ].filter(Boolean).join("\n");
}
