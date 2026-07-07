# OpenBrain Database

Private PostgreSQL 16 + pgvector instance for OpenBrain. **Port 5432 is intentionally not exposed to the LAN** — only add-ons on the Home Assistant internal network (i.e. the OpenBrain MCP Server) can reach it.

## Configuration

| Option | Description |
|---|---|
| `db_password` | Database password. Change it from the default; the running database syncs the password on restart, no data wipe needed. |
| `db_name` | Database name (default `openbrain`). |
| `db_user` | Database user (default `openbrain`). |

## Schema migrations

Schema changes ship as numbered SQL files applied automatically at startup and tracked in the `schema_migrations` table. You don't need to do anything on update — watch the add-on log for `Applying migration ...` lines. `init.sql` runs only on a brand-new database.

## Backups

Every Home Assistant backup of this add-on triggers a `pg_dump` to `/data/backup/openbrain.sql` first (see `backup_pre`), so the backup contains both the raw data directory and a portable logical dump. To restore the dump elsewhere:

```
psql -U openbrain -d openbrain -f openbrain.sql
```

## Finding the database from other add-ons

The MCP add-on auto-discovers this container's IP via the Supervisor API. If discovery fails, this add-on logs its internal IP at startup (`OpenBrain Postgres internal IP: ...`) — set that as `postgres_host` in the MCP add-on configuration.
