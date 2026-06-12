# Node B — HAOS NUC Setup (192.168.0.156)

Intel NUC running Home Assistant OS. Hosts the PostgreSQL + pgvector database and the openBrain MCP server as private HAOS add-ons.

---

## Hardware & OS

- **Machine**: Intel NUC
- **LAN IP**: `192.168.0.156`
- **OS**: Home Assistant OS (HAOS)
- **HAOS Add-on repository**: `https://github.com/rustytek/haOpenBrain`

---

## Add-on Repository

In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**

Add: `https://github.com/rustytek/haOpenBrain`

---

## OpenBrain Database Add-on

**Version**: 1.0.4  
**Slug**: `openbrain_postgres`  
**Internal IP** (Docker bridge): `172.30.33.11`  
Port 5432 is **not** exposed to the LAN — internal hassio network only.

### Configuration

| Option | Value |
|--------|-------|
| `db_name` | `openbrain` |
| `db_user` | `rusty` |
| `db_password` | `<your-db-password>` |

### Notes

- The database user (`db_user`) is created as the Postgres superuser on first init. It cannot be changed after first boot without wiping `/data`.
- The add-on syncs the password from `db_password` on every restart, so you can change the password from the UI without wiping data.
- The internal container IP (`172.30.33.11`) is logged at startup: `INFO: OpenBrain Postgres internal IP: ...`
- Auto-discovery of the Postgres IP from the MCP add-on via Supervisor API is attempted but currently falls back to the manually configured `postgres_host`. This is normal.

### Database Schema

Managed by `/docker-entrypoint-initdb.d/01-init.sql` (runs only on first boot):

- Extension: `pgvector`
- Table: `thoughts` — `id`, `content`, `embedding vector(768)`, `metadata jsonb`, `content_fingerprint`, `created_at`, `updated_at`
- Functions: `upsert_thought`, `match_thoughts` (cosine search), `search_thoughts_text` (BM25 keyword search)

---

## OpenBrain MCP Server Add-on

**Version**: 1.0.8  
**Slug**: `openbrain_mcp`  
**Port**: `8000` (exposed to LAN)  
**Runtime**: Deno / TypeScript (Hono + `@hono/mcp`)

### Configuration

| Option | Value |
|--------|-------|
| `mcp_access_key` | `<your-mcp-access-key>` |
| `litellm_url` | `http://192.168.0.21:4000` |
| `litellm_api_key` | `<your-litellm-master-key>` |
| `embed_model` | `nomic-embed-text` |
| `chat_model` | `qwen3.5-mlx` |
| `postgres_host` | `172.30.33.11` |
| `postgres_port` | `5432` |
| `postgres_db` | `openbrain` |
| `postgres_user` | `rusty` |
| `postgres_password` | `<your-db-password>` |

### Checking available models

On restart, the MCP server logs all models available in LiteLLM:

```
LiteLLM models available: nomic-embed-text, qwen3.5-mlx, ...
Using embed_model="nomic-embed-text" chat_model="qwen3.5-mlx"
```

To change models: update `embed_model` or `chat_model` in the Configuration tab and restart the add-on.

### MCP Tools

| Tool | Description |
|------|-------------|
| `capture_thought` | Save text; auto-chunks large markdown docs |
| `search_thoughts` | Hybrid semantic (pgvector) + keyword (BM25) search |
| `browse_recent` | Recent entries, optionally filtered by type |
| `brain_stats` | Counts by type, top topics, top people |
| `update_thought` | Update by UUID; re-embeds if content changes |
| `delete_thought` | Delete by UUID |

### Authentication

All requests to `/mcp` require one of:
- Header: `x-brain-key: <mcp_access_key>`
- Query param: `?key=<mcp_access_key>`

### Health check

```bash
curl http://192.168.0.156:8000/health
# → {"status":"ok"}
```

### Manual tool call (curl)

```bash
curl -X POST http://192.168.0.156:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-brain-key: <your-mcp-access-key>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"brain_stats","arguments":{}}}'
```

---

## Connecting Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openBrain": {
      "url": "http://192.168.0.156:8000/mcp?key=<your-mcp-access-key>",
      "transport": "http"
    }
  }
}
```

## Connecting Claude Code (CLI)

Add to `~/.claude/settings.json` or `.claude/settings.json`:

```json
{
  "mcpServers": {
    "openBrain": {
      "type": "http",
      "url": "http://192.168.0.156:8000/mcp",
      "headers": {
        "x-brain-key": "<your-mcp-access-key>"
      }
    }
  }
}
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| MCP health returns 404 | Add-on not running | Start OpenBrain MCP Server in HAOS |
| `password authentication failed` | Credential mismatch | Ensure `postgres_user`/`postgres_password` in MCP config matches `db_user`/`db_password` in Database config |
| `Name or service not known` | Wrong `postgres_host` format | Set to bare IP only (e.g. `172.30.33.11`), no `http://` prefix |
| `Embedding failed: 400` | Model alias missing or misconfigured in LiteLLM | Check `/models` on Node A and ensure `nomic-embed-text` is registered in `~/litellm-config.yaml` |
| `Embedding failed: 401` | Wrong LiteLLM API key | Check `litellm_api_key` matches `LITELLM_MASTER_KEY` in `~/.litellm.env` |
| `Connection refused` on port 4000 | LiteLLM not running | Start LiteLLM on Node A |
