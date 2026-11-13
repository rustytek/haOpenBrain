# Changelog

## 1.2.0

**Update this add-on before (or together with) OpenBrain MCP Server 1.3.0**, which needs migration 003 and waits for it at startup.

- **Migration 003** (applied automatically on start; additive, nothing is rewritten or removed):
  - **Supersession**: `thoughts.superseded_by / superseded_at / superseded_note`. An outdated thought is kept and points at its replacement. Deleting the replacement makes the older thought current again.
  - **Unified, filtered search**: new `brain_search()` ranks thoughts and wiki pages in one list (RRF of vector and keyword ranks) with filters for type, person, topic, source and date, and leaves superseded thoughts out unless asked. `hybrid_search()` is unchanged and still present.
  - **Wiki pages** gain `embedding` / `embedding_model` (so pages are searchable) and `sources` (the thought ids a page was compiled from).
  - **`thought_conflicts`**: review queue for "this newer thought may make that older one outdated" proposals.
  - **`eval_cases` / `eval_runs`**: retrieval test set and its run history.
  - **`updated_at` now changes only when content or metadata change.** Before, any update bumped it, so a background re-embed made every thought look new to the wiki consolidator and reset the stale-page clock.

## 1.1.1

- **Migration failures no longer crash the container.** `run.sh` ran the migration step under `set -e` with no failure guard — if a migration errored for any reason, the whole script aborted *before* starting the real Postgres server, leaving the port closed with no explanation (the MCP add-on would just see "connection refused" forever). A migration failure is now logged loudly (the SQL error plus a clear `ERROR:` banner) but the database still starts, so it stays reachable for diagnosis instead of crash-looping silently.

## 1.1.0

- **Schema migration system**: numbered migrations in `/migrations` tracked in a `schema_migrations` table. Existing databases are migrated automatically during add-on startup; fresh installs converge to the same schema. `init.sql` is now the frozen v1 baseline — all future schema changes ship as migrations.
- **Migration 001**: `embedding_model` column on `thoughts` (enables safe embedding-model swaps + offline capture backfill), HNSW vector index replacing ivfflat (better recall, no training-data requirement), `hybrid_search()` Reciprocal Rank Fusion function, `upsert_thought()` v2 accepting NULL embeddings and a model tag, partial index on pending rows.
- **Migration 002**: `wiki_pages` (compiled knowledge layer), `ops_log` (append-only provenance trail), `app_state` (durable KV for the MCP server).
- **Backup integration**: `backup: hot` with a `backup_pre` hook that runs `pg_dump` to `/data/backup/openbrain.sql`, so every Home Assistant backup contains a consistent, restore-anywhere logical dump.

## 1.0.4

- Initial release: PostgreSQL 16 + pgvector, internal-network-only, thoughts schema with dedup upsert, vector + full-text search functions.
