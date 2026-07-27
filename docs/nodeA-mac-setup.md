# Node A — Mac Mini Setup (192.168.0.21)

Josh's M4 Mac Mini. Runs local model runtimes behind LiteLLM (OpenAI-compatible gateway), and the Telegram bot.

---

## Hardware & OS

- **Machine**: Apple Mac Mini M4
- **LAN IP**: `192.168.0.21`
- **OS**: macOS
- **Hostname**: `Joshs-Mac-mini`

---

## Homebrew Packages

```bash
brew install ollama postgresql@14 cloudflared python@3.12
```

Key services:

| Service | How it runs | Notes |
|---------|------------|-------|
| Local model runtimes | Manually / on demand | Keep runtime endpoints private to Node A; expose models through LiteLLM |
| `postgresql@14` | `brew services start postgresql@14` | LiteLLM database backend |
| `cloudflared` | Tunnel config (separate) | Exposes LiteLLM externally |

---

## Local Models

```bash
ollama pull nomic-embed-text   # embeddings (768-dim) — used by openBrain, served via the `embedding` alias
ollama pull deepseek-r1:8b     # served via the `knowledge_local_high` alias — openBrain's chat model
ollama pull llava              # vision — used by Telegram bot photo handler
ollama pull qwen2.5-coder:14b
ollama pull gemma3:4b
```

See `aiProxy/litellm-config.yaml` for the full, current model list — this is not exhaustive and drifts out of sync easily; that file is the source of truth.

---

## LiteLLM

### Virtual environment

LiteLLM runs in its own Python venv:

```bash
python3 -m venv ~/litellm-env
~/litellm-env/bin/pip install litellm
```

### Secrets file — `~/.litellm.env`

```bash
LITELLM_MASTER_KEY=<your-litellm-master-key>   # must start with sk-
ANTHROPIC_API_KEY=<your-anthropic-key>
NVIDIA_NIM_API_KEY=<your-nvidia-nim-key>
DEEPSEEK_API_KEY=<your-deepseek-key>
DATABASE_URL=postgresql://localhost/litellm     # Homebrew postgres@14
UI_USERNAME=<admin-username>
UI_PASSWORD=<admin-password>
```

> PostgreSQL@14 must be running before LiteLLM starts. The start script waits for it automatically.

### Config file — `~/litellm-config.yaml`

The full model list (local runtimes + Anthropic + NVIDIA NIM + Groq + Cerebras + OpenRouter + Gemini) is tracked in the **aiProxy repo**, not duplicated here — a stale copy in this doc is exactly what caused openBrain to be misconfigured to call a raw model name directly in the past. See `aiProxy/litellm-config.yaml` (working copy, synced from `~/litellm-config.yaml` on this Mac) and `aiProxy/CLAUDE.md` for the current model list, provider setup, and the full Tier Aliases table.

**openBrain must only ever call LiteLLM tier aliases, never a raw model name or Ollama directly:**

