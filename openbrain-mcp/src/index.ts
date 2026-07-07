import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { cfg, checkAccessKey, litellmHeaders, VERSION } from "./config.ts";
import { waitForPostgres } from "./db.ts";
import { registerTools } from "./tools.ts";
import { mountRest } from "./rest.ts";
import { startBackfillWorker } from "./backfill.ts";
import { startTelegramBot } from "./telegram.ts";
import { consolidate } from "./wiki.ts";
import { captureThought, getStats } from "./brain.ts";
import { renderDashboard } from "./ui.ts";

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "openBrain", version: VERSION });
registerTools(server);

// ── HTTP layer ────────────────────────────────────────────────────────────────

type Env = { Bindings: { remoteAddr: string } };
const app = new Hono<Env>();

// HA ingress proxies from the supervisor's fixed address; HA does the auth.
const INGRESS_PROXY_IP = "172.30.32.2";
const isIngress = (remoteAddr: string) => remoteAddr === INGRESS_PROXY_IP;

async function authorized(c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } }): Promise<boolean> {
  return await checkAccessKey(c.req.header("x-brain-key") ?? c.req.query("key"));
}

app.get("/health", (c) => c.json({ status: "ok", version: VERSION }));

// LLM-agnostic REST API (/api/*) + OpenAPI spec (/openapi.json)
mountRest(app);

app.all("/mcp", async (c) => {
  if (!(await authorized(c))) return c.text("Unauthorized", 401);

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

// JSON stats for a Home Assistant REST sensor.
app.get("/stats.json", async (c) => {
  if (!(await authorized(c))) return c.text("Unauthorized", 401);
  return c.json(await getStats());
});

// Nightly HA automation target: rest_command → POST /jobs/consolidate
app.post("/jobs/consolidate", async (c) => {
  if (!(await authorized(c))) return c.text("Unauthorized", 401);
  const report = await consolidate("jobs-endpoint");
  return c.json({ ok: true, report });
});

// Plain REST capture for Home Assistant automations / Assist (rest_command).
// Body: {"content": "...", "source": "ha-automation"} — source defaults to "ha".
app.post("/capture", async (c) => {
  if (!(await authorized(c))) return c.text("Unauthorized", 401);
  let body: { content?: string; source?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid JSON body" }, 400);
  }
  if (!body.content || typeof body.content !== "string") {
    return c.json({ ok: false, error: "content (string) is required" }, 400);
  }
  const r = await captureThought(body.content, body.source ?? "ha");
  return c.json({ ok: true, ids: r.ids, chunks: r.chunks, pending_embedding: r.pendingEmbedding });
});

// Ingress dashboard (root path when proxied by HA; nothing on the LAN port).
app.get("/", async (c) => {
  if (!isIngress(c.env.remoteAddr)) return c.text("Not found", 404);
  const basePath = c.req.header("x-ingress-path") ?? "";
  const html = await renderDashboard(c.req.query("q") || undefined, `${basePath}/`);
  return c.html(html);
});

// ── Startup ───────────────────────────────────────────────────────────────────

await waitForPostgres();
startBackfillWorker();
startTelegramBot();

// Log available LiteLLM models so the user can see what to configure.
fetch(`${cfg.litellmUrl}/models`, {
  headers: litellmHeaders(),
  signal: AbortSignal.timeout(10_000),
})
  .then((r) => r.json())
  .then((d) => {
    const ids = (d.data as { id: string }[])?.map((m) => m.id).join(", ");
    console.log(`LiteLLM models available: ${ids || "(none)"}`);
    console.log(`Using embed_model="${cfg.embedModel}" chat_model="${cfg.chatModel}"`);
  })
  .catch(() => console.log("WARN: Could not fetch model list from LiteLLM (Node A offline? capture still works, embeddings backfill later)"));

Deno.serve({ port: cfg.port }, (req, info) =>
  app.fetch(req, { remoteAddr: (info.remoteAddr as Deno.NetAddr).hostname }));
console.log(`openBrain MCP v${VERSION} listening on :${cfg.port}`);
