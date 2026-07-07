// Compiled-wiki layer (Karpathy llm-wiki pattern): raw thoughts are the
// sources; wiki_pages hold LLM-maintained synthesis (entity pages for people,
// concept pages for topics). get_index returns a catalog small enough to sit
// in one context window, so a client LLM can navigate without vector search.

import { getState, logOp, setState, withConn } from "./db.ts";
import { chat } from "./llm.ts";

export interface WikiPage {
  id: string;
  name: string;
  title: string;
  summary: string;
  content: string;
  kind: string;
  created_at: Date | string;
  updated_at: Date | string;
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
      `SELECT * FROM wiki_pages WHERE name = $1`, [slugify(name)],
    );
    return r.rows.length ? r.rows[0] : null;
  });
}

export async function writePage(
  page: { name: string; title: string; summary: string; content: string; kind: string },
  source: string,
): Promise<string> {
  const name = slugify(page.name);
  const id = await withConn(async (c) => {
    const r = await c.queryObject<{ id: string }>(
      `INSERT INTO wiki_pages (name, title, summary, content, kind)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name) DO UPDATE SET
         title = EXCLUDED.title, summary = EXCLUDED.summary,
         content = EXCLUDED.content, kind = EXCLUDED.kind
       RETURNING id`,
      [name, page.title, page.summary, page.content, page.kind],
    );
    return r.rows[0].id;
  });
  await logOp("wiki_write", source, name, { kind: page.kind });
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
       WHERE updated_at > $1::timestamptz
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
      const sources = cand.thoughts
        .slice(0, MAX_THOUGHTS_PER_PAGE)
        .map((t) => `- (${new Date(t.updated_at).toISOString().slice(0, 10)}) ${t.content}`)
        .join("\n");

      const prompt = `You maintain a personal knowledge wiki. ${
        existing
          ? `Update the existing page below by integrating the new notes. Preserve still-valid information, resolve contradictions in favor of newer notes, and keep it concise.`
          : `Create a new wiki page about "${cand.label}" from the notes below.`
      }
Use markdown. Link related concepts/people with [[wikilinks]] (kebab-case slugs). Do not invent facts not present in the notes${existing ? " or the existing page" : ""}.
${existing ? `\nExisting page:\n${existing.content}\n` : ""}
New notes:
${sources}

Reply with JSON only: {"title": string, "summary": string (one line, <120 chars), "content": string (the full markdown page)}`;

      const raw = await chat(prompt, { json: true });
      const parsed = JSON.parse(raw) as { title: string; summary: string; content: string };
      if (!parsed.content || !parsed.title) throw new Error("model returned incomplete page");

      await writePage(
        {
          name,
          title: parsed.title,
          summary: parsed.summary ?? "",
          content: parsed.content,
          kind: cand.kind,
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
    const r = await c.queryObject<Pick<WikiPage, "name" | "content" | "updated_at">>(
      `SELECT name, content, updated_at FROM wiki_pages`,
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
    pendingCount ? `\n## Backfill\n${pendingCount} thought(s) awaiting embedding (Node A offline?)` : "",
    `\nTip: run consolidate to fill gaps, or use read_page/write_page to fix issues manually. For semantic contradiction checks, read suspect pages and compare against recent thoughts.`,
  ].filter(Boolean).join("\n");
}
