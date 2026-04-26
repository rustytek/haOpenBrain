#!/bin/bash
set -e

# Read credentials from HAOS options
if [ -f /data/options.json ]; then
    export POSTGRES_PASSWORD=$(jq -r '.db_password' /data/options.json)
    export POSTGRES_DB=$(jq -r '.db_name'     /data/options.json)
    export POSTGRES_USER=$(jq -r '.db_user'     /data/options.json)
fi

# Log this container's internal IP — set this as postgres_host in the MCP add-on
# if auto-discovery fails
CONTAINER_IP=$(hostname -I | awk '{print $1}')
echo "INFO: OpenBrain Postgres internal IP: ${CONTAINER_IP}"

# Ensure data directory exists and is owned by postgres before anything else
mkdir -p "$PGDATA"
chown -R postgres:postgres "$(dirname "$PGDATA")"

# On an existing database, sync the password from current options so it can be
# changed without wiping data. Local socket uses trust auth — no password needed.
if [ -d "$PGDATA/global" ]; then
    echo "INFO: Syncing credentials for user '${POSTGRES_USER}'..."
    gosu postgres pg_ctl -D "$PGDATA" -o "-c listen_addresses=''" -w start
    gosu postgres psql --username=postgres \
        -c "ALTER USER \"${POSTGRES_USER}\" WITH PASSWORD '${POSTGRES_PASSWORD}';" \
        && echo "INFO: Password synced for '${POSTGRES_USER}'." \
        || echo "WARN: Could not sync — user '${POSTGRES_USER}' may not exist yet (will be created on first init)."
    gosu postgres pg_ctl -D "$PGDATA" -w stop
fi

exec docker-entrypoint.sh postgres \
    -c listen_addresses='*' \
    -c log_min_duration_statement=2000
