# OpenBrain MCP Server

MCP server exposing your private OpenBrain memory to AI assistants (Claude Desktop, Claude Code, or anything MCP-capable), plus an optional Telegram capture bot, a Home Assistant REST surface, and an ingress dashboard.

Install and start the **OpenBrain Database** add-on first.

## Configuration options

| Option | Description |
|---|---|
| `mcp_access_key` | Shared secret. Every MCP/REST request must send it as `x-brain-key` header or `?key=` query param. Change it from the default. |
| `litellm_url` | LiteLLM gateway on Node A, e.g. `http://192.168.0.21:4000`. If unreachable, capture still works — embeddings backfill automatically when it returns. |
| `litellm_api_key` | Optional bearer token for LiteLLM. |
| `embed_model` | Embedding model name in LiteLLM (default `nomic-embed-text`). Changing it re-embeds your whole brain in the background — see "Swapping embedding models". |
| `chat_model` | Chat model used for metadata extraction and wiki consolidation (default `qwen3.5-mlx`). |
| `postgres_host` | Leave empty — auto-discovered via the Supervisor. Set only if the log tells you to (use the IP printed by the database add-on). |
| `postgres_port` / `postgres_db` / `postgres_user` / `postgres_password` | Must match the database add-on options. |
| `telegram_bot_token` | Optional. Bot token from @BotFather. Empty = Telegram disabled. |
| `telegram_allowed_user_ids` | List of numeric Telegram user IDs allowed to talk to the bot. **The bot refuses to start if the token is set but this list is empty.** |

## Connecting an AI client (MCP)

Endpoint: `http://<ha-ip>:8000/mcp` with header `x-brain-key: <mcp_access_key>`.

Claude Desktop / Claude Code MCP config:

```json
{
  "mcpServers": {
    "openbrain": {
      "type": "http",
      "url": "http://<ha-ip>:8000/mcp",
      "headers": { "x-brain-key": "<mcp_access_key>" }
    }
  }
}
```

Tools: `capture_thought`, `search_thoughts`, `browse_recent`, `brain_stats`, `update_thought`, `delete_thought`, wiki tools (`get_index`, `read_page`, `write_page`, `delete_page`), `consolidate_brain`, `brain_audit`, `export_brain`.

## Telegram capture bot setup

The bot lets you capture thoughts from your phone with zero extra apps. It is **off by default** and fail-closed: it only listens to the numeric user IDs you allowlist; everyone else is silently ignored.

1. **Create the bot**: message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → pick a display name and a unique username. BotFather replies with a token like `1234567890:AAF...`. Treat it like a password.
2. **Harden it in BotFather** (recommended): send `/setjoingroups` → select your bot → `Disable`, so the bot can never be added to a group. `/setprivacy` → `Enable` is also fine (the bot only acts on private chats regardless).
3. **Find your numeric user ID**: message [@userinfobot](https://t.me/userinfobot) — it replies with your ID (e.g. `123456789`). This is *not* your @username; usernames can be changed and spoofed, IDs cannot.
4. **Configure the add-on**: Settings → Add-ons → OpenBrain MCP Server → Configuration:

   ```yaml
   telegram_bot_token: "1234567890:AAF..."
   telegram_allowed_user_ids:
     - 123456789
   ```

   Save and restart the add-on. The log should show `Telegram bot @yourbot polling; allowlist: 1 user id(s).`
5. **Use it**: open a chat with your bot, send `/start` for help. Any plain text is captured as a thought (source: `telegram`). Commands: `/search <query>`, `/recent [n]`, `/stats`.

Security properties: outbound long-polling only (no webhook, no new LAN port); private chats only; text only; non-allowlisted senders get no reply at all; queued messages older than 10 minutes are dropped at startup; message contents are never written to the log; 20 msg/min rate limit. If the token ever leaks, an attacker still can't read or write your brain without also being on the ID allowlist — but revoke it with BotFather's `/revoke` anyway.

## Home Assistant integration

**Sidebar dashboard**: enabled automatically via ingress — click "OpenBrain" in the HA sidebar for read-only stats, wiki index, recent thoughts, and search.

**Stats sensor** (`configuration.yaml`):

```yaml
rest:
  - resource: http://127.0.0.1:8000/stats.json
    headers:
      x-brain-key: !secret openbrain_key
    scan_interval: 600
    sensor:
      - name: OpenBrain thoughts
        value_template: "{{ value_json.total }}"
      - name: OpenBrain pending embeddings
        value_template: "{{ value_json.pending_embeddings }}"
      - name: OpenBrain wiki pages
        value_template: "{{ value_json.wiki_pages }}"
```

**Capture from automations/Assist**:

```yaml
rest_command:
  openbrain_capture:
    url: http://127.0.0.1:8000/capture
    method: post
    headers:
      x-brain-key: !secret openbrain_key
    content_type: application/json
    payload: '{"content": {{ content | tojson }}, "source": "ha-automation"}'
```

**Nightly wiki consolidation** (recommended — keeps the wiki self-maintaining):

```yaml
rest_command:
  openbrain_consolidate:
    url: http://127.0.0.1:8000/jobs/consolidate
    method: post
    headers:
      x-brain-key: !secret openbrain_key

automation:
  - alias: OpenBrain nightly consolidation
    triggers:
      - trigger: time
        at: "03:00:00"
    actions:
      - action: rest_command.openbrain_consolidate
```

## Swapping embedding models

Rows are stamped with the model that embedded them. If you change `embed_model`, the backfill worker detects the mismatch and re-embeds everything in the background (16 rows/minute) — no data loss, no manual reindex. **Constraint**: the schema is fixed at 768 dimensions, so only 768-dim models are drop-in (e.g. other nomic-embed variants). A different dimension requires a schema migration first.

## Offline behavior (Node A asleep/away)

- `capture_thought` (and Telegram capture) always succeeds — thoughts missing embeddings are marked pending and embedded when LiteLLM returns.
- `search_thoughts` degrades to keyword-only search and says so.
- `brain_stats` / the dashboard show the pending-embedding count.

## Export

Run the `export_brain` tool (from any MCP client) to dump everything as markdown to `/share/openbrain/export` — monthly thought files, one file per wiki page, and an index. Useful as a plain-text escape hatch, an Obsidian import source, or an extra backup layer.
