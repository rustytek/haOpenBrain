// Core brain operations, shared by the MCP tools, the Telegram bot, the jobs
// endpoints, and the ingress dashboard.

import { cfg } from "./config.ts";
import { logOp, withConn } from "./db.ts";
import { chunkMarkdown, embedText } from "./chunk.ts";
import { extractMetadata, FALLBACK_META, getEmbedding, getEmbeddings, ThoughtMetadata } from "./llm.ts";

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
    embeddings = await getEmbeddings(chunks.map(embedText));
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
          emb ? cfg.embedModel : null,
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
// RRF hybrid via SQL; degrades to text-only when the embedding service is down.

export interface SearchResult {
  results: ThoughtRow[];
  mode: "hybrid" | "text-only";
}

export async function searchThoughts(query: string, limit = 10): Promise<SearchResult> {
  let embedding: number[] | null = null;
  try {
    embedding = await getEmbedding(query);
  } catch (e) {
    console.log(`WARN: query embedding failed, text-only search: ${(e as Error).message}`);
  }

  return await withConn(async (c) => {
    if (embedding) {
      const r = await c.queryObject<ThoughtRow>(
        `SELECT id, content, metadata, score, created_at
         FROM hybrid_search($1::vector(768), $2, $3)`,
        [vecLiteral(embedding), query, limit],
      );
      return { results: r.rows, mode: "hybrid" as const };
    }
    const r = await c.queryObject<ThoughtRow>(
      `SELECT id, content, metadata, rank::float8 AS score, created_at
       FROM search_thoughts_text($1, $2)`,
      [query, limit],
    );
    return { results: r.rows, mode: "text-only" as const };
  });
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
    `Total thoughts: ${s.total}`,
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
