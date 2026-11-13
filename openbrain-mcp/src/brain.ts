// Core brain operations, shared by the MCP tools, the Telegram bot, the jobs
// endpoints, and the ingress dashboard.

import { EMBED_STAMP } from "./config.ts";
import { logOp, withConn } from "./db.ts";
import { chunkMarkdown, embedText } from "./chunk.ts";
import { embedDocs, embedQuery, extractMetadata, FALLBACK_META, ThoughtMetadata } from "./llm.ts";

export interface ThoughtRow {
  id: string;
  content: string;
  metadata: ThoughtMetadata;
  created_at: Date | string;
  score?: number;
}

export function vecLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export async function fingerprint(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text.trim().toLowerCase()),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Capture (offline-tolerant) ────────────────────────────────────────────────
// If Node A is unreachable the thought is stored with a NULL embedding and
// fallback metadata; the backfill worker completes it later. Capture never
// loses data because inference is down.

export interface CaptureResult {
  ids: string[];
  chunks: number;
  pendingEmbedding: boolean;
  pendingMetadata: boolean;
}

export async function captureThought(content: string, source: string): Promise<CaptureResult> {
  const chunks = chunkMarkdown(content);
  const docFp = chunks.length > 1 ? await fingerprint(content) : null;

  let embeddings: (number[] | null)[];
  try {
    embeddings = await embedDocs(chunks.map(embedText));
  } catch (e) {
    console.log(`WARN: embedding unavailable, capturing as pending: ${(e as Error).message}`);
    embeddings = chunks.map(() => null);
  }

  const metadatas = await Promise.all(chunks.map((c) => extractMetadata(c.text)));

  const ids: string[] = [];
  let pendingMetadata = false;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const emb = embeddings[i];
    const meta = metadatas[i];
    if (meta === null) pendingMetadata = true;

    const fullMeta: Record<string, unknown> = {
      ...(meta ?? FALLBACK_META),
      source,
      ...(meta === null ? { pending_metadata: true } : {}),
      ...(chunk.context ? { embed_context: chunk.context } : {}),
      ...(docFp ? { doc_fingerprint: docFp, chunk_index: i, chunk_count: chunks.length } : {}),
    };

    const fp = await fingerprint(chunk.text);
    const id = await withConn(async (c) => {
      const r = await c.queryObject<{ id: string }>(
        `SELECT (upsert_thought($1::text, $2::vector(768), $3::jsonb, $4::text, $5::text)).id`,
        [
          chunk.text,
          emb ? vecLiteral(emb) : null,
          JSON.stringify(fullMeta),
          fp,
          emb ? EMBED_STAMP : null,
        ],
      );
      return r.rows[0].id;
    });
    ids.push(id);
  }

  const pendingEmbedding = embeddings.some((e) => e === null);
  await logOp("capture", source, ids.join(","), {
    chunks: chunks.length,
    pending_embedding: pendingEmbedding,
    pending_metadata: pendingMetadata,
  });

  return { ids, chunks: chunks.length, pendingEmbedding, pendingMetadata };
}

// ── Search ────────────────────────────────────────────────────────────────────
// One ranked list over thoughts AND wiki pages (SQL brain_search: RRF of vector
// and keyword ranks, with metadata filters). Degrades to keyword-only when the
// embedding service is down. Superseded thoughts are left out by default.

export interface SearchOpts {
  limit?: number;
  types?: string[];          // observation | task | idea | reference | person_note
  people?: string[];         // case-insensitive substring match on metadata.people
  topics?: string[];         // same, on metadata.topics
  source?: string;           // exact metadata.source
  since?: string;            // ISO date/time: created (pages: updated) on or after
  until?: string;            // ISO date/time: on or before
  includeSuperseded?: boolean;
  includePages?: boolean;    // default true
}

export interface SearchHit {
  kind: "thought" | "page";
  id: string;
  ref: string;               // thought UUID, or page slug
  title: string | null;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
  created_at: Date | string;
  superseded_by: string | null;
}

export interface SearchOutcome {
  hits: SearchHit[];
  mode: "hybrid" | "text-only";
}

function toTimestamp(v: string | undefined, name: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) throw new Error(`${name} is not a date: "${v}" (use YYYY-MM-DD)`);
  return d.toISOString();
}

const arr = (a?: string[]) => (a && a.length ? a : null);

export async function search(query: string, opts: SearchOpts = {}): Promise<SearchOutcome> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const since = toTimestamp(opts.since, "since");
  const until = toTimestamp(opts.until, "until");

  let embedding: number[] | null = null;
  try {
    embedding = await embedQuery(query);
  } catch (e) {
    console.log(`WARN: query embedding failed, text-only search: ${(e as Error).message}`);
  }

  const hits = await withConn(async (c) => {
    const r = await c.queryObject<SearchHit>(
      `SELECT kind, id, ref, title, content, metadata, score, created_at, superseded_by
       FROM brain_search($1::vector(768), $2, $3, $4::text[], $5::text[], $6::text[], $7,
                         $8::timestamptz, $9::timestamptz, $10, $11)`,
      [
        embedding ? vecLiteral(embedding) : null,
        query,
        limit,
        arr(opts.types),
        arr(opts.people),
        arr(opts.topics),
        opts.source ?? null,
        since,
        until,
        opts.includeSuperseded ?? false,
        opts.includePages ?? true,
      ],
    );
    // float8 arrives as a string from the driver; callers and JSON clients want a number.
    return r.rows.map((h) => ({ ...h, score: Number(h.score) }));
  });
  // A reranking stage would go here: fetch a wider candidate list above, rescore
  // (query, hit.content) pairs with a cross-encoder, then cut to `limit`.
  return { hits, mode: embedding ? "hybrid" : "text-only" };
}

