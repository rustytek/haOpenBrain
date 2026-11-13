# Changelog

## 1.3.0

**Requires OpenBrain Database add-on 1.2.0** (migration 003). Update the database add-on first. If this add-on starts before the database is updated it logs `WARN: database schema is behind` and waits up to 5 minutes, then exits so the Supervisor restarts it.

### Added

- **Search covers wiki pages and takes filters.** `search_thoughts` (and `GET /api/search`) now returns thoughts and wiki pages in one ranked list, with optional `type`, `person`, `topic`, `source`, `since`, `until`. Person and topic match case-insensitively on part of the name. Each result has a `kind` (`thought` or `page`).
- **`recall`**: one call that returns the relevant wiki pages and notes as a short, dated bundle. Made for small local models, which do much better with one simple tool than with a choice of twenty. No model runs on the server for this; it is retrieval and formatting.
- **Lite tool profile**: `/mcp?profile=lite` exposes seven tools (`recall`, `capture_thought`, `read_page`, `write_page`, `review_conflicts`, `resolve_conflict`, `add_eval_case`). `/mcp` is unchanged apart from the new tools.
- **Outdated facts (supersession).** A thought can be marked as replaced by a newer one: it stays on file but drops out of normal search (`include_superseded` brings it back; `restore_thought` undoes it). The nightly `POST /jobs/consolidate` now also runs a scan that **proposes** such pairs; nothing is hidden until you accept a proposal (`review_conflicts`, `resolve_conflict`). The scan is bounded to 12 new thoughts per run and, on its first run, starts 30 days back.
- **Wiki provenance.** Pages record the thought ids they were compiled from. `read_page` shows how many are still current, and `brain_audit` lists pages built on thoughts that were later superseded or deleted. This is page-level, not per sentence.
- **Retrieval test set.** `add_eval_case` saves a question with the thought or page that should come back; `run_eval` replays them all and reports hit@5, hit@10 and MRR against the previous run. Use it before and after any search change.
- **`meta_model`** (optional): the model for per-capture metadata extraction. Defaults to `chat_model`. A non-reasoning alias such as `tooling_local_high` does this in a couple of seconds; the reasoning default took about a minute per note in testing and sometimes timed out (the thought is still saved, and metadata is filled in later).
- **`embed_task_prefix`** (optional, `none` | `nomic`, default `none`): send `search_document:` / `search_query:` prefixes, as nomic-embed-text is documented to expect. Off by default: it made no measurable difference on a 40-note synthetic test, and turning it on re-embeds the whole brain. Measure with `run_eval` on real cases first.

### Changed

- `chat_model` / `meta_model` accept the `tooling_local_*` aliases as well as `knowledge_local_*`. Both families are local-only.
- `consolidate_brain` skips superseded thoughts and tolerates replies wrapped in `<think>` tags or code fences.
- `/stats.json` and `brain_stats` include `superseded` and `pending_conflicts`.
- `export_brain` marks superseded thoughts.

### Measured on the synthetic set (`dev/synthetic.json`, 40 invented notes, 16 questions, 2026-11-12)

- Search: hit@5 94%, MRR 0.885; unchanged by the prefix option (0.883); MRR 0.915 after the seven genuine replacements were accepted.
- Outdated-fact scan with `tooling_local_high` as judge: proposed all 7 genuine replacements and 4 wrong ones. That is why it only proposes. Not measured with `knowledge_local_high`.
- 16 questions is a small sample: one question moves hit@5 by 6 points.

## 1.2.3

### Fixed

- **Startup guard: model options must now be LiteLLM tier aliases.** `embed_model` / `chat_model` are free-text fields, and updating an add-on never rewrites options you already saved — so installs predating 1.2.2 kept concrete model names indefinitely and silently stopped following the aliases. Observed in the wild: `chat_model: aLocalModel_qwen3.5-mlx` (the model deliberately excluded from every tier alias for its MLX-engine hang bug) and `embed_model: nomic-embed-text`, both still routed through LiteLLM but pinned to one fixed model.

  The server now validates model options at boot against an **allowlist** — `embed_model` must be `embedding`; `chat_model` must be `knowledge_local_{high,med,low}` — and exits with a clear `FATAL:` line naming the offending option. This is deliberately an allowlist rather than a denylist of known-bad names: a direct name that happens to resolve today is still wrong, because addressing a model by name defeats the indirection that lets Node A swap models without touching add-on config. `litellm_url` is checked too — pointing it at port 11434 (Ollama) is rejected.

### Note

- If the add-on stops booting after this update, that's the guard doing its job. Open **Configuration**, set `embed_model: embedding` and `chat_model: knowledge_local_high`, and restart. Switching `embed_model` to the alias re-stamps `embedding_model` and triggers a one-time background re-embed (~16 rows/minute, no data loss).

## 1.2.2

- **Default `embed_model`/`chat_model` switched to LiteLLM tier aliases**: `embedding` (resolves to `nomic-embed-text`) and `knowledge_local_high` (resolves to the strongest clean local reasoning model, currently `deepseek-r1:8b`) instead of hardcoded direct model names. Aliases are stable across Node A model swaps — no add-on config edit needed when aiProxy's underlying model roster changes. Existing installs keep their currently-saved values until manually updated; only fresh installs pick up the new default automatically.
- Note: switching an existing install's `embed_model` from a direct name to the `embedding` alias re-stamps the `embedding_model` column, which triggers a one-time full re-embed of the corpus via the backfill worker (harmless — no data loss, ~16 rows/minute).

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
