# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**openBrain** is a sovereign, local-first knowledge infrastructure system — a private vector database with an MCP (Model Context Protocol) server for personal AI memory. It is built on top of [Nate B. Jones' OB1 project](https://github.com/NateBJones-Projects/OB1) with modifications documented in `openBrainDesign.md`.

The implementation is two custom private HAOS add-ons in this repo:
- `openbrain-postgres/` — PostgreSQL + pgvector add-on
- `openbrain-mcp/` — Deno/TypeScript MCP server add-on
- `repository.yaml` — identifies this repo as a HAOS add-on repository

## Two-Node Architecture

**Node A — Inference & Gateway (Mac M4, 16GB RAM)**
- **LiteLLM** is the only API surface Node B calls. OpenBrain calls it through the stable tier aliases `knowledge_local_high` (metadata extraction/wiki consolidation) and `embedding` (768-dim local embeddings, 8192-token context) rather than direct model names — the physical model behind each alias can change on Node A without any config edit here. See aiProxy's `CLAUDE.md` for the current alias-to-model mapping.
- Local model runtimes on Node A sit behind LiteLLM; the MCP server must never call Ollama or MLX runtime endpoints directly, and must address models **only by tier alias, never by concrete model name**. **Enforced at startup** — `assertLiteLLMOnly()` in `src/config.ts` allowlists `embed_model` to `embedding` and `chat_model` / `meta_model` to the local-only families `knowledge_local_{high,med,low}` and `tooling_local_{high,med,low}`, rejects a `litellm_url` on port 11434, and exits rather than booting misconfigured. Extend the allowlist there when aiProxy gains a new alias OpenBrain should use.

**Node B — Storage & MCP Server (Intel NUC running Home Assistant OS / HAOS)**
- **PostgreSQL + pgvector**: custom private HAOS add-on — not the community add-on, to limit data exposure. Postgres port is not exposed to the LAN.
- **MCP Server**: custom private HAOS add-on (Deno/TypeScript, Hono + `@hono/mcp`); connects to the Postgres add-on via its HAOS internal slug hostname, calls back to LiteLLM on Node A for embeddings/metadata extraction. Only the MCP port is exposed to the LAN.

HAOS add-ons are single-container and packaged as `config.yaml` + `Dockerfile` in a GitHub repo — not docker-compose. The two add-ons communicate over the HAOS supervisor internal network.

## Database Schema

Managed by **migrations**: `openbrain-postgres/init.sql` is the frozen v1 baseline; all changes ship as numbered files in `openbrain-postgres/migrations/`, tracked in `schema_migrations` and applied automatically at add-on startup (existing DBs) or after init (fresh DBs). **Never edit init.sql for a schema change — add a migration.**

Primary table `thoughts`:
- `id`, `content`, `embedding` (vector, **nullable** — NULL = pending backfill), `embedding_model`, `metadata` (JSONB), `content_fingerprint` (SHA-256), `created_at`, `updated_at`
- Vector dimension: **768** (nomic-embed-text output — column must be declared `vector(768)`); HNSW index (not ivfflat)
- Metadata JSONB shape: `{ people: string[], action_items: string[], dates_mentioned: string[], topics: string[1-3], type: "observation"|"task"|"idea"|"reference"|"person_note", source?: string, embed_context?: string, doc_fingerprint?: string, pending_metadata?: bool }`

Supersession columns on `thoughts`: `superseded_by` (FK to the replacing thought, `ON DELETE SET NULL`), `superseded_at`, `superseded_note`. `updated_at` changes only when content or metadata change (not on re-embed or supersession).

Other tables: `wiki_pages` (compiled knowledge layer: slug `name`, `title`, `summary`, `content`, `kind`, plus `embedding`/`embedding_model` and `sources` = thought ids it was compiled from, deliberately no FK), `thought_conflicts` (outdated-fact proposals and already-checked pairs), `eval_cases` / `eval_runs` (retrieval test set), `ops_log` (append-only provenance), `app_state` (KV: telegram offset, consolidation and conflict-scan watermarks), `schema_migrations`.

## MCP Server Tools

| Tool | Description |
|------|-------------|
| `capture_thought` | Text (+ optional `source`) → LiteLLM embedding + metadata → upsert. Offline-tolerant: stores with NULL embedding if Node A is down |
| `recall` | One-call retrieval for small models: search, then a compact dated bundle of the top pages and notes. No LLM call |
| `search_thoughts` | RRF hybrid search over thoughts **and wiki pages** via SQL `brain_search()`, with type/person/topic/source/date filters; superseded thoughts excluded by default; degrades to keyword-only when embeddings unavailable |
| `browse_recent` / `brain_stats` | Chronological listing; counts incl. pending backfill, sources, embedding models |
| `update_thought` / `delete_thought` | Revise/remove; content change re-embeds; fingerprint collisions reported cleanly |
| `get_index` / `read_page` / `write_page` / `delete_page` | Karpathy-style wiki layer over `wiki_pages` |
| `consolidate_brain` | Compiles recent thoughts into entity/topic wiki pages via CHAT_MODEL (bounded per run, watermark in `app_state`) |
| `brain_audit` | Structural lint: orphan pages, broken `[[wikilinks]]`, stale pages, uncovered topics, pages built on superseded/deleted sources, pending conflict proposals, last eval score |
| `find_conflicts` / `review_conflicts` / `resolve_conflict` | Outdated-fact proposals: scan (local model judges pairs), list, accept or reject. **Propose-only by design** |
| `supersede_thought` / `restore_thought` | Mark a thought replaced by a newer one / undo |
| `add_eval_case` / `list_eval_cases` / `delete_eval_case` / `run_eval` | Retrieval test set: hit@5, hit@10, MRR vs the previous run |
| `export_brain` | Markdown dump of everything to `/share/openbrain/export` |