export interface SearchResult {
  results: ThoughtRow[];
  mode: "hybrid" | "text-only";
}

// Thoughts only, in the old shape. Used by the dashboard and the Telegram bot.
export async function searchThoughts(query: string, limit = 10): Promise<SearchResult> {
  const { hits, mode } = await search(query, { limit, includePages: false });
  return {
    mode,
    results: hits.map((h) => ({
      id: h.id,
      content: h.content,
      metadata: h.metadata as ThoughtMetadata,
      created_at: h.created_at,
      score: h.score,
    })),
  };
}

const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + " …" : s);

export function formatHit(h: SearchHit, i: number): string {
  if (h.kind === "page") {
    return `${i + 1}. WIKI PAGE [[${h.ref}]] — ${h.title} (updated ${day(h.created_at)}, score ${Number(h.score).toFixed(4)})\n` +
      `${(h.metadata.summary as string) || ""}\n${clip(h.content, 600)}`;
  }
  const topics = ((h.metadata.topics as string[]) ?? []).join(", ");
  const src = h.metadata.source;
  return `${i + 1}. [${h.id}] (score ${Number(h.score).toFixed(4)})${h.superseded_by ? ` SUPERSEDED by ${h.superseded_by}` : ""}\n` +
    `${h.content}\nTopics: ${topics}${src ? ` | Source: ${src}` : ""} | ${new Date(h.created_at).toISOString()}`;
}

// ── Recall ────────────────────────────────────────────────────────────────────
// One call that does what a capable client does in three (index → pages →
// search) and returns a compact, cited bundle. Meant for small local models,
// which handle one simple tool far better than a choice of many. No LLM runs
// here: it is retrieval and formatting only.

export async function recall(question: string, opts: SearchOpts = {}): Promise<string> {
  const { hits, mode } = await search(question, { ...opts, limit: 10 });
  if (hits.length === 0) {
    return `Nothing in memory matches "${question}". Do not guess: tell the user the brain has nothing on this.`;
  }
  const pages = hits.filter((h) => h.kind === "page").slice(0, 2);
  const thoughts = hits.filter((h) => h.kind === "thought").slice(0, 6);
  const out: string[] = [`Memory for: ${question}`];
  if (mode === "text-only") out.push("(keyword match only: the embedding service is unreachable, so results may be thin)");
  if (pages.length) {
    out.push("\n## Compiled wiki pages (the current summary; prefer these)");
    for (const p of pages) {
      out.push(`### [[${p.ref}]] ${p.title} (updated ${day(p.created_at)})\n${clip(p.content, 1500)}`);
    }
  }
  if (thoughts.length) {
    out.push("\n## Notes (most relevant first; when two disagree, the later date wins)");
    for (const t of thoughts) {
      out.push(`- ${day(t.created_at)} [${t.id}] ${clip(t.content.replace(/\s+/g, " "), 500)}`);
    }
  }
  out.push("\nAnswer only from the text above and say which page or note date it came from. If it does not answer the question, say so.");
  return out.join("\n");
}

// ── Supersession ──────────────────────────────────────────────────────────────
// An outdated thought is kept and pointed at its replacement; it drops out of
// default search but stays readable (include_superseded) and restorable.

export async function supersedeThought(olderId: string, newerId: string, note: string, source: string): Promise<string> {
  if (olderId === newerId) return "A thought cannot supersede itself.";
  return await withConn(async (c) => {
    const r = await c.queryObject<{ id: string; superseded_by: string | null }>(
      `SELECT id, superseded_by FROM thoughts WHERE id = ANY($1::uuid[])`, [[olderId, newerId]],
    );
    if (r.rows.length < 2) return "Not done: one of the two thought ids does not exist.";
    if (r.rows.find((x) => x.id === newerId)?.superseded_by === olderId) {
      return "Not done: that would make the two thoughts supersede each other.";
    }
    await c.queryObject(
      `UPDATE thoughts SET superseded_by = $2, superseded_at = now(), superseded_note = $3 WHERE id = $1`,
      [olderId, newerId, note],
    );
    await logOp("supersede", source, olderId, { superseded_by: newerId, note });
    return `Marked ${olderId} as superseded by ${newerId}. It no longer appears in default search; restore_thought undoes this.`;
  });
}

