import { McpServer } from "npm:@modelcontextprotocol/sdk@1.24.3/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { Pool } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

// ── Config ────────────────────────────────────────────────────────────────────

const LITELLM_URL    = Deno.env.get("LITELLM_URL")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;
const PORT           = parseInt(Deno.env.get("PORT") || "8000");
const EMBED_MODEL    = "nomic-embed-text";
const CHAT_MODEL     = Deno.env.get("METADATA_MODEL") || "deepseek-r1:8b";

// ── Database pool ─────────────────────────────────────────────────────────────

const pool = new Pool(
  {
    hostname: Deno.env.get("POSTGRES_HOST")!,
    port:     parseInt(Deno.env.get("POSTGRES_PORT") || "5432"),
    database: Deno.env.get("POSTGRES_DB")!,
    user:     Deno.env.get("POSTGRES_USER")!,
    password: Deno.env.get("POSTGRES_PASSWORD")!,
  },
  20,
  true, // lazy connections
);

// ── LiteLLM helpers ───────────────────────────────────────────────────────────

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch(`${LITELLM_URL}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.data[0].embedding as number[];
}

interface ThoughtMetadata {
  people: string[];
  action_items: string[];
  dates_mentioned: string[];
  topics: string[];
  type: "observation" | "task" | "idea" | "reference" | "person_note";
}

const FALLBACK_META: ThoughtMetadata = {
  people: [], action_items: [], dates_mentioned: [],
  topics: ["uncategorized"], type: "observation",
};

async function extractMetadata(text: string): Promise<ThoughtMetadata> {
  const res = await fetch(`${LITELLM_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CHAT_MODEL,
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content:
          `Extract metadata from the text below. Reply with JSON only.\n` +
          `Fields: people (string[]), action_items (string[]), dates_mentioned (string[] as YYYY-MM-DD), ` +
          `topics (1–3 short tags, string[]), type (one of: observation|task|idea|reference|person_note).\n\n` +
          `Text:\n${text}`,
      }],
    }),
  });
  if (!res.ok) return FALLBACK_META;
  try {
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content) as ThoughtMetadata;
  } catch {
    return FALLBACK_META;
  }
}

// ── SHA-256 fingerprint ───────────────────────────────────────────────────────

async function fingerprint(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text.trim().toLowerCase()),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Markdown-aware chunking ───────────────────────────────────────────────────

