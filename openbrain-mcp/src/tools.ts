// MCP tool registration.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PostgresError } from "deno-postgres";
import { cfg, EMBED_STAMP } from "./config.ts";
import { logOp, withConn } from "./db.ts";
import {
  browseRecent,
  captureThought,
  fingerprint,
  formatHit,
  formatStats,
  getStats,
  recall,
  restoreThought,
  search,
  supersedeThought,
  ThoughtRow,
  vecLiteral,
} from "./brain.ts";
import { embedDocs, extractMetadata, FALLBACK_META } from "./llm.ts";
import { audit, consolidate, deletePage, formatProvenance, getIndex, pageProvenance, readPage, slugify, writePage } from "./wiki.ts";
import { findConflicts, formatConflicts, listConflicts, resolveConflict } from "./conflicts.ts";
import { addEvalCase, deleteEvalCase, formatEval, listEvalCases, runEval } from "./evals.ts";

// Two tool sets over the same brain:
//   full: everything (/mcp), for capable clients.
//   lite: a handful of simple tools (/mcp?profile=lite), for small local models,
//         which pick the right tool far more reliably from seven than from twenty.
export type Profile = "full" | "lite";
const LITE_TOOLS = new Set([
  "recall",
  "capture_thought",
  "read_page",
  "write_page",
  "review_conflicts",
  "resolve_conflict",
  "add_eval_case",
]);

function text(msg: string) {
  return { content: [{ type: "text" as const, text: msg }] };
}

