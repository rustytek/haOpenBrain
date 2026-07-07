#!/bin/bash
# Apply pending SQL migrations from /migrations, tracked in schema_migrations.
# Runs in two contexts:
#   1. Fresh init  — called by /docker-entrypoint-initdb.d/02-migrations.sh while
#      the temporary initdb server is up (unix socket, POSTGRES_USER).
#   2. Existing DB — called by run.sh during the pre-start phase (unix socket).
# Requires: POSTGRES_USER, POSTGRES_DB. Idempotent — safe to run every boot.
set -e

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"
PSQL="psql -v ON_ERROR_STOP=1 --username=${POSTGRES_USER} --dbname=${POSTGRES_DB} --no-psqlrc -q"

$PSQL -c "CREATE TABLE IF NOT EXISTS schema_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);"

for f in "$MIGRATIONS_DIR"/*.sql; do
    [ -e "$f" ] || continue
    name=$(basename "$f")
    applied=$($PSQL -tA -c "SELECT 1 FROM schema_migrations WHERE name = '${name}';")
    if [ "$applied" = "1" ]; then
        echo "INFO: Migration ${name} already applied, skipping."
        continue
    fi
    echo "INFO: Applying migration ${name}..."
    $PSQL --single-transaction -f "$f"
    $PSQL -c "INSERT INTO schema_migrations (name) VALUES ('${name}');"
    echo "INFO: Migration ${name} applied."
done
