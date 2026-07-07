// MCP tool registration.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PostgresError } from "deno-postgres";
import { cfg } from "./config.ts";
import { logOp, withConn } from "./db.ts";
import {
  browseRecent,
  captureThought,
  fingerprint,
  formatStats,
  getStats,
  searchThoughts,
  ThoughtRow,
  vecLiteral,
} from "./brain.ts";
import { extractMetadata, FALLBACK_META, getEmbedding } from "./llm.ts";
import { audit, consolidate, deletePage, getIndex, readPage, slugify, writePage } from "./wiki.ts";

function text(msg: string) {
  return { content: [{ type: "text" as const, text: msg }] };
}

function formatThought(r: ThoughtRow, i: number): string {
  const score = r.score !== undefined ? ` (score ${Number(r.score).toFixed(4)})` : "";
  const topics = (r.metadata?.topics ?? []).join(", ");
  const src = (r.metadata as Record<string, unknown>)?.source;
  return `${i + 1}. [${r.id}]${score}\n${r.content}\n` +
    `Topics: ${topics}${src ? ` | Source: ${src}` : ""} | ${new Date(r.created_at).toISOString()}`;
}

export function registerTools(server: McpServer): void {
  // ── Thoughts ────────────────────────────────────────────────────────────────

  server.tool(
    "capture_thought",
    "Save a thought, note, or document to OpenBrain memory. Large markdown documents are chunked automatically. If the inference node is offline the thought is stored anyway and embedded later.",
    {
      content: z.string().min(1).describe("Text to capture"),
      source: z.string().optional().describe("Where this came from (e.g. claude-desktop, claude-code)"),
    },
    async ({ content, source }) => {
      const r = await captureThought(content, source ?? "mcp");
      const notes = [
        r.chunks === 1 ? `Captured (id: ${r.ids[0]})` : `Captured ${r.chunks} chunks: ${r.ids.join(", ")}`,
        r.pendingEmbedding ? "Note: inference node unreachable — stored without embedding; the backfill worker will embed it automatically." : "",
        r.pendingMetadata ? "Note: metadata extraction deferred to the backfill worker." : "",
      ].filter(Boolean);
      return text(notes.join("\n"));
    },
  );

  server.tool(
    "search_thoughts",
    "Search memory with hybrid semantic + keyword search (Reciprocal Rank Fusion). Falls back to keyword-only search if the embedding service is down.",
    {
      query: z.string().min(1).describe("Search query"),
      limit: z.number().int().min(1).max(50).default(10).optional(),
    },
    async ({ query, limit = 10 }) => {
      const { results, mode } = await searchThoughts(query, limit);
      if (results.length === 0) return text("No results found.");
      const header = mode === "text-only" ? "(keyword-only search — embedding service unreachable)\n\n" : "";
      return text(header + results.map(formatThought).join("\n\n---\n\n"));
    },
  );

  server.tool(
    "browse_recent",
    "List recent thoughts in chronological order.",
    {
      limit: z.number().int().min(1).max(100).default(20).optional(),
      type: z.enum(["observation", "task", "idea", "reference", "person_note"]).optional(),
    },
    async ({ limit = 20, type }) => {
      const rows = await browseRecent(limit, type);
      if (rows.length === 0) return text("No thoughts yet.");
      return text(
        rows.map((r, i) =>
          `${i + 1}. [${r.id}] ${r.content.slice(0, 100)}${r.content.length > 100 ? "..." : ""}\n   ${new Date(r.created_at).toISOString()}`
        ).join("\n"),
      );
    },
  );

  server.tool(
    "brain_stats",
    "Counts and distributions across the OpenBrain knowledge base, including pending backfill work.",
    {},
    async () => text(formatStats(await getStats())),
  );

  server.tool(
    "update_thought",
    "Update a thought by ID. Changing the content triggers re-embedding and metadata re-extraction to prevent stale vectors.",
    {
      id: z.string().uuid().describe("Thought UUID"),
      content: z.string().optional().describe("New content — triggers re-embedding"),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Metadata fields to merge in"),
    },
    async ({ id, content, metadata }) => {
      return await withConn(async (conn) => {
        const check = await conn.queryObject(`SELECT id FROM thoughts WHERE id = $1`, [id]);
        if (check.rows.length === 0) return text(`Thought ${id} not found.`);

        if (content !== undefined) {
          const fp = await fingerprint(content);
          let embedding: number[] | null = null;
          try {
            embedding = await getEmbedding(content);
          } catch { /* stored as pending; backfill completes it */ }
          const extracted = (await extractMetadata(content)) ?? { ...FALLBACK_META, pending_metadata: true };
          const merged = { ...extracted, ...(metadata ?? {}) };
          try {
            await conn.queryObject(
              `UPDATE thoughts SET content=$1, embedding=$2::vector(768), metadata=$3::jsonb,
                      content_fingerprint=$4, embedding_model=$5 WHERE id=$6`,
              [content, embedding ? vecLiteral(embedding) : null, JSON.stringify(merged), fp,
               embedding ? cfg.embedModel : null, id],
            );
          } catch (e) {
            if (e instanceof PostgresError && e.fields.code === "23505") {
              return text(`Not updated: identical content already exists as another thought (fingerprint collision). Delete one of them instead.`);
            }
            throw e;
          }
          await logOp("update", "mcp", id, { content_changed: true, pending_embedding: !embedding });
          return text(`Updated thought ${id}${embedding ? "" : " (embedding deferred to backfill worker)"}`);
        }

        if (metadata !== undefined) {
          await conn.queryObject(
            `UPDATE thoughts SET metadata = metadata || $1::jsonb WHERE id = $2`,
            [JSON.stringify(metadata), id],
          );
          await logOp("update", "mcp", id, { content_changed: false });
          return text(`Updated metadata on thought ${id}`);
        }
        return text("Nothing to update — pass content and/or metadata.");
      });
    },
  );

  server.tool(
    "delete_thought",
    "Permanently delete a thought by ID.",
    { id: z.string().uuid().describe("Thought UUID") },
    async ({ id }) => {
      const deleted = await withConn(async (c) => {
        const r = await c.queryObject(`DELETE FROM thoughts WHERE id = $1 RETURNING id`, [id]);
        return r.rows.length > 0;
      });
      if (!deleted) return text(`Thought ${id} not found.`);
      await logOp("delete", "mcp", id);
      return text(`Deleted thought ${id}`);
    },
  );

  // ── Wiki (compiled knowledge layer) ─────────────────────────────────────────

  server.tool(
    "get_index",
    "Get the wiki index: every compiled knowledge page with a one-line summary, grouped by kind. Read this first to navigate the wiki without search.",
    {},
    async () => text(await getIndex()),
  );

  server.tool(
    "read_page",
    "Read a wiki page by name (kebab-case slug, as shown in [[wikilinks]] in the index).",
    { name: z.string().min(1).describe("Page slug, e.g. 'home-assistant' or a person's name") },
    async ({ name }) => {
      const p = await readPage(name);
      if (!p) return text(`No page named [[${slugify(name)}]]. Check get_index for available pages.`);
      return text(`# ${p.title}\n(kind: ${p.kind}, updated ${new Date(p.updated_at).toISOString()})\n\n${p.content}`);
    },
  );

  server.tool(
    "write_page",
    "Create or overwrite a wiki page. Use for filing synthesized knowledge back into the brain — good answers, entity profiles, concept overviews. Link related pages with [[wikilinks]].",
    {
      name: z.string().min(1).describe("Page slug (kebab-case)"),
      title: z.string().min(1),
      summary: z.string().describe("One line, <120 chars — shown in the index"),
      content: z.string().min(1).describe("Full markdown page body"),
      kind: z.enum(["concept", "entity", "summary", "synthesis", "overview"]).default("synthesis").optional(),
    },
    async ({ name, title, summary, content, kind = "synthesis" }) => {
      await writePage({ name, title, summary, content, kind }, "mcp");
      return text(`Wrote page [[${slugify(name)}]]`);
    },
  );

  server.tool(
    "delete_page",
    "Delete a wiki page by name.",
    { name: z.string().min(1) },
    async ({ name }) => {
      const ok = await deletePage(name, "mcp");
      return text(ok ? `Deleted page [[${slugify(name)}]]` : `No page named [[${slugify(name)}]].`);
    },
  );

  server.tool(
    "consolidate_brain",
    "Run one consolidation pass: reads thoughts captured since the last run and updates the wiki pages for the most-mentioned people and topics. Bounded per run — safe to call repeatedly.",
    {},
    async () => text(await consolidate("mcp")),
  );

  server.tool(
    "brain_audit",
    "Structural health check of the wiki: orphan pages, broken wikilinks, stale pages, frequently-mentioned topics with no page, pending backfill work.",
    {},
    async () => text(await audit()),
  );

  // ── Export ──────────────────────────────────────────────────────────────────

  server.tool(
    "export_brain",
    "Export all thoughts and wiki pages as plain markdown files to the Home Assistant /share folder (data sovereignty escape hatch, works as an offline backup).",
    {},
    async () => {
      const dir = cfg.exportDir;
      await Deno.mkdir(`${dir}/thoughts`, { recursive: true });
      await Deno.mkdir(`${dir}/wiki`, { recursive: true });

      const { thoughts, pages } = await withConn(async (c) => {
        const t = await c.queryObject<ThoughtRow>(
          `SELECT id, content, metadata, created_at FROM thoughts ORDER BY created_at ASC`,
        );
        const p = await c.queryObject<{ name: string; title: string; summary: string; content: string; kind: string }>(
          `SELECT name, title, summary, content, kind FROM wiki_pages ORDER BY name`,
        );
        return { thoughts: t.rows, pages: p.rows };
      });

      // Thoughts grouped into one file per month.
      const byMonth = new Map<string, ThoughtRow[]>();
      for (const t of thoughts) {
        const key = new Date(t.created_at).toISOString().slice(0, 7);
        if (!byMonth.has(key)) byMonth.set(key, []);
        byMonth.get(key)!.push(t);
      }
      for (const [month, rows] of byMonth) {
        const body = rows.map((t) => {
          const meta = t.metadata as Record<string, unknown>;
          return `## ${new Date(t.created_at).toISOString()}\n` +
            `<!-- id: ${t.id} | type: ${meta.type ?? "?"} | topics: ${(t.metadata?.topics ?? []).join(", ")} -->\n\n` +
            `${t.content}\n`;
        }).join("\n---\n\n");
        await Deno.writeTextFile(`${dir}/thoughts/${month}.md`, `# Thoughts — ${month}\n\n${body}`);
      }

      for (const p of pages) {
        await Deno.writeTextFile(
          `${dir}/wiki/${p.name}.md`,
          `# ${p.title}\n<!-- kind: ${p.kind} -->\n> ${p.summary}\n\n${p.content}\n`,
        );
      }

      const index = [
        `# OpenBrain export — ${new Date().toISOString()}`,
        `\n${thoughts.length} thoughts in ${byMonth.size} monthly file(s); ${pages.length} wiki page(s).`,
        `\n## Wiki\n${pages.map((p) => `- [${p.title}](wiki/${p.name}.md) — ${p.summary}`).join("\n")}`,
      ].join("\n");
      await Deno.writeTextFile(`${dir}/index.md`, index);

      await logOp("export", "mcp", dir, { thoughts: thoughts.length, pages: pages.length });
      return text(`Exported ${thoughts.length} thoughts and ${pages.length} wiki pages to ${dir} (visible in Home Assistant's /share folder).`);
    },
  );
}