export function registerTools(mcp: McpServer, profile: Profile = "full"): void {
  // Same signature as mcp.tool; skips tools outside the lite set for that profile.
  const server = {
    // deno-lint-ignore no-explicit-any
    tool: (name: string, ...rest: any[]) => {
      if (profile === "lite" && !LITE_TOOLS.has(name)) return;
      // deno-lint-ignore no-explicit-any
      (mcp.tool as any)(name, ...rest);
    },
  };

  // ── Recall (one-call retrieval) ─────────────────────────────────────────────

  server.tool(
    "recall",
    "Look something up in the user's memory. Give it a plain question; it returns the relevant wiki pages and notes, already selected and dated. Use this first for any question about the user's projects, people, plans or past decisions.",
    {
      question: z.string().min(1).describe("What you want to know, in plain words"),
      since: z.string().optional().describe("Only memories on or after this date (YYYY-MM-DD)"),
      person: z.string().optional().describe("Only notes mentioning this person"),
    },
    async ({ question, since, person }: { question: string; since?: string; person?: string }) =>
      text(await recall(question, { since, people: person ? [person] : undefined })),
  );

  // ── Thoughts ────────────────────────────────────────────────────────────────

  server.tool(
    "capture_thought",
    "Save a thought, note, or document to OpenBrain memory. Large markdown documents are chunked automatically. If the inference node is offline the thought is stored anyway and embedded later.",
    {
      content: z.string().min(1).describe("Text to capture"),
      source: z.string().optional().describe("Where this came from (e.g. claude-desktop, claude-code)"),
    },
    async ({ content, source }: { content: string; source?: string }) => {
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
    "Search memory: thoughts and compiled wiki pages in one ranked list (semantic + keyword, Reciprocal Rank Fusion), with optional filters. Outdated (superseded) thoughts are left out unless include_superseded is set. Falls back to keyword-only search if the embedding service is down.",
    {
      query: z.string().min(1).describe("Search query"),
      limit: z.number().int().min(1).max(50).default(10).optional(),
      type: z.enum(["observation", "task", "idea", "reference", "person_note"]).optional()
        .describe("Only thoughts of this type"),
      person: z.string().optional().describe("Only thoughts mentioning this person (case-insensitive, partial match)"),
      topic: z.string().optional().describe("Only thoughts tagged with this topic (case-insensitive, partial match)"),
      source: z.string().optional().describe("Only thoughts captured from this source, e.g. telegram"),
      since: z.string().optional().describe("On or after this date (YYYY-MM-DD)"),
      until: z.string().optional().describe("On or before this date (YYYY-MM-DD)"),
      include_superseded: z.boolean().default(false).optional().describe("Also return thoughts marked outdated"),
      include_pages: z.boolean().default(true).optional().describe("Also return wiki pages (ignored when a type/person/topic/source filter is set)"),
    },
    async (a: {
      query: string; limit?: number; type?: string; person?: string; topic?: string; source?: string;
      since?: string; until?: string; include_superseded?: boolean; include_pages?: boolean;
    }) => {
      let out;
      try {
        out = await search(a.query, {
          limit: a.limit ?? 10,
          types: a.type ? [a.type] : undefined,
          people: a.person ? [a.person] : undefined,
          topics: a.topic ? [a.topic] : undefined,
          source: a.source,
          since: a.since,
          until: a.until,
          includeSuperseded: a.include_superseded,
          includePages: a.include_pages,
        });
      } catch (e) {
        return text(`Search not run: ${(e as Error).message}`);
      }
      if (out.hits.length === 0) return text("No results found.");
      const header = out.mode === "text-only" ? "(keyword-only search — embedding service unreachable)\n\n" : "";
      return text(header + out.hits.map(formatHit).join("\n\n---\n\n"));
    },
  );

  server.tool(
    "browse_recent",
    "List recent thoughts in chronological order.",
    {
      limit: z.number().int().min(1).max(100).default(20).optional(),
      type: z.enum(["observation", "task", "idea", "reference", "person_note"]).optional(),
    },
    async ({ limit = 20, type }: { limit?: number; type?: string }) => {
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
    async ({ id, content, metadata }: { id: string; content?: string; metadata?: Record<string, unknown> }) => {
      return await withConn(async (conn) => {
        const check = await conn.queryObject(`SELECT id FROM thoughts WHERE id = $1`, [id]);
        if (check.rows.length === 0) return text(`Thought ${id} not found.`);

        if (content !== undefined) {
          const fp = await fingerprint(content);
          let embedding: number[] | null = null;
          try {
            embedding = (await embedDocs([content]))[0];
          } catch { /* stored as pending; backfill completes it */ }
          const extracted = (await extractMetadata(content)) ?? { ...FALLBACK_META, pending_metadata: true };
          const merged = { ...extracted, ...(metadata ?? {}) };
          try {
            await conn.queryObject(
              `UPDATE thoughts SET content=$1, embedding=$2::vector(768), metadata=$3::jsonb,
                      content_fingerprint=$4, embedding_model=$5 WHERE id=$6`,
              [content, embedding ? vecLiteral(embedding) : null, JSON.stringify(merged), fp,
               embedding ? EMBED_STAMP : null, id],
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
    async ({ id }: { id: string }) => {
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
    async ({ name }: { name: string }) => {
      const p = await readPage(name);
      if (!p) return text(`No page named [[${slugify(name)}]]. Check get_index for available pages.`);
      const prov = formatProvenance(await pageProvenance(p));
      return text(`# ${p.title}\n(kind: ${p.kind}, updated ${new Date(p.updated_at).toISOString()})\n${prov}\n\n${p.content}`);
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
      sources: z.array(z.string().uuid()).optional()
        .describe("IDs of the thoughts this page is based on (provenance). Omit to keep the page's existing sources."),
    },
    async ({ name, title, summary, content, kind = "synthesis", sources }: {
      name: string; title: string; summary: string; content: string; kind?: string; sources?: string[];
    }) => {
      await writePage({ name, title, summary, content, kind, sources }, "mcp");
      return text(`Wrote page [[${slugify(name)}]]`);
    },
  );

  server.tool(
    "delete_page",
    "Delete a wiki page by name.",
    { name: z.string().min(1) },
    async ({ name }: { name: string }) => {
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
    "Health check of the brain: orphan pages, broken wikilinks, stale pages, pages built on thoughts that were later superseded or deleted, topics with no page, pending outdated-fact proposals, last retrieval test score, pending backfill work.",
    {},
    async () => text(await audit()),
  );

  // ── Outdated facts (supersession) ───────────────────────────────────────────

  server.tool(
    "find_conflicts",
    "Scan recently captured thoughts for older thoughts they make outdated, using the local model. Only proposes; nothing changes until a proposal is accepted with resolve_conflict. Bounded per run; safe to call repeatedly.",
    {},
    async () => text(await findConflicts("mcp")),
  );

  server.tool(
    "review_conflicts",
    "List proposals that a newer note makes an older note outdated, showing both notes. Go through them with the user, then call resolve_conflict for each.",
    { limit: z.number().int().min(1).max(25).default(5).optional() },
    async ({ limit = 5 }: { limit?: number }) => text(formatConflicts(await listConflicts(limit))),
  );

  server.tool(
    "resolve_conflict",
    "Decide one proposal from review_conflicts. accept = the older note is outdated: it is kept on file but hidden from normal search. reject = both notes stay current. Ask the user before accepting.",
    {
      id: z.number().int().describe("Proposal number from review_conflicts"),
      action: z.enum(["accept", "reject"]),
    },
    async ({ id, action }: { id: number; action: "accept" | "reject" }) => text(await resolveConflict(id, action, "mcp")),
  );

  server.tool(
    "supersede_thought",
    "Mark one thought as outdated and replaced by a newer one. The old thought is kept but hidden from normal search.",
    {
      older_id: z.string().uuid().describe("The outdated thought"),
      newer_id: z.string().uuid().describe("The thought that replaces it"),
      note: z.string().optional().describe("Why, in a few words"),
    },
    async ({ older_id, newer_id, note }: { older_id: string; newer_id: string; note?: string }) =>
      text(await supersedeThought(older_id, newer_id, note ?? "", "mcp")),
  );

  server.tool(
    "restore_thought",
    "Undo a supersession: make an outdated thought current again.",
    { id: z.string().uuid().describe("Thought UUID") },
    async ({ id }: { id: string }) => text(await restoreThought(id, "mcp")),
  );

  // ── Retrieval eval set ──────────────────────────────────────────────────────

  server.tool(
    "add_eval_case",
    "Save a search test case: a question the user would really ask, plus what should come back for it. Use when the user says a result was the right one. The cases are replayed by run_eval to measure search quality.",
    {
      question: z.string().min(3).describe("The question, as the user would ask it"),
      expected: z.string().min(1).describe("ID of the thought that answers it, or the slug of the wiki page"),
      note: z.string().optional(),
    },
    async ({ question, expected, note }: { question: string; expected: string; note?: string }) =>
      text(await addEvalCase(question, expected, note ?? "")),
  );

  server.tool(
    "list_eval_cases",
    "List the saved search test cases.",
    {},
    async () => {
      const cases = await listEvalCases();
      if (cases.length === 0) return text("No test cases yet.");
      return text(cases.map((k) => `#${k.id} "${k.question}" -> ${k.expected_kind} ${k.expected_ref}${k.note ? ` (${k.note})` : ""}`).join("\n"));
    },
  );

  server.tool(
    "delete_eval_case",
    "Delete a search test case by number.",
    { id: z.number().int() },
    async ({ id }: { id: number }) => text((await deleteEvalCase(id)) ? `Deleted test case #${id}` : `No test case #${id}.`),
  );

  server.tool(
    "run_eval",
    "Replay every saved test case through search and report hit@5, hit@10 and MRR, compared with the previous run. Run before and after a search change.",
    { label: z.string().optional().describe("Name for this run, e.g. 'before prefix change'") },
    async ({ label }: { label?: string }) => text(formatEval(await runEval(label ?? ""))),
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
        const t = await c.queryObject<ThoughtRow & { superseded_by: string | null }>(
          `SELECT id, content, metadata, created_at, superseded_by FROM thoughts ORDER BY created_at ASC`,
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
            `<!-- id: ${t.id} | type: ${meta.type ?? "?"} | topics: ${(t.metadata?.topics ?? []).join(", ")}${
              (t as { superseded_by?: string | null }).superseded_by ? ` | superseded_by: ${(t as { superseded_by?: string | null }).superseded_by}` : ""
            } -->\n\n` +
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
