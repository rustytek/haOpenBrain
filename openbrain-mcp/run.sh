#!/bin/sh
set -e

# Read HAOS options
MCP_ACCESS_KEY=$(jq -r  '.mcp_access_key'   /data/options.json)
LITELLM_URL=$(jq -r     '.litellm_url'      /data/options.json)
LITELLM_API_KEY=$(jq -r '.litellm_api_key // ""' /data/options.json)
EMBED_MODEL=$(jq -r     '.embed_model'      /data/options.json)
CHAT_MODEL=$(jq -r      '.chat_model'       /data/options.json)
POSTGRES_PORT=$(jq -r   '.postgres_port // 5432' /data/options.json)
POSTGRES_DB=$(jq -r     '.postgres_db'      /data/options.json)
POSTGRES_USER=$(jq -r   '.postgres_user'    /data/options.json)
POSTGRES_PASSWORD=$(jq -r '.postgres_password' /data/options.json)
CONFIGURED_HOST=$(jq -r '.postgres_host // ""' /data/options.json)
TELEGRAM_BOT_TOKEN=$(jq -r '.telegram_bot_token // ""' /data/options.json)
TELEGRAM_ALLOWED_USER_IDS=$(jq -r '(.telegram_allowed_user_ids // []) | map(tostring) | join(",")' /data/options.json)

# Auto-discover Postgres IP via HAOS Supervisor API (best-effort)
POSTGRES_HOST=""
if [ -n "${SUPERVISOR_TOKEN:-}" ]; then
    POSTGRES_HOST=$(curl -sf \
        -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
        "http://supervisor/addons/openbrain_postgres/info" 2>/dev/null | \
        jq -r '.data.ip_address // empty' 2>/dev/null)
    if [ -n "$POSTGRES_HOST" ] && [ "$POSTGRES_HOST" != "null" ]; then
        echo "INFO: Auto-discovered Postgres IP: ${POSTGRES_HOST}"
    else
        echo "WARN: Supervisor auto-discovery returned nothing, falling back to postgres_host option."
        POSTGRES_HOST=""
    fi
fi

# Fall back to the value configured in add-on options
if [ -z "$POSTGRES_HOST" ] || [ "$POSTGRES_HOST" = "null" ]; then
    POSTGRES_HOST="$CONFIGURED_HOST"
fi

if [ -z "$POSTGRES_HOST" ]; then
    echo "ERROR: Cannot determine Postgres host." >&2
    echo "Set postgres_host in the MCP add-on config to the IP shown in the OpenBrain Database logs." >&2
    exit 1
fi

echo "INFO: Connecting to Postgres at ${POSTGRES_HOST}:${POSTGRES_PORT}"

export MCP_ACCESS_KEY LITELLM_URL LITELLM_API_KEY EMBED_MODEL CHAT_MODEL POSTGRES_HOST POSTGRES_PORT \
       POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USER_IDS

# /share is mapped for export_brain markdown output
exec deno run --allow-net --allow-env --allow-read=/share --allow-write=/share /app/src/index.ts