export async function restoreThought(id: string, source: string): Promise<string> {
  const ok = await withConn(async (c) => {
    const r = await c.queryObject(
      `UPDATE thoughts SET superseded_by = NULL, superseded_at = NULL, superseded_note = NULL
       WHERE id = $1 AND superseded_by IS NOT NULL RETURNING id`,
      [id],
    );
    return r.rows.length > 0;
  });
  if (!ok) return `Thought ${id} is not superseded (or does not exist).`;
  await logOp("restore", source, id);
  return `Restored ${id}: it is current again.`;
}

export async function browseRecent(limit = 20, type?: string): Promise<ThoughtRow[]> {
  return await withConn(async (c) => {
    const r = type
      ? await c.queryObject<ThoughtRow>(
        `SELECT id, content, metadata, created_at FROM thoughts
         WHERE metadata->>'type' = $1 ORDER BY created_at DESC LIMIT $2`,
        [type, limit],
      )
      : await c.queryObject<ThoughtRow>(
        `SELECT id, content, metadata, created_at FROM thoughts
         ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
    return r.rows;
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export interface BrainStats {
  total: number;
  superseded: number;
  pending_conflicts: number;
  pending_embeddings: number;
  wiki_pages: number;
  last_capture: string | null;
  by_type: { type: string | null; n: number }[];
  by_source: { source: string | null; n: number }[];
  top_topics: { topic: string; n: number }[];
  top_people: { person: string; n: number }[];
  embedding_models: { model: string | null; n: number }[];
}

export async function getStats(): Promise<BrainStats> {
  return await withConn(async (c) => {
    const sup = await c.queryObject<{ n: number }>(`SELECT COUNT(*)::int AS n FROM thoughts WHERE superseded_by IS NOT NULL`);
    const conf = await c.queryObject<{ n: number }>(`SELECT COUNT(*)::int AS n FROM thought_conflicts WHERE status = 'pending'`);
    const [totals, pending, wiki, last, byType, bySource, topTopics, topPeople, models] =
      await Promise.all([
        c.queryObject<{ n: number }>(`SELECT COUNT(*)::int AS n FROM thoughts`),
        c.queryObject<{ n: number }>(`SELECT COUNT(*)::int AS n FROM thoughts WHERE embedding IS NULL`),
        c.queryObject<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wiki_pages`),
        c.queryObject<{ ts: Date | null }>(`SELECT MAX(created_at) AS ts FROM thoughts`),
        c.queryObject<{ type: string | null; n: number }>(
          `SELECT metadata->>'type' AS type, COUNT(*)::int AS n FROM thoughts
           GROUP BY 1 ORDER BY n DESC`,
        ),
        c.queryObject<{ source: string | null; n: number }>(
          `SELECT metadata->>'source' AS source, COUNT(*)::int AS n FROM thoughts
           GROUP BY 1 ORDER BY n DESC`,
        ),
        c.queryObject<{ topic: string; n: number }>(
          `SELECT t.topic, COUNT(*)::int AS n
           FROM thoughts, jsonb_array_elements_text(metadata->'topics') AS t(topic)
           GROUP BY t.topic ORDER BY n DESC LIMIT 10`,
        ),
        c.queryObject<{ person: string; n: number }>(
          `SELECT p.person, COUNT(*)::int AS n
           FROM thoughts, jsonb_array_elements_text(metadata->'people') AS p(person)
           GROUP BY p.person ORDER BY n DESC LIMIT 10`,
        ),
        c.queryObject<{ model: string | null; n: number }>(
          `SELECT embedding_model AS model, COUNT(*)::int AS n FROM thoughts
           GROUP BY 1 ORDER BY n DESC`,
        ),
      ]);
    return {
      total: totals.rows[0].n,
      superseded: sup.rows[0].n,
      pending_conflicts: conf.rows[0].n,
      pending_embeddings: pending.rows[0].n,
      wiki_pages: wiki.rows[0].n,
      last_capture: last.rows[0].ts ? new Date(last.rows[0].ts).toISOString() : null,
      by_type: byType.rows,
      by_source: bySource.rows,
      top_topics: topTopics.rows,
      top_people: topPeople.rows,
      embedding_models: models.rows,
    };
  });
}

export function formatStats(s: BrainStats): string {
  const fmt = (rows: { n: number }[], key: string) =>
    rows.map((r) => `  ${(r as Record<string, unknown>)[key] ?? "unknown"}: ${r.n}`).join("\n");
  return [
    `Total thoughts: ${s.total} (${s.superseded} superseded)`,
    `Possible outdated facts awaiting review: ${s.pending_conflicts}`,
    `Wiki pages: ${s.wiki_pages}`,
    `Pending embeddings: ${s.pending_embeddings}`,
    `Last capture: ${s.last_capture ?? "never"}`,
    `\nBy type:\n${fmt(s.by_type, "type")}`,
    `\nBy source:\n${fmt(s.by_source, "source")}`,
    `\nTop topics:\n${fmt(s.top_topics, "topic")}`,
    `\nTop people:\n${fmt(s.top_people, "person")}`,
    `\nEmbedding models:\n${fmt(s.embedding_models, "model")}`,
  ].join("\n");
}
