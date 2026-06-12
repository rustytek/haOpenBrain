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
ollama pull nomic-embed-text   # embeddings (768-dim) — used by openBrain
ollama pull qwen3.5:9b-mlx     # MLX chat model served behind LiteLLM as qwen3.5-mlx
ollama pull llava              # vision — used by Telegram bot photo handler
ollama pull qwen35-moe         # general chat
ollama pull qwen2.5-coder:14b
ollama pull gemma3:4b
ollama pull qwen3-vl:8b
ollama pull llama3.2-vision:11b
```

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

Full model list (local runtimes + Anthropic + NVIDIA NIM + DeepSeek cloud). openBrain should use LiteLLM aliases only:

```yaml
model_list:

  # LiteLLM alias used by openBrain metadata extraction
  - model_name: qwen3.5-mlx
    litellm_params:
      model: ollama_chat/qwen3.5:9b-mlx
      api_base: http://localhost:11434
      timeout: 300

  # Ollama-backed aliases exposed only through LiteLLM
  - model_name: qwen35-moe_chat
    litellm_params:
      model: ollama_chat/qwen35-moe:latest
      api_base: http://localhost:11434
      timeout: 180

  - model_name: gpt-3.5-turbo          # OpenAI-compat alias
    litellm_params:
      model: ollama_chat/qwen35-moe:latest
      api_base: http://localhost:11434
      timeout: 180

  - model_name: qwen35-moe_chat-fast
    litellm_params:
      model: ollama_chat/qwen3.5:9b
      api_base: http://localhost:11434
      timeout: 60

  # Ollama: Embeddings (used by openBrain)
  - model_name: nomic-embed-text
    litellm_params:
      model: ollama/nomic-embed-text:latest
      api_base: http://localhost:11434

  - model_name: embeddings
    litellm_params:
      model: ollama/nomic-embed-text:latest
      api_base: http://localhost:11434

  - model_name: text-embedding-ada-002  # OpenAI-compat alias
    litellm_params:
      model: ollama/nomic-embed-text:latest
      api_base: http://localhost:11434

  # Ollama: Coding
  - model_name: qwen2.5-coder_14b_coding
    litellm_params:
      model: ollama_chat/qwen2.5-coder:14b
      api_base: http://localhost:11434
      timeout: 180

  - model_name: gpt-4                  # OpenAI-compat alias
    litellm_params:
      model: ollama_chat/qwen2.5-coder:14b
      api_base: http://localhost:11434
      timeout: 180


  # Ollama: Fast / lightweight
  - model_name: gemma3_4b_fast
    litellm_params:
      model: ollama_chat/gemma3:4b
      api_base: http://localhost:11434
      timeout: 60

  # Ollama: Vision (used by Telegram bot photo handler)
  - model_name: qwen3-vl_8b_vision
    litellm_params:
      model: ollama_chat/qwen3-vl:8b
      api_base: http://localhost:11434
      timeout: 120

  - model_name: llama3.2-vision_11b_vision-pro
    litellm_params:
      model: ollama_chat/llama3.2-vision:11b
      api_base: http://localhost:11434
      timeout: 120

  # Anthropic
  - model_name: claude-opus
    litellm_params:
      model: anthropic/claude-opus-4-6
      api_key: os.environ/ANTHROPIC_API_KEY

  - model_name: claude-sonnet
    litellm_params:
      model: anthropic/claude-sonnet-4-6
      api_key: os.environ/ANTHROPIC_API_KEY

  - model_name: claude-haiku
    litellm_params:
      model: anthropic/claude-haiku-4-5-20251001
      api_key: os.environ/ANTHROPIC_API_KEY

  - model_name: claude-fallback
    litellm_params:
      model: anthropic/claude-haiku-4-5-20251001
      api_key: os.environ/ANTHROPIC_API_KEY

  # NVIDIA NIM
  - model_name: nim-llama_70b_instruct
    litellm_params:
      model: openai/meta/llama-3.1-70b-instruct
      api_base: https://integrate.api.nvidia.com/v1
      api_key: os.environ/NVIDIA_NIM_API_KEY
      timeout: 120

  - model_name: nim-nemotron_70b
    litellm_params:
      model: openai/nvidia/llama-3.1-nemotron-70b-instruct
      api_base: https://integrate.api.nvidia.com/v1
      api_key: os.environ/NVIDIA_NIM_API_KEY
      timeout: 120

  - model_name: nim-qwen_72b
    litellm_params:
      model: openai/qwen/qwen2.5-72b-instruct
      api_base: https://integrate.api.nvidia.com/v1
      api_key: os.environ/NVIDIA_NIM_API_KEY
      timeout: 120

  # DeepSeek Cloud
  - model_name: deepseek-chat
    litellm_params:
      model: deepseek/deepseek-chat
      api_key: os.environ/DEEPSEEK_API_KEY
      timeout: 180

  - model_name: deepseek-reasoner
    litellm_params:
      model: deepseek/deepseek-reasoner
      api_key: os.environ/DEEPSEEK_API_KEY
      timeout: 300

router_settings:
  routing_strategy: simple-shuffle
  num_retries: 2
  timeout: 60
  fallbacks:
    - {"chat": ["claude-fallback"]}
    - {"gpt-3.5-turbo": ["claude-fallback"]}
    - {"coding": ["claude-fallback"]}
    - {"gpt-4": ["claude-fallback"]}
    - {"qwen3.5-mlx": ["deepseek-reasoner"]}
    - {"fast": ["claude-haiku"]}

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  ui_username: os.environ/UI_USERNAME
  ui_password: os.environ/UI_PASSWORD
  database_url: os.environ/DATABASE_URL

litellm_settings:
  success_callback: []
  failure_callback: []
  request_timeout: 180
  telemetry: False
```

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
