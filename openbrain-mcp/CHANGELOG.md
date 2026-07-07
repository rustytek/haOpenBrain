# Changelog

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
