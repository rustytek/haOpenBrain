#!/bin/sh
set -e

# Read HAOS options
MCP_ACCESS_KEY=$(jq -r  '.mcp_access_key'   /data/options.json)
LITELLM_URL=$(jq -r     '.litellm_url'      /data/options.json)
POSTGRES_PORT=$(jq -r   '.postgres_port // 5432' /data/options.json)
POSTGRES_DB=$(jq -r     '.postgres_db'      /data/options.json)
POSTGRES_USER=$(jq -r   '.postgres_user'    /data/options.json)
POSTGRES_PASSWORD=$(jq -r '.postgres_password' /data/options.json)
CONFIGURED_HOST=$(jq -r '.postgres_host // ""' /data/options.json)

# Auto-discover Postgres IP via HAOS Supervisor API (best-effort)
POSTGRES_HOST=""
if [ -n "${SUPERVISOR_TOKEN:-}" ]; then
    POSTGRES_HOST=$(curl -sf \
        -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
        "http://supervisor/addons" 2>/dev/null | \
        jq -r '.data.addons[]? | select(.slug | contains("openbrain_postgres")) | .ip_address // empty' \
        2>/dev/null | head -1)
fi

# Fall back to the value configured in add-on options
if [ -z "$POSTGRES_HOST" ] || [ "$POSTGRES_HOST" = "null" ]; then
    POSTGRES_HOST="$CONFIGURED_HOST"
fi

if [ -z "$POSTGRES_HOST" ]; then
    echo "ERROR: Cannot determine Postgres host." >&2
    echo "Set the postgres_host option to the IP shown in the OpenBrain Database add-on info panel." >&2
    exit 1
fi

export MCP_ACCESS_KEY LITELLM_URL POSTGRES_HOST POSTGRES_PORT \
       POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD

exec deno run --allow-net --allow-env /app/src/index.ts
