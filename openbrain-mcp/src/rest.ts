// LLM-agnostic REST surface: every brain capability as plain JSON-over-HTTP,
// mirroring the MCP tools, plus a served OpenAPI 3.1 spec (/openapi.json) so
// any tool-calling model or framework (ChatGPT Actions, OpenWebUI, n8n,
// LangChain, plain scripts) can generate functions against it without MCP.
// Auth is the same access key as MCP: x-brain-key header or ?key= param.

import { Hono } from "hono";
import { checkAccessKey, VERSION } from "./config.ts";
import { browseRecent, captureThought, getStats, searchThoughts } from "./brain.ts";
import { logOp, withConn } from "./db.ts";
import { audit, consolidate, deletePage, getIndex, readPage, slugify, writePage } from "./wiki.ts";

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

  app.get("/api/search", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "q query param is required" }, 400);
    const limit = Math.min(parseInt(c.req.query("limit") ?? "10") || 10, 50);
    const { results, mode } = await searchThoughts(q, limit);
    return c.json({ mode, results });
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
    return c.json(p);
  });

  app.put("/api/wiki/:name", async (c) => {
    let body: { title?: string; summary?: string; content?: string; kind?: string };
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
      { name: c.req.param("name"), title: body.title, summary: body.summary ?? "", content: body.content, kind },
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
      id: { type: "string" },
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
          summary: "Hybrid semantic + keyword search over all thoughts",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 10, maximum: 50 } },
          ],
          responses: ok("Ranked results"),
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
