# Changelog

## 1.2.1

### Fixed

- **Postgres auto-discovery broken for custom-repository installs.** Add-ons installed from a custom repository (this one) get their runtime slug prefixed with a repository hash by the Supervisor (e.g. `c1412455_openbrain_mcp`), not the bare `openbrain_mcp` from `config.yaml`. `run.sh` hardcoded the bare `openbrain_postgres` slug when querying the Supervisor API for the database's IP, so the lookup always 404'd, auto-discovery silently "returned nothing" every boot, and the add-on fell back to whatever was (or wasn't) typed into `postgres_host`. Now it reads its own slug via `/addons/self/info`, derives the shared repo-hash prefix, and queries the correctly-prefixed Postgres slug.
- `postgres_host` is now sanitized if you paste a full URL (`http://host:port/`) instead of a bare hostname/IP — the scheme and port are stripped automatically.
- A failed startup no longer hangs as an opaque "Top-level await promise never resolved" — it logs a clear `FATAL:` line and exits so the Supervisor's restart policy applies normally.

## 1.2.0

- **LLM-agnostic REST API**: every brain capability is now callable as plain JSON-over-HTTP under `/api/*` — capture, hybrid search, recent, delete, stats, full wiki CRUD, consolidate, audit. Same `x-brain-key` auth as MCP. Use MCP where available; use REST for everything else (n8n, scripts, OpenWebUI, custom frontends, non-MCP models).
- **OpenAPI 3.1 spec served at `/openapi.json`** so tool-calling frameworks and ChatGPT custom-GPT Actions can auto-generate functions against the brain.

## 1.1.0

Requires **OpenBrain Database 1.1.0** (schema migrations 001–002). Update the database add-on first.

### New

- **Wiki layer** (Karpathy llm-wiki pattern): `get_index`, `read_page`, `write_page`, `delete_page` tools; `consolidate_brain` compiles recent thoughts into entity/topic pages using the chat model; `brain_audit` lints for orphan pages, broken `[[wikilinks]]`, stale pages, and uncovered topics.
- **Telegram capture bot** (opt-in, hardened): long-polling bot that captures texts as thoughts and answers `/search`, `/recent`, `/stats`. Fail-closed — only starts when both a bot token *and* a numeric user-ID allowlist are configured; private chats only; unauthorized senders are silently dropped. See DOCS for setup.
- **Offline-resilient capture**: if the inference node (LiteLLM) is unreachable, thoughts are stored immediately without an embedding and a background backfill worker embeds them when the node returns. Search degrades to keyword-only instead of failing.
- **Embedding model versioning**: every row is stamped with its embedding model; changing `embed_model` triggers automatic background re-embedding of old rows (same 768-dim models only, e.g. nomic variants).
- **`export_brain` tool**: dumps all thoughts + wiki pages as markdown to `/share/openbrain/export`.
- **Ops log**: every capture/update/delete/wiki-write/consolidation is recorded in an append-only `ops_log` table.
- **Home Assistant integration**: `GET /stats.json` for a REST sensor, `POST /capture` for automations/Assist, `POST /jobs/consolidate` for a nightly automation, ingress dashboard in the HA sidebar (read-only stats/search/recent), supervisor watchdog on `/health`.

### Changed

- **Hybrid search now uses Reciprocal Rank Fusion** in SQL (`hybrid_search()`), replacing the client-side merge that let vector results crowd out keyword matches. Results include a relevance score.
- **Chunking**: paragraphs re-merge up to the size limit, oversized paragraphs are split at sentence boundaries, every chunk carries a heading breadcrumb that is prepended for embedding (contextual retrieval), and chunks of one document are linked via `doc_fingerprint`.
- Chunk embeddings are requested in a single batched LiteLLM call.
- All LiteLLM calls have timeouts; Postgres connection retries at startup instead of crash-looping.
- `capture_thought` accepts an optional `source`; stats break down by source and embedding model.
- Access-key comparison is no longer timing-observable; secrets use the masked `password` schema type in the add-on UI.
- `update_thought` reports fingerprint collisions clearly instead of throwing a raw SQL error.

## 1.0.8

- Initial release: capture/search/browse/stats/update/delete tools, StreamableHTTP MCP transport, Claude Desktop Accept-header patch, Supervisor-based Postgres discovery.
