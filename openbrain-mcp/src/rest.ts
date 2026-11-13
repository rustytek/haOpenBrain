// LLM-agnostic REST surface: every brain capability as plain JSON-over-HTTP,
// mirroring the MCP tools, plus a served OpenAPI 3.1 spec (/openapi.json) so
// any tool-calling model or framework (ChatGPT Actions, OpenWebUI, n8n,
// LangChain, plain scripts) can generate functions against it without MCP.
// Auth is the same access key as MCP: x-brain-key header or ?key= param.

import { Hono } from "hono";
import { checkAccessKey, VERSION } from "./config.ts";
import { browseRecent, captureThought, getStats, recall, restoreThought, search, supersedeThought } from "./brain.ts";
import { findConflicts, listConflicts, resolveConflict } from "./conflicts.ts";
import { addEvalCase, deleteEvalCase, listEvalCases, runEval } from "./evals.ts";
import { logOp, withConn } from "./db.ts";
import { audit, consolidate, deletePage, getIndex, pageProvenance, readPage, slugify, writePage } from "./wiki.ts";

// deno-lint-ignore no-explicit-any
export function mountRest(app: Hono<any>): void {
  app.use("/api/*", async (c, next) => {
    const key = c.req.header("x-brain-key") ?? c.req.query("key");
    if (!(await checkAccessKey(key))) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  // ── Thoughts ────────────────────────────────────────────────────────────────

  app.post("/api/thoughts", async (c) => {
    let body: { content?: string; source?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!body.content || typeof body.content !== "string") {
      return c.json({ error: "content (string) is required" }, 400);
    }
    const r = await captureThought(body.content, body.source ?? "rest-api");
    return c.json({ ids: r.ids, chunks: r.chunks, pending_embedding: r.pendingEmbedding });
  });

  // Comma-separated list params: ?type=task,idea&person=sam
  const list = (v: string | undefined) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
  const searchOpts = (q: (n: string) => string | undefined) => ({
    types: list(q("type")),
    people: list(q("person")),
    topics: list(q("topic")),
    source: q("source") || undefined,
    since: q("since") || undefined,
    until: q("until") || undefined,
    includeSuperseded: q("include_superseded") === "true",
    includePages: q("include_pages") !== "false",
  });

  app.get("/api/search", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "q query param is required" }, 400);
    const limit = Math.min(parseInt(c.req.query("limit") ?? "10") || 10, 50);
    try {
      const { hits, mode } = await search(q, { limit, ...searchOpts((n) => c.req.query(n)) });
      return c.json({ mode, results: hits });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // One-call retrieval bundle for small models (same as the MCP `recall` tool).
  app.get("/api/recall", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "q query param is required" }, 400);
    try {
      return c.json({ text: await recall(q, searchOpts((n) => c.req.query(n))) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.post("/api/thoughts/:id/supersede", async (c) => {
    let body: { by?: string; note?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!body.by) return c.json({ error: "by (id of the newer thought) is required" }, 400);
    return c.json({ result: await supersedeThought(c.req.param("id"), body.by, body.note ?? "", "rest-api") });
  });

  app.post("/api/thoughts/:id/restore", async (c) =>
    c.json({ result: await restoreThought(c.req.param("id"), "rest-api") }));

  // ── Outdated-fact proposals ─────────────────────────────────────────────────

  app.post("/api/conflicts/scan", async (c) => c.json({ report: await findConflicts("rest-api") }));
  app.get("/api/conflicts", async (c) => c.json({ pending: await listConflicts(25) }));
  app.post("/api/conflicts/:id", async (c) => {
    let body: { action?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (body.action !== "accept" && body.action !== "reject") {
      return c.json({ error: 'action must be "accept" or "reject"' }, 400);
    }
    return c.json({ result: await resolveConflict(parseInt(c.req.param("id")), body.action, "rest-api") });
  });

  // ── Retrieval eval set ──────────────────────────────────────────────────────

  app.get("/api/eval/cases", async (c) => c.json({ cases: await listEvalCases() }));
  app.post("/api/eval/cases", async (c) => {
    let body: { question?: string; expected?: string; note?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!body.question || !body.expected) return c.json({ error: "question and expected are required" }, 400);
    return c.json({ result: await addEvalCase(body.question, body.expected, body.note ?? "") });
  });
  app.delete("/api/eval/cases/:id", async (c) => {
    const ok = await deleteEvalCase(parseInt(c.req.param("id")));
    return ok ? c.json({ deleted: c.req.param("id") }) : c.json({ error: "not found" }, 404);
  });
  app.post("/api/eval/run", async (c) => {
    const report = await runEval(c.req.query("label") ?? "");
    return report ? c.json(report) : c.json({ error: "no eval cases yet" }, 400);
  });

  app.get("/api/recent", async (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20") || 20, 100);
    const type = c.req.query("type") || undefined;
    return c.json({ results: await browseRecent(limit, type) });
  });

  app.delete("/api/thoughts/:id", async (c) => {
    const id = c.req.param("id");
    const deleted = await withConn(async (conn) => {
      const r = await conn.queryObject(`DELETE FROM thoughts WHERE id = $1 RETURNING id`, [id]);
      return r.rows.length > 0;
    });
    if (!deleted) return c.json({ error: "not found" }, 404);
    await logOp("delete", "rest-api", id);
    return c.json({ deleted: id });
  });

  app.get("/api/stats", async (c) => c.json(await getStats()));

  // ── Wiki ────────────────────────────────────────────────────────────────────

  app.get("/api/wiki", async (c) => {
    const pages = await withConn(async (conn) => {
      const r = await conn.queryObject<{ name: string; title: string; summary: string; kind: string; updated_at: Date }>(
        `SELECT name, title, summary, kind, updated_at FROM wiki_pages ORDER BY kind, name`,
      );
      return r.rows;
    });
    return c.json({ pages, index_markdown: await getIndex() });
  });

  app.get("/api/wiki/:name", async (c) => {
    const p = await readPage(c.req.param("name"));
    if (!p) return c.json({ error: "not found" }, 404);
    return c.json({ ...p, provenance: await pageProvenance(p) });
  });

  app.put("/api/wiki/:name", async (c) => {
    let body: { title?: string; summary?: string; content?: string; kind?: string; sources?: string[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!body.title || !body.content) {
      return c.json({ error: "title and content are required" }, 400);
    }
    const kind = body.kind ?? "synthesis";
    if (!["concept", "entity", "summary", "synthesis", "overview"].includes(kind)) {
      return c.json({ error: "invalid kind" }, 400);
    }
    await writePage(
      {
        name: c.req.param("name"), title: body.title, summary: body.summary ?? "", content: body.content, kind,
        sources: Array.isArray(body.sources) ? body.sources : undefined,
      },
      "rest-api",
    );
    return c.json({ name: slugify(c.req.param("name")) });
  });

  app.delete("/api/wiki/:name", async (c) => {
    const ok = await deletePage(c.req.param("name"), "rest-api");
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.json({ deleted: slugify(c.req.param("name")) });
  });

  // ── Maintenance ─────────────────────────────────────────────────────────────

  app.post("/api/consolidate", async (c) => c.json({ report: await consolidate("rest-api") }));
  app.get("/api/audit", async (c) => c.json({ report: await audit() }));

  // ── OpenAPI spec (public shape description; auth still required to call) ───
  app.get("/openapi.json", (c) => c.json(openapiSpec()));
}

function openapiSpec(): Record<string, unknown> {
  const key = [{ BrainKey: [] }];
  const thought = {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["thought", "page"] },
      id: { type: "string" },
      ref: { type: "string", description: "Thought id, or wiki page slug" },
      title: { type: "string" },
      superseded_by: { type: "string" },
      content: { type: "string" },
      metadata: { type: "object" },
      score: { type: "number" },
      created_at: { type: "string" },
    },
  };
  const jsonBody = (props: Record<string, unknown>, required: string[]) => ({
    required: true,
    content: { "application/json": { schema: { type: "object", properties: props, required } } },
  });
  const ok = (desc: string) => ({ "200": { description: desc } });
  const str = (name: string, description: string) => ({ name, in: "query", description, schema: { type: "string" } });
  const filterParams = [
    str("type", "Thought type(s), comma-separated: observation, task, idea, reference, person_note"),
    str("person", "Person name(s), comma-separated; case-insensitive partial match"),
    str("topic", "Topic tag(s), comma-separated; case-insensitive partial match"),
    str("source", "Exact capture source, e.g. telegram"),
    str("since", "On or after this date (YYYY-MM-DD)"),
    str("until", "On or before this date (YYYY-MM-DD)"),
    { name: "include_superseded", in: "query", description: "Also return thoughts marked outdated", schema: { type: "boolean", default: false } },
    { name: "include_pages", in: "query", description: "Also return wiki pages (ignored with type/person/topic/source filters)", schema: { type: "boolean", default: true } },
  ];

  return {
    openapi: "3.1.0",
    info: {
      title: "OpenBrain API",
      version: VERSION,
      description:
        "Personal AI memory: capture thoughts, hybrid-search them, and read/write the compiled wiki. " +
        "Authenticate every request with the x-brain-key header.",
    },
    servers: [{ url: "/", description: "This OpenBrain instance" }],
    components: {
      securitySchemes: { BrainKey: { type: "apiKey", in: "header", name: "x-brain-key" } },
      schemas: { Thought: thought },
    },
    security: key,
    paths: {
      "/api/thoughts": {
        post: {
          operationId: "captureThought",
          summary: "Save a thought or document to memory (chunked automatically)",
          requestBody: jsonBody({ content: { type: "string" }, source: { type: "string" } }, ["content"]),
          responses: ok("IDs of stored chunk(s)"),
        },
      },
      "/api/search": {
        get: {
          operationId: "searchThoughts",
          summary: "Hybrid semantic + keyword search over thoughts and wiki pages, with filters",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 10, maximum: 50 } },
            ...filterParams,
          ],
          responses: ok("Ranked results; each has kind 'thought' or 'page'"),
        },
      },
      "/api/recall": {
        get: {
          operationId: "recall",
          summary: "One-call memory lookup: relevant wiki pages and notes as a compact, dated text bundle",
          parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }, ...filterParams],
          responses: ok("Text bundle"),
        },
      },
      "/api/thoughts/{id}/supersede": {
        post: {
          operationId: "supersedeThought",
          summary: "Mark a thought outdated, replaced by a newer one (kept, hidden from default search)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ by: { type: "string" }, note: { type: "string" } }, ["by"]),
          responses: ok("Result message"),
        },
      },
      "/api/thoughts/{id}/restore": {
        post: {
          operationId: "restoreThought",
          summary: "Undo a supersession",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: ok("Result message"),
        },
      },
      "/api/conflicts": {
        get: { operationId: "listConflicts", summary: "Pending proposals that a newer thought outdates an older one", responses: ok("Proposals") },
      },
      "/api/conflicts/scan": {
        post: { operationId: "scanConflicts", summary: "Scan recent thoughts for outdated older ones (proposes only)", responses: ok("Scan report") },
      },
      "/api/conflicts/{id}": {
        post: {
          operationId: "resolveConflict",
          summary: "Accept (supersede the older thought) or reject a proposal",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: jsonBody({ action: { type: "string", enum: ["accept", "reject"] } }, ["action"]),
          responses: ok("Result message"),
        },
      },
      "/api/eval/cases": {
        get: { operationId: "listEvalCases", summary: "Saved search test cases", responses: ok("Cases") },
        post: {
          operationId: "addEvalCase",
          summary: "Save a search test case: a question and the thought id or page slug that should come back",
          requestBody: jsonBody({ question: { type: "string" }, expected: { type: "string" }, note: { type: "string" } }, ["question", "expected"]),
          responses: ok("Result message"),
        },
      },
      "/api/eval/cases/{id}": {
        delete: {
          operationId: "deleteEvalCase",
          summary: "Delete a search test case",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: ok("Deletion confirmation"),
        },
      },
      "/api/eval/run": {
        post: {
          operationId: "runEval",
          summary: "Replay all test cases through search; returns hit@5, hit@10, MRR and the previous run",
          parameters: [{ name: "label", in: "query", schema: { type: "string" } }],
          responses: ok("Eval report"),
        },
      },
      "/api/recent": {
        get: {
          operationId: "browseRecent",
          summary: "List recent thoughts chronologically",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
            {
              name: "type",
              in: "query",
              schema: { type: "string", enum: ["observation", "task", "idea", "reference", "person_note"] },
            },
          ],
          responses: ok("Recent thoughts"),
        },
      },
      "/api/thoughts/{id}": {
        delete: {
          operationId: "deleteThought",
          summary: "Permanently delete a thought",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: ok("Deletion confirmation"),
        },
      },
      "/api/stats": {
        get: { operationId: "brainStats", summary: "Counts and distributions", responses: ok("Stats") },
      },
      "/api/wiki": {
        get: {
          operationId: "getWikiIndex",
          summary: "Wiki index: every compiled page with a one-line summary",
          responses: ok("Page list + markdown index"),
        },
      },
      "/api/wiki/{name}": {
        get: {
          operationId: "readWikiPage",
          summary: "Read a wiki page by slug",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          responses: ok("The page"),
        },
        put: {
          operationId: "writeWikiPage",
          summary: "Create or overwrite a wiki page",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({
            title: { type: "string" },
            summary: { type: "string" },
            content: { type: "string" },
            kind: { type: "string", enum: ["concept", "entity", "summary", "synthesis", "overview"] },
            sources: { type: "array", items: { type: "string" }, description: "Thought ids the page is based on" },
          }, ["title", "content"]),
          responses: ok("Written page slug"),
        },
        delete: {
          operationId: "deleteWikiPage",
          summary: "Delete a wiki page",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          responses: ok("Deletion confirmation"),
        },
      },
      "/api/consolidate": {
        post: {
          operationId: "consolidateBrain",
          summary: "Compile recent thoughts into entity/topic wiki pages (bounded per run)",
          responses: ok("Consolidation report"),
        },
      },
      "/api/audit": {
        get: {
          operationId: "brainAudit",
          summary: "Structural wiki health check",
          responses: ok("Audit report"),
        },
      },
    },
  };
}