- `embed_model` → `embedding` (resolves to `nomic-embed-text`)
- `chat_model` → `knowledge_local_high` (resolves to the strongest clean local reasoning model — currently `deepseek-r1:8b`; see aiProxy's `knowledge_local_*` tier for the fallback chain)

Do **not** point `chat_model` at `qwen3.5-mlx` / `aLocalModel_qwen3.5-mlx` directly — as of 2026-07-20 that model has a known MLX-engine bug (doesn't reliably stop generating, ties up Ollama for minutes) and was deliberately pulled out of every tier alias for that reason. It's kept in aiProxy's config only for manual/direct debugging calls.

### Start script — `~/litellm-start.sh`

Used by launchd to start LiteLLM (keeps secrets out of the plist):

```bash
#!/bin/bash
set -a
source ~/.litellm.env
set +a

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Wait for PostgreSQL to be ready before starting LiteLLM
for i in $(seq 1 30); do
  /opt/homebrew/bin/pg_isready -q && break
  echo "Waiting for PostgreSQL... ($i/30)"
  sleep 1
done

exec /Users/joshuarust/litellm-env/bin/litellm \
  --config /Users/joshuarust/litellm-config.yaml \
  --port 4000 \
  --host 0.0.0.0
```

### Make LiteLLM auto-start on login

```bash
chmod +x ~/litellm-start.sh

cat > ~/Library/LaunchAgents/com.litellm.server.plist << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.litellm.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$HOME/litellm-start.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/litellm.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/litellm.log</string>
</dict>
</plist>
PLIST

launchctl load ~/Library/LaunchAgents/com.litellm.server.plist
```

---

## Telegram Bot

### Python version

Uses the system Python 3.9 from CommandLineTools:
```
/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9
```

### Dependencies

```bash
pip3 install python-telegram-bot httpx faster-whisper pypdf python-docx
```

| Package | Version | Purpose |
|---------|---------|---------|
| `python-telegram-bot` | 22.5 | Telegram Bot API |
| `httpx` | 0.28.1 | HTTP client for MCP server calls |
| `faster-whisper` | 1.2.1 | Local voice transcription |
| `pypdf` | 6.10.2 | PDF text extraction |
| `python-docx` | 1.2.0 | Word document text extraction |

### Bot files — `~/openbrain/`

| File | Purpose |
|------|---------|
| `telegram_brain_bot.py` | Main bot script |
| `config.env` | Runtime secrets (loaded by run_bot.sh) |
| `run_bot.sh` | Wrapper that waits for network then launches bot |

### `~/openbrain/config.env`

```bash
MCP_URL=http://192.168.0.156:8000/mcp
MCP_KEY=<your-mcp-access-key>
BOT_TOKEN=<your-telegram-bot-token>
LITELLM_URL=http://192.168.0.21:4000
ALLOWED_USER_IDS=<your-telegram-numeric-id>
VISION_MODEL=llava
WHISPER_SIZE=base
```

### `~/openbrain/run_bot.sh`

```bash
#!/bin/bash
set -a
source "$(dirname "$0")/config.env"
set +a

echo "Waiting for network..."
until /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9 -c "import socket; socket.getaddrinfo('api.telegram.org', 443)" 2>/dev/null; do
    sleep 5
done
echo "Network ready, starting bot."

exec /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9 "$(dirname "$0")/telegram_brain_bot.py"
```

### launchd service — auto-start on login

```bash
cat > ~/Library/LaunchAgents/com.openbrain.telegrambot.plist << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.openbrain.telegrambot</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$HOME/openbrain/run_bot.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/openbrain-telegram.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/openbrain-telegram.log</string>
</dict>
</plist>
PLIST

launchctl load ~/Library/LaunchAgents/com.openbrain.telegrambot.plist
```

**Useful commands:**

```bash
# View live bot logs
tail -f ~/Library/Logs/openbrain-telegram.log

# View live LiteLLM logs
tail -f ~/Library/Logs/litellm.log

# Restart bot after editing config.env
launchctl unload ~/Library/LaunchAgents/com.openbrain.telegrambot.plist
launchctl load  ~/Library/LaunchAgents/com.openbrain.telegrambot.plist

# Restart LiteLLM
launchctl unload ~/Library/LaunchAgents/com.litellm.server.plist
launchctl load  ~/Library/LaunchAgents/com.litellm.server.plist
```

---

## Cloudflared Tunnel

LiteLLM is exposed externally via a Cloudflare tunnel. Configured separately via `cloudflared tunnel` — see Cloudflare dashboard for tunnel details.

---

## Startup Order on Boot

1. `postgresql@14` — starts automatically via `brew services`
2. `litellm` — waits for Postgres, then starts (launchd)
3. Local model runtimes - start manually or add launchd plists before relying on LiteLLM aliases
4. Telegram bot — waits for network, then starts (launchd)
