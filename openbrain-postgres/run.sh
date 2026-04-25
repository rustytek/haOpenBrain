#!/bin/bash
set -e

# Read credentials from HAOS options
if [ -f /data/options.json ]; then
    export POSTGRES_PASSWORD=$(jq -r '.db_password' /data/options.json)
    export POSTGRES_DB=$(jq -r '.db_name'     /data/options.json)
    export POSTGRES_USER=$(jq -r '.db_user'     /data/options.json)
fi

# Ensure data directory exists and is owned by postgres before handoff
mkdir -p "$PGDATA"
chown -R postgres:postgres "$(dirname "$PGDATA")"

exec docker-entrypoint.sh postgres \
    -c listen_addresses='*' \
    -c log_min_duration_statement=2000