function chunkMarkdown(text: string, maxLen = 1800): string[] {
  if (text.length <= maxLen) return [text.trim()];
  const sections = text.split(/(?=^#{1,3} )/m);
  return sections
    .flatMap((s) =>
      s.length <= maxLen
        ? [s.trim()]
        : s.split(/\n\n+/).map((p) => p.trim()).filter((p) => p.length > 40)
    )
    .filter(Boolean);
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "openBrain", version: "1.0.0" });

// capture_thought ──────────────────────────────────────────────────────────────
server.tool(
  "capture_thought",
  "Save a thought, note, or document to OpenBrain memory. Large markdown documents are chunked automatically.",
  { content: z.string().describe("Text to capture") },
  async ({ content }) => {
    const chunks = chunkMarkdown(content);
    const ids: string[] = [];

    for (const chunk of chunks) {
      const [fp, embedding, metadata] = await Promise.all([
        fingerprint(chunk),
        getEmbedding(chunk),
        extractMetadata(chunk),
      ]);
      const embVec = `[${embedding.join(",")}]`;
      const conn = await pool.connect();
      try {
        const result = await conn.queryObject<{ id: string }>(
          `SELECT (upsert_thought($1::text, $2::vector(768), $3::jsonb, $4::text)).id`,
          [chunk, embVec, JSON.stringify(metadata), fp],
        );
        ids.push(result.rows[0].id);
      } finally {
        conn.release();
      }
    }

    const msg = chunks.length === 1
      ? `Captured (id: ${ids[0]})`
      : `Captured ${chunks.length} chunks: ${ids.join(", ")}`;
    return { content: [{ type: "text", text: msg }] };
  },
);

// search_thoughts ─────────────────────────────────────────────────────────────
server.tool(
  "search_thoughts",
  "Search memory using hybrid semantic + keyword search. Returns the most relevant results.",
  {
    query:     z.string().describe("Search query"),
    limit:     z.number().int().min(1).max(50).default(10).optional(),
    threshold: z.number().min(0).max(1).default(0.5).optional(),
  },
  async ({ query, limit = 10, threshold = 0.5 }) => {
    const embedding = await getEmbedding(query);
    const embVec = `[${embedding.join(",")}]`;

    const conn = await pool.connect();
    try {
      const [vecResult, txtResult] = await Promise.all([
        conn.queryObject<{ id: string; content: string; metadata: ThoughtMetadata; created_at: string }>(
          `SELECT id, content, metadata, created_at FROM match_thoughts($1::vector(768), $2, $3)`,
          [embVec, threshold, limit],
        ),
        conn.queryObject<{ id: string; content: string; metadata: ThoughtMetadata; created_at: string }>(
          `SELECT id, content, metadata, created_at FROM search_thoughts_text($1, $2)`,
          [query, limit],
        ),
      ]);

      const seen = new Set<string>();
      const merged = [...vecResult.rows, ...txtResult.rows]
        .filter((r) => { if (seen.has(r.id)) return false; seen.add(r.id); return true; })
        .slice(0, limit);

      if (merged.length === 0) return { content: [{ type: "text", text: "No results found." }] };

      const text = merged
        .map((r, i) =>
          `${i + 1}. [${r.id}]\n${r.content}\nTopics: ${(r.metadata?.topics ?? []).join(", ")}\n${new Date(r.created_at).toISOString()}`
        )
        .join("\n\n---\n\n");

      return { content: [{ type: "text", text }] };
    } finally {
      conn.release();
    }
  },
);

// browse_recent ───────────────────────────────────────────────────────────────
server.tool(
  "browse_recent",
  "List recent thoughts in chronological order.",
  {
    limit: z.number().int().min(1).max(100).default(20).optional(),
    type:  z.enum(["observation", "task", "idea", "reference", "person_note"]).optional(),
  },
  async ({ limit = 20, type }) => {
    const conn = await pool.connect();
    try {
      const result = type
        ? await conn.queryObject<{ id: string; content: string; created_at: string }>(
            `SELECT id, content, created_at FROM thoughts WHERE metadata->>'type' = $1 ORDER BY created_at DESC LIMIT $2`,
            [type, limit],
          )
        : await conn.queryObject<{ id: string; content: string; created_at: string }>(
            `SELECT id, content, created_at FROM thoughts ORDER BY created_at DESC LIMIT $1`,
            [limit],
          );

      if (result.rows.length === 0) return { content: [{ type: "text", text: "No thoughts yet." }] };

      const text = result.rows
        .map((r, i) =>
          `${i + 1}. [${r.id}] ${r.content.slice(0, 100)}${r.content.length > 100 ? "..." : ""}\n   ${new Date(r.created_at).toISOString()}`
        )
        .join("\n");

      return { content: [{ type: "text", text }] };
    } finally {
      conn.release();
    }
  },
);

// brain_stats ─────────────────────────────────────────────────────────────────
server.tool(
  "brain_stats",
  "Get counts and distributions across the OpenBrain knowledge base.",
  {},
  async () => {
    const conn = await pool.connect();
    try {
      const [totals, byType, topTopics, topPeople] = await Promise.all([
        conn.queryObject<{ total: number }>(`SELECT COUNT(*)::int AS total FROM thoughts`),
        conn.queryObject<{ type: string; n: number }>(
          `SELECT metadata->>'type' AS type, COUNT(*)::int AS n FROM thoughts GROUP BY metadata->>'type' ORDER BY n DESC`,
        ),
        conn.queryObject<{ topic: string; n: number }>(
          `SELECT t.topic, COUNT(*)::int AS n FROM thoughts, jsonb_array_elements_text(metadata->'topics') AS t(topic) GROUP BY t.topic ORDER BY n DESC LIMIT 10`,
        ),
        conn.queryObject<{ person: string; n: number }>(
          `SELECT p.person, COUNT(*)::int AS n FROM thoughts, jsonb_array_elements_text(metadata->'people') AS p(person) GROUP BY p.person ORDER BY n DESC LIMIT 10`,
        ),
      ]);

      const lines = [
        `Total thoughts: ${totals.rows[0].total}`,
        `\nBy type:\n${byType.rows.map((r) => `  ${r.type ?? "unknown"}: ${r.n}`).join("\n")}`,
        `\nTop topics:\n${topTopics.rows.map((r) => `  ${r.topic}: ${r.n}`).join("\n")}`,
        `\nTop people:\n${topPeople.rows.map((r) => `  ${r.person}: ${r.n}`).join("\n")}`,
      ].join("");

      return { content: [{ type: "text", text: lines }] };
    } finally {
      conn.release();
    }
  },
);

// update_thought ──────────────────────────────────────────────────────────────
server.tool(
  "update_thought",
  "Update a thought by ID. Changing the content field triggers re-embedding and metadata re-extraction to prevent stale vectors.",
  {
    id:       z.string().uuid().describe("Thought UUID"),
    content:  z.string().optional().describe("New content — triggers re-embedding"),
    metadata: z.record(z.unknown()).optional().describe("Metadata fields to merge in"),
  },
  async ({ id, content, metadata }) => {
    const conn = await pool.connect();
    try {
      const check = await conn.queryObject(`SELECT id FROM thoughts WHERE id = $1`, [id]);
      if (check.rows.length === 0) throw new Error(`Thought ${id} not found`);

      if (content !== undefined) {
        const [fp, embedding, extracted] = await Promise.all([
          fingerprint(content),
          getEmbedding(content),
          extractMetadata(content),
        ]);
        const merged = { ...extracted, ...(metadata ?? {}) };
        const embVec = `[${embedding.join(",")}]`;
        await conn.queryObject(
          `UPDATE thoughts SET content=$1, embedding=$2::vector(768), metadata=$3::jsonb, content_fingerprint=$4, updated_at=now() WHERE id=$5`,
          [content, embVec, JSON.stringify(merged), fp, id],
        );
      } else if (metadata !== undefined) {
        await conn.queryObject(
          `UPDATE thoughts SET metadata = metadata || $1::jsonb, updated_at = now() WHERE id = $2`,
          [JSON.stringify(metadata), id],
        );
      }

      return { content: [{ type: "text", text: `Updated thought ${id}` }] };
    } finally {
      conn.release();
    }
  },
);

// delete_thought ──────────────────────────────────────────────────────────────
server.tool(
  "delete_thought",
  "Permanently delete a thought by ID.",
  { id: z.string().uuid().describe("Thought UUID") },
  async ({ id }) => {
    const conn = await pool.connect();
    try {
      const result = await conn.queryObject(`DELETE FROM thoughts WHERE id = $1 RETURNING id`, [id]);
      if (result.rows.length === 0) throw new Error(`Thought ${id} not found`);
      return { content: [{ type: "text", text: `Deleted thought ${id}` }] };
    } finally {
      conn.release();
    }
  },
);

// ── HTTP layer ────────────────────────────────────────────────────────────────

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok" }));

app.all("/mcp", async (c) => {
  const key = c.req.header("x-brain-key") ?? c.req.query("key");
  if (key !== MCP_ACCESS_KEY) return c.text("Unauthorized", 401);

  // handleRequest expects a Hono Context. For clients (e.g. Claude Desktop)
  // that omit the Accept header required by StreamableHTTPTransport, patch
  // c.req.raw with a new Request that includes it.
  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const body = await c.req.text();
    // deno-lint-ignore no-explicit-any
    (c.req as any).raw = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: body || null,
    });
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve({ port: PORT }, app.fetch);
console.log(`openBrain MCP listening on :${PORT}`);
