# Connecting Models to OpenBrain & Working the Wiki

How to plug **any** AI model into your brain, and how to use the compiled wiki layer once it's connected.

- **Endpoint base**: `http://<ha-ip>:8000` (the OpenBrain MCP Server add-on)
- **Auth**: every request needs your access key — header `x-brain-key: <mcp_access_key>` (preferred) or `?key=<mcp_access_key>`
- Two doors, same brain: **MCP** for clients that speak it, **REST** for everything else. Both expose identical capabilities.

---

## Part 1 — Connecting models

### Path A: MCP clients (richest integration)

Endpoint: `http://<ha-ip>:8000/mcp`

**Claude Desktop / Claude Code** (`claude_desktop_config.json` / `.mcp.json`):

```json
{
  "mcpServers": {
    "openbrain": {
      "type": "http",
      "url": "http://<ha-ip>:8000/mcp",
      "headers": { "x-brain-key": "<mcp_access_key>" }
    }
  }
}
```

Claude Code one-liner alternative:

```bash
claude mcp add openbrain --transport http http://<ha-ip>:8000/mcp --header "x-brain-key: <mcp_access_key>"
```

Most other MCP-capable clients (ChatGPT connectors, Gemini CLI, Cursor, OpenWebUI's MCP support) take the same two facts: the URL and the `x-brain-key` header. Once connected, the model sees all tools: `capture_thought`, `search_thoughts`, `browse_recent`, `brain_stats`, `update_thought`, `delete_thought`, `get_index`, `read_page`, `write_page`, `delete_page`, `consolidate_brain`, `brain_audit`, `export_brain`.

### Path B: Plain REST (any model, any framework, any script)

No MCP required — just HTTP + the key header. Full reference at `GET /openapi.json`.

| Capability | Call |
|---|---|
| Capture | `POST /api/thoughts` body `{"content": "...", "source": "my-tool"}` |
| Search (RRF hybrid) | `GET /api/search?q=<query>&limit=10` |
| Recent | `GET /api/recent?limit=20&type=task` |
| Delete thought | `DELETE /api/thoughts/{id}` |
| Stats | `GET /api/stats` |
| Wiki index | `GET /api/wiki` |
| Read / write / delete page | `GET` / `PUT` / `DELETE /api/wiki/{name}` |
| Consolidate | `POST /api/consolidate` |
| Audit | `GET /api/audit` |

Quick sanity check from any machine on the LAN:

```bash
curl -H "x-brain-key: $KEY" "http://<ha-ip>:8000/api/search?q=drone+mapping"
```

**Framework recipes:**

- **OpenWebUI / LangChain / n8n / anything that ingests OpenAPI**: point it at `http://<ha-ip>:8000/openapi.json`, set the `x-brain-key` header (apiKey security scheme), and it auto-generates the tool functions. Done.
- **Local model + your own code** (Ollama, MLX, anything with function calling): define two functions — `searchThoughts(q)` → `GET /api/search`, `captureThought(content)` → `POST /api/thoughts` — and you have a remembering assistant. Add the wiki functions when you want synthesis (Part 2).
- **ChatGPT custom GPT (Actions)**: import `/openapi.json` as the Action schema, auth type "API Key" with header name `x-brain-key`. ⚠️ ChatGPT's servers must reach the endpoint — that means exposing it via Tailscale Funnel / Cloudflare Tunnel first. Never port-forward it raw.

### Give the model a memory protocol

A connected tool is only half the job — the model needs to know *when* to use it. Paste something like this into the system prompt / custom instructions of any model you connect:

```
You have access to my personal memory system (OpenBrain).
- Before answering questions about my projects, people I know, or past
  decisions: call get_index first; read relevant wiki pages; use
  search_thoughts for specifics the wiki doesn't cover.
- When I tell you something worth remembering (a decision, a fact, a
  plan, a person detail): capture_thought it, with a source tag.
- When we produce a valuable synthesis or answer: write_page it into the
  wiki so it compounds. Link related pages with [[wikilinks]].
- Never invent memories. If the brain has nothing, say so.
```

(For REST-only models, swap tool names for the `/api/*` calls.)

### Which models power the brain internally?

Separate question, already agnostic: embeddings and metadata extraction go through **LiteLLM** on Node A. Change `embed_model` / `chat_model` in the add-on config to any model LiteLLM routes. Swapping `embed_model` auto-re-embeds your whole brain in the background (768-dim models only, e.g. nomic variants).

---

## Part 2 — Working the wiki

### The mental model

Two layers (Karpathy's llm-wiki pattern):

1. **Thoughts** — raw, timestamped captures. Append-heavy, searched by RRF hybrid search. This is the *source material*.
2. **Wiki pages** — LLM-compiled synthesis that *accumulates*: entity pages (people), concept pages (topics), plus pages you file manually. Instead of re-deriving answers from raw chunks every time (classic RAG), the wiki stores the current best understanding and gets richer with every consolidation.

Pages have a kebab-case slug (`name`), a `kind` (`entity` | `concept` | `summary` | `synthesis` | `overview`), a one-line `summary`, and markdown `content` cross-linked with `[[wikilinks]]`.

### The index is the entry point

`get_index` (MCP) or `GET /api/wiki` (REST) returns every page + one-line summary, grouped by kind — deliberately small enough to fit in one context window. The intended navigation loop for any model:

```
get_index  →  read_page (the 1–3 relevant pages)  →  answer
                                  ↓ only if the wiki lacks specifics
                         search_thoughts (raw memory)
```

This is cheaper and better-grounded than vector search for anything the wiki already covers.

### How pages get created

- **Automatically — consolidation**: `consolidate_brain` / `POST /api/consolidate` reads everything captured since the last run and creates/updates pages for the most-mentioned people and topics (bounded to 8 pages per run; watermark tracked, so it never reprocesses). Recommended: the nightly HA automation from the add-on DOCS, so the wiki maintains itself.
- **Manually — filing syntheses**: when a conversation produces something worth keeping ("here's the plan we worked out for the VLAN redesign"), have the model `write_page` it. This is the compounding habit that makes the system worth more every month.

### Maintenance

- `brain_audit` / `GET /api/audit` — structural lint: orphan pages (nothing links to them), broken `[[wikilinks]]`, stale pages (>30 days), frequently-mentioned topics that deserve a page but don't have one, and pending backfill work. Run it weekly-ish, then fix findings by asking your model to write/update the flagged pages.
- Semantic contradictions are the *model's* job: "read [[ridgeline-aerial]] and my recent thoughts about it — anything contradictory or out of date? Update the page."

### Viewing without a model

- **HA sidebar → OpenBrain**: read-only dashboard (stats, wiki index, recent, search) via ingress.
- **`export_brain`**: dumps every wiki page to `/share/openbrain/export/wiki/*.md` with wikilinks intact — drop into an Obsidian vault to browse as a graph.

### Example session (any connected model)

```
You:   What's the state of the drone business?
Model: [get_index] → sees [[ridgeline-aerial]], [[sarah]], [[drone-mapping]]
       [read_page ridgeline-aerial] → answers from compiled knowledge
You:   We decided today: RTK base station ordered, first survey job is
       the Hendersons' parcel, week of the 20th.
Model: [capture_thought "...", source=chat]
You:   Update the wiki with that.
Model: [read_page ridgeline-aerial] → [write_page ridgeline-aerial (merged)]
```

Overnight, consolidation folds any other captures in; the audit catches anything that drifts. The brain compounds while you sleep.
