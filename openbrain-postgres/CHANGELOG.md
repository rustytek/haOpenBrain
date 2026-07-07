# Changelog

## 1.1.0

- **Schema migration system**: numbered migrations in `/migrations` tracked in a `schema_migrations` table. Existing databases are migrated automatically during add-on startup; fresh installs converge to the same schema. `init.sql` is now the frozen v1 baseline — all future schema changes ship as migrations.
- **Migration 001**: `embedding_model` column on `thoughts` (enables safe embedding-model swaps + offline capture backfill), HNSW vector index replacing ivfflat (better recall, no training-data requirement), `hybrid_search()` Reciprocal Rank Fusion function, `upsert_thought()` v2 accepting NULL embeddings and a model tag, partial index on pending rows.
- **Migration 002**: `wiki_pages` (compiled knowledge layer), `ops_log` (append-only provenance trail), `app_state` (durable KV for the MCP server).
- **Backup integration**: `backup: hot` with a `backup_pre` hook that runs `pg_dump` to `/data/backup/openbrain.sql`, so every Home Assistant backup contains a consistent, restore-anywhere logical dump.

## 1.0.4

- Initial release: PostgreSQL 16 + pgvector, internal-network-only, thoughts schema with dedup upsert, vector + full-text search functions.
