# openBrain — User Instructions

## Architecture Quick Reference

| Node | Hardware | Role |
|------|----------|------|
| **Node A** | Mac M4 (16 GB RAM) | Ollama (embeddings + LLM) + LiteLLM gateway |
| **Node B** | Intel NUC (HAOS) | PostgreSQL + pgvector + MCP server |

---

## 1. Prerequisites

### Node A — Mac

**Ollama** must be running with both required models pulled:

```bash
ollama serve
ollama pull nomic-embed-text   # embeddings (768-dim)
ollama pull deepseek-r1:8b     # metadata extraction (or qwen2.5:14b)
```

**LiteLLM** must be running as an OpenAI-compatible gateway:

```bash
pip install litellm
litellm --model ollama/deepseek-r1:8b --port 4000
```

Verify it's reachable from Node B:
```bash
curl http://<NODE_A_IP>:4000/health
```

### Node B — HAOS (Intel NUC)

Both add-ons must be installed and running (see Section 2).

---

## 2. Installing the HAOS Add-ons

### Step 1 — Add the repository

In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**

Add: `https://github.com/rustytek/openBrain`

### Step 2 — Install and configure OpenBrain Database

1. Find **OpenBrain Database** in the store and install it.
2. In the **Configuration** tab, set:
   - `db_password` — choose a strong password
   - `db_name` — `openbrain` (default)
   - `db_user` — `openbrain` (default)
3. Start the add-on. The database and pgvector schema are initialized automatically on first boot.
4. Note the **IP address** shown in the add-on info panel (needed for the MCP add-on if auto-discovery fails).

> Port 5432 is **not** exposed to your LAN — it is only reachable within the HAOS internal network.

### Step 3 — Install and configure OpenBrain MCP Server

1. Find **OpenBrain MCP Server** in the store and install it.
2. In the **Configuration** tab, set:

   | Option | Value |
   |--------|-------|
   | `mcp_access_key` | A secret key you choose (e.g., `my-brain-key-2026`) |
   | `litellm_url` | `http://<NODE_A_IP>:4000` |
   | `postgres_host` | Leave blank — auto-discovered via HAOS Supervisor API. Set manually only if auto-discovery fails (use the IP from Step 2). |
   | `postgres_port` | `5432` |
   | `postgres_db` | `openbrain` |
   | `postgres_user` | `openbrain` |
   | `postgres_password` | The password you set in Step 2 |

3. Start the add-on. The MCP server listens on **port 8000**.

Verify it's healthy:
```bash
curl http://<NODE_B_IP>:8000/health
# → {"status":"ok"}
```

---

## 3. Connecting Claude Desktop

Add the following to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on Mac):

```json
{
  "mcpServers": {
    "openBrain": {
      "url": "http://<NODE_B_IP>:8000/mcp?key=<YOUR_MCP_ACCESS_KEY>",
      "transport": "http"
    }
  }
}
```

Restart Claude Desktop. The six openBrain tools (`capture_thought`, `search_thoughts`, `browse_recent`, `brain_stats`, `update_thought`, `delete_thought`) will appear in the tools panel.

---

## 4. Connecting Claude Code (CLI)

Add to your project's `.claude/settings.json` or global `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "openBrain": {
      "type": "http",
      "url": "http://<NODE_B_IP>:8000/mcp",
      "headers": {
        "x-brain-key": "<YOUR_MCP_ACCESS_KEY>"
      }
    }
  }
}
```

---

## 5. Available MCP Tools

| Tool | What it does |
|------|-------------|
| `capture_thought` | Save text to memory. Markdown docs are chunked automatically at H1/H2/H3 and paragraph boundaries. Duplicate content is updated, not duplicated. |
| `search_thoughts` | Hybrid search: semantic (pgvector cosine) + keyword (BM25). Params: `query`, optional `limit` (1–50, default 10), `threshold` (0–1, default 0.5). |
| `browse_recent` | List recent entries. Optional `limit` (1–100) and `type` filter (`observation`, `task`, `idea`, `reference`, `person_note`). |
| `brain_stats` | Summary counts by type, top topics, top people mentioned. |
| `update_thought` | Update by UUID. Changing `content` triggers re-embedding and re-extraction automatically. |
| `delete_thought` | Permanently remove an entry by UUID. |

---

## 6. Local Development (no HAOS)

Start Postgres with pgvector:

```bash
docker run \
  -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=openbrain \
  -e POSTGRES_USER=openbrain \
  -v $(pwd)/openbrain-postgres/init.sql:/docker-entrypoint-initdb.d/01-init.sql \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