`/mcp?profile=lite` serves a seven-tool subset (`LITE_TOOLS` in `src/tools.ts`) for small local models; webTerminal's Brain session uses it.

HTTP endpoints besides `/mcp`: `/health` (watchdog), `/stats.json` (HA REST sensor), `POST /capture` (HA automations), `POST /jobs/consolidate` (nightly HA automation), `/` (ingress dashboard, only served to the supervisor ingress proxy at 172.30.32.2), and the **LLM-agnostic REST API** under `/api/*` (mirrors all MCP tools; OpenAPI 3.1 spec at `/openapi.json`) — `src/rest.ts`.

## Key Design Requirements

- **Deduplication**: SHA-256 `content_fingerprint` + `upsert_thought` function — capturing the same content twice updates rather than duplicates
- **Hybrid search**: Reciprocal Rank Fusion of pgvector cosine ranks and full-text ranks, computed in SQL (`hybrid_search()`)
- **Offline resilience**: capture must never fail because Node A (Mac, may sleep) is unreachable — store pending, backfill worker embeds later; same worker re-embeds on `embed_model` change (768-dim only)
- **Markdown-aware chunking**: H1–H3 boundaries, paragraph re-merge up to 1800 chars, sentence-level hard split, heading breadcrumb prepended for embedding only (`src/chunk.ts`)
- **Supersession is never automatic**: `src/conflicts.ts` only writes proposals to `thought_conflicts`; a thought is hidden from search only when a person accepts one. Measured 2026-11-12 on `dev/synthetic.json` with `tooling_local_high` judging: 7 genuine replacements found, 4 wrong proposals. Don't add auto-accept.
- **Measure search changes**: `run_eval` before and after. `dev/synthetic.json` + `dev/seed.ts` load an invented corpus into a dev database (never the real brain).
- **Local models only (owner, 2026-11-12)**: the brain's content must not reach a cloud model. Don't develop against the real brain from a cloud-model session; use a dev database and synthetic notes.
- **Access key security**: `MCP_ACCESS_KEY` via `?key=` or `x-brain-key`; digest comparison (not timing-observable)
- **Telegram fail-closed**: bot starts only with token AND non-empty numeric user-ID allowlist; private chats only; silent drop for strangers; long polling (no inbound exposure); never log message bodies

## HAOS Versioning Discipline (required on every change)

- Bump `version:` in the affected add-on's `config.yaml` — HA only offers updates when it changes. Keep `VERSION` in `openbrain-mcp/src/config.ts` in sync.
- Add a `CHANGELOG.md` entry (shown in the HA update dialog).
- Schema changes → new numbered migration file, never an init.sql edit.
- Don't bump the Postgres base image major version casually — PGDATA persists; pg17+ needs a planned `pg_upgrade`.

## Key Implementation Notes

- **Postgres networking**: No `ports` entry in `openbrain-postgres/config.yaml` — port 5432 is only reachable within the hassio Docker bridge network, never from the LAN.
- **Postgres host discovery**: `openbrain-mcp/run.sh` queries the HAOS Supervisor API at startup to find the Postgres container IP automatically. If that fails, it reads the `postgres_host` option you set manually in the add-on UI.
- **Accept header patch**: `src/index.ts` injects `Accept: application/json, text/event-stream` on every MCP request — Claude Desktop omits this header, which breaks `StreamableHTTPTransport`.
- **Transport per request**: A new `StreamableHTTPTransport` is created per request and `server.connect(transport)` is called each time — this is the correct stateless HTTP pattern for MCP.
- **MCP server layout**: `src/` modules — `config.ts`, `db.ts` (pool/KV/ops-log, `waitForMigration`), `llm.ts` (timeouts, `embedDocs`/`embedQuery`, `parseJsonReply`), `chunk.ts`, `brain.ts` (capture/search/recall/supersession/stats shared by MCP+Telegram+HTTP), `wiki.ts` (pages, provenance, consolidate, audit), `conflicts.ts`, `evals.ts`, `backfill.ts` (thoughts and pages), `telegram.ts`, `ui.ts`, `tools.ts` (full and lite profiles), `rest.ts`, `index.ts`.
- **Version coupling**: the MCP server names the migration it needs (`REQUIRED_MIGRATION` in `config.ts`) and waits for it at startup. Bump it when a release depends on a new migration.
- **Driver gotcha**: deno-postgres returns `float8`/`numeric` columns as strings; wrap in `Number()` before arithmetic or JSON output.
- **Backups**: postgres add-on `backup_pre` runs `pg_dump` to `/data/backup/openbrain.sql` before every HA backup.
- **Typecheck**: `deno task check` in `openbrain-mcp/`.

## Running Locally (for development)

Start Postgres with pgvector:
```
docker run -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=openbrain -e POSTGRES_USER=openbrain \
  -v $(pwd)/openbrain-postgres/init.sql:/docker-entrypoint-initdb.d/01-init.sql \
  -p 5432:5432 pgvector/pgvector:pg16
```

Start the MCP server:
```
cd openbrain-mcp
MCP_ACCESS_KEY=dev LITELLM_URL=http://localhost:4000 POSTGRES_HOST=localhost \
POSTGRES_DB=openbrain POSTGRES_USER=openbrain POSTGRES_PASSWORD=dev \
deno task start
```

## Reference Project

The OB1 setup guide at `https://promptkit.natebjones.com/20260224_uq1_guide_main` and the GitHub repo are the foundation — consult them before implementing anything novel that OB1 may already solve.