Start the MCP server:

```bash
cd openbrain-mcp
MCP_ACCESS_KEY=dev \
LITELLM_URL=http://localhost:4000 \
POSTGRES_HOST=localhost \
POSTGRES_DB=openbrain \
POSTGRES_USER=openbrain \
POSTGRES_PASSWORD=dev \
deno task start
```

Test a tool call manually:
```bash
curl -X POST http://localhost:8000/mcp?key=dev \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "brain_stats",
      "arguments": {}
    },
    "id": 1
  }'
```

---

## 7. Telegram Integration

A Telegram bot lets you capture thoughts from your phone via text, **voice notes**, **photos**, and **documents** (PDF, Word, plain text).

### How each input type is handled

| Input | Processing | Stored as |
|-------|-----------|-----------|
| Text message | Direct | The message text |
| Voice note (`.ogg`) | Transcribed locally with `faster-whisper` on Node A | Transcript prefixed with `[voice]` |
| Photo | Described by a vision LLM (`llava` via Ollama) | Description + any visible text, prefixed with `[photo]` |
| Document (PDF / DOCX / TXT / MD) | Text extracted locally | Full document text, chunked automatically by the MCP server |

---

### Step 1 — Create a Telegram bot

Message **@BotFather** on Telegram and run `/newbot`. Copy the **bot token** (`123456789:ABCdef...`).

### Step 2 — Pull the vision model on Node A

The bot uses `llava` to describe photos. Pull it once:

```bash
ollama pull llava
```

### Step 3 — Install Python dependencies on Node A

```bash
pip install python-telegram-bot httpx faster-whisper pypdf python-docx
```

| Package | Purpose |
|---------|---------|
| `python-telegram-bot` | Telegram Bot API |
| `httpx` | Calls the MCP server |
| `faster-whisper` | Local voice transcription (Whisper, runs on CPU/GPU) |
| `pypdf` | PDF text extraction |
| `python-docx` | Word document text extraction |

### Step 4 — Set up files and auto-start

Run this once in Terminal on your Mac Mini. It creates the bot script, a config file you edit once, and a launchd service that starts on login and restarts automatically on crash.

```bash
mkdir -p ~/openbrain

# 1. Create the config file — edit this with your actual values
cat > ~/openbrain/config.env << 'CONF'
MCP_URL=http://REPLACE_NODE_B_IP:8000/mcp
MCP_KEY=REPLACE_YOUR_MCP_ACCESS_KEY
BOT_TOKEN=REPLACE_YOUR_BOT_TOKEN
LITELLM_URL=http://localhost:4000
ALLOWED_USER_IDS=REPLACE_YOUR_TELEGRAM_ID
VISION_MODEL=llava
WHISPER_SIZE=base
CONF

echo "→ Edit ~/openbrain/config.env with your values before continuing."
```

Open `~/openbrain/config.env` in any text editor and fill in the four REPLACE_ values:

| Key | Value |
|-----|-------|
| `MCP_URL` | `http://<NODE_B_IP>:8000/mcp` |
| `MCP_KEY` | The `mcp_access_key` from the HAOS add-on config |
| `BOT_TOKEN` | The token from @BotFather |
| `ALLOWED_USER_IDS` | Your numeric Telegram ID (message @userinfobot to get it) |

Then run this to create the launcher and register the service:

```bash
# 2. Wrapper script that loads config and starts the bot
cat > ~/openbrain/run_bot.sh << 'RUN'
#!/bin/bash
set -a
source "$(dirname "$0")/config.env"
set +a
exec /opt/homebrew/bin/python3 "$(dirname "$0")/telegram_brain_bot.py"
RUN
chmod +x ~/openbrain/run_bot.sh

# 3. launchd plist — auto-start on login, restart on crash
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

# 4. Start it now
launchctl load ~/Library/LaunchAgents/com.openbrain.telegrambot.plist
echo "Bot service loaded. Check logs: tail -f ~/Library/Logs/openbrain-telegram.log"
```

**Useful commands after setup:**

```bash
# View live logs
tail -f ~/Library/Logs/openbrain-telegram.log

# Restart after editing config.env
launchctl unload ~/Library/LaunchAgents/com.openbrain.telegrambot.plist
launchctl load  ~/Library/LaunchAgents/com.openbrain.telegrambot.plist

# Stop permanently
launchctl unload ~/Library/LaunchAgents/com.openbrain.telegrambot.plist
```

### Step 5 — Create `telegram_brain_bot.py`

Save this file to `~/openbrain/telegram_brain_bot.py`:

```python
import os, base64, tempfile, json, httpx
from faster_whisper import WhisperModel
from pypdf import PdfReader
from docx import Document as DocxDocument
from telegram import Update
from telegram.ext import (
    ApplicationBuilder, CommandHandler, MessageHandler, filters, ContextTypes
)

# ── Config ────────────────────────────────────────────────────────────────────

MCP_URL     = os.environ["MCP_URL"]       # http://<NODE_B_IP>:8000/mcp
MCP_KEY     = os.environ["MCP_KEY"]       # your mcp_access_key
BOT_TOKEN   = os.environ["BOT_TOKEN"]     # from BotFather
LITELLM_URL = os.environ["LITELLM_URL"]   # http://localhost:4000
VISION_MODEL = os.environ.get("VISION_MODEL", "llava")
WHISPER_SIZE = os.environ.get("WHISPER_SIZE", "base")  # tiny/base/small/medium
ALLOWED_IDS = (
    set(map(int, os.environ["ALLOWED_USER_IDS"].split(",")))
    if os.environ.get("ALLOWED_USER_IDS") else set()
)

MCP_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "x-brain-key": MCP_KEY,
}

def _parse_mcp_response(r: httpx.Response) -> dict:
    content_type = r.headers.get("content-type", "")
    if "text/event-stream" in content_type:
        for line in r.text.splitlines():
            if line.startswith("data:"):
                payload = line[5:].strip()
                if payload and payload != "[DONE]":
                    return json.loads(payload)
        raise RuntimeError(f"No usable data in SSE response (status={r.status_code})")
    if not r.content:
        raise RuntimeError(f"Empty response from MCP server (status={r.status_code})")
    return r.json()

# Load Whisper model once at startup (downloads on first run, ~150 MB for base)
whisper = WhisperModel(WHISPER_SIZE, device="cpu", compute_type="int8")

# ── Helpers ───────────────────────────────────────────────────────────────────

def _authorized(update: Update) -> bool:
    if not ALLOWED_IDS:
        return True
    return update.effective_user.id in ALLOWED_IDS

def _capture(content: str) -> str:
    body = {
        "jsonrpc": "2.0", "id": 1,
        "method": "tools/call",
        "params": {"name": "capture_thought", "arguments": {"content": content}},
    }
    r = httpx.post(MCP_URL, json=body, headers=MCP_HEADERS, timeout=60)
    r.raise_for_status()
    data = _parse_mcp_response(r)
    if "error" in data:
        raise RuntimeError(data["error"]["message"])
    return data["result"]["content"][0]["text"]

def _search(query: str, limit: int = 5) -> str:
    body = {
        "jsonrpc": "2.0", "id": 1,
        "method": "tools/call",
        "params": {"name": "search_thoughts", "arguments": {"query": query, "limit": limit}},
    }
    r = httpx.post(MCP_URL, json=body, headers=MCP_HEADERS, timeout=30)
    r.raise_for_status()
    return _parse_mcp_response(r)["result"]["content"][0]["text"]

def _rpc_simple(tool: str, args: dict) -> str:
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": tool, "arguments": args}}
    r = httpx.post(MCP_URL, json=body, headers=MCP_HEADERS, timeout=30)
    r.raise_for_status()
    return _parse_mcp_response(r)["result"]["content"][0]["text"]

def _transcribe(audio_path: str) -> str:
    segments, _ = whisper.transcribe(audio_path, beam_size=5)
    return " ".join(s.text.strip() for s in segments)

def _describe_image(image_bytes: bytes, mime: str = "image/jpeg") -> str:
    b64 = base64.b64encode(image_bytes).decode()
    payload = {
        "model": VISION_MODEL,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text",
                 "text": "Describe this image in detail. Extract and quote any visible text exactly."},
                {"type": "image_url",
                 "image_url": {"url": f"data:{mime};base64,{b64}"}},
            ],
        }],
    }
    r = httpx.post(f"{LITELLM_URL}/chat/completions", json=payload,
                   headers={"Content-Type": "application/json"}, timeout=60)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]

def _extract_document(file_bytes: bytes, filename: str) -> str:
    name = filename.lower()
    if name.endswith(".pdf"):
        reader = PdfReader(__import__("io").BytesIO(file_bytes))
        return "\n\n".join(p.extract_text() or "" for p in reader.pages).strip()
    if name.endswith(".docx"):
        doc = DocxDocument(__import__("io").BytesIO(file_bytes))
        return "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())
    # Plain text / markdown / anything else
    return file_bytes.decode("utf-8", errors="replace")

async def _download(ctx: ContextTypes.DEFAULT_TYPE, file_id: str) -> bytes:
    tg_file = await ctx.bot.get_file(file_id)
    return await tg_file.download_as_bytearray()

# ── Handlers ──────────────────────────────────────────────────────────────────

async def cmd_search(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not _authorized(update): return
    query = " ".join(ctx.args)
    if not query:
        await update.message.reply_text("Usage: /search <query>")
        return
    await update.message.reply_text(_search(query)[:4000])

async def cmd_recent(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not _authorized(update): return
    await update.message.reply_text(_rpc_simple("browse_recent", {"limit": 10})[:4000])

async def cmd_stats(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not _authorized(update): return
    await update.message.reply_text(_rpc_simple("brain_stats", {}))

async def handle_text(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not _authorized(update): return
    result = _capture(update.message.text)
    await update.message.reply_text(f"Captured: {result}")

async def handle_voice(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not _authorized(update): return
    await update.message.reply_text("Transcribing...")
    data = bytes(await _download(ctx, update.message.voice.file_id))
    with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as f:
        f.write(data)
        path = f.name
    transcript = _transcribe(path)
    os.unlink(path)
    if not transcript.strip():
        await update.message.reply_text("Could not transcribe audio.")
        return
    content = f"[voice] {transcript}"
    result = _capture(content)
    await update.message.reply_text(f"Captured voice note:\n\n{transcript}\n\n{result}")

async def handle_photo(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not _authorized(update): return
    await update.message.reply_text("Analyzing photo...")
    # Telegram gives multiple sizes — take the largest
    photo = sorted(update.message.photo, key=lambda p: p.file_size)[-1]
    data = bytes(await _download(ctx, photo.file_id))
    caption = update.message.caption or ""
    description = _describe_image(data)
    content = f"[photo] {description}"
    if caption:
        content = f"[photo] Caption: {caption}\n\n{description}"
    result = _capture(content)
    await update.message.reply_text(f"Captured photo:\n\n{description[:500]}...\n\n{result}")

async def handle_document(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not _authorized(update): return
    doc = update.message.document
    filename = doc.file_name or "document"
    await update.message.reply_text(f"Processing {filename}...")
    data = bytes(await _download(ctx, doc.file_id))
    try:
        text = _extract_document(data, filename)
    except Exception as e:
        await update.message.reply_text(f"Could not parse document: {e}")
        return
    if not text.strip():
        await update.message.reply_text("Document appears to be empty or image-only.")
        return
    content = f"[document: {filename}]\n\n{text}"
    result = _capture(content)
    word_count = len(text.split())
    await update.message.reply_text(f"Captured {filename} ({word_count} words).\n{result}")

# ── App ───────────────────────────────────────────────────────────────────────

app = ApplicationBuilder().token(BOT_TOKEN).build()
app.add_handler(CommandHandler("search", cmd_search))
app.add_handler(CommandHandler("recent", cmd_recent))
app.add_handler(CommandHandler("stats",  cmd_stats))
app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND,  handle_text))
app.add_handler(MessageHandler(filters.VOICE,                    handle_voice))
app.add_handler(MessageHandler(filters.PHOTO,                    handle_photo))
app.add_handler(MessageHandler(filters.Document.ALL,             handle_document))

print("openBrain Telegram bot running...")
app.run_polling()
```

### Bot Commands

| Input | What happens |
|-------|-------------|
| Any text | Captured directly |
| Voice note | Transcribed locally → captured with `[voice]` prefix |
| Photo | Described by LLaVA vision model → captured with `[photo]` prefix |
| Document (PDF / DOCX / TXT / MD) | Text extracted → captured with `[document: filename]` prefix |
| `/search <query>` | Searches memory, returns top 5 results |
| `/recent` | Lists 10 most recent thoughts |
| `/stats` | Counts, top topics, top people |

### Notes on document types

- **PDF**: text-layer extraction only. Scanned PDFs (image-only) will return empty — photograph those pages instead and send as a photo.
- **DOCX**: paragraphs only; tables and headers are included, images are skipped.
- **Large documents**: the MCP server chunks automatically at H1/H2/H3 and paragraph boundaries, so you can send entire meeting notes or articles in one shot.

### Security Notes

- Set `ALLOWED_USER_IDS` to your Telegram numeric ID — the bot silently ignores all other senders.
- The bot token grants full bot control; store it in a `.env` file, never in version control.
- Voice and photo processing happens entirely on Node A — no data leaves your local network.
