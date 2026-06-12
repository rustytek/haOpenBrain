# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**openBrain** is a sovereign, local-first knowledge infrastructure system — a private vector database with an MCP (Model Context Protocol) server for personal AI memory. It is built on top of [Nate B. Jones' OB1 project](https://github.com/NateBJones-Projects/OB1) with modifications documented in `openBrainDesign.md`.

The implementation is two custom private HAOS add-ons in this repo:
- `openbrain-postgres/` — PostgreSQL + pgvector add-on
- `openbrain-mcp/` — Deno/TypeScript MCP server add-on
- `repository.yaml` — identifies this repo as a HAOS add-on repository

## Two-Node Architecture

**Node A — Inference & Gateway (Mac M4, 16GB RAM)**
- **LiteLLM** is the only API surface Node B calls. It exposes `qwen3.5-mlx` for logic/metadata extraction and `nomic-embed-text` for local embeddings (768-dim, 8192-token context).
- Local model runtimes on Node A sit behind LiteLLM; the MCP server should never call Ollama or MLX runtime endpoints directly.

**Node B — Storage & MCP Server (Intel NUC running Home Assistant OS / HAOS)**
- **PostgreSQL + pgvector**: custom private HAOS add-on — not the community add-on, to limit data exposure. Postgres port is not exposed to the LAN.
- **MCP Server**: custom private HAOS add-on (Deno/TypeScript, Hono + `@hono/mcp`); connects to the Postgres add-on via its HAOS internal slug hostname, calls back to LiteLLM on Node A for embeddings/metadata extraction. Only the MCP port is exposed to the LAN.

HAOS add-ons are single-container and packaged as `config.yaml` + `Dockerfile` in a GitHub repo — not docker-compose. The two add-ons communicate over the HAOS supervisor internal network.

## Database Schema

Primary table `thoughts`:
- `id`, `content`, `embedding` (vector), `metadata` (JSONB), `content_fingerprint` (SHA-256), `created_at`, `updated_at`
- Vector dimension: **768** (nomic-embed-text output — column must be declared `vector(768)`)
- Metadata JSONB shape: `{ people: string[], action_items: string[], dates_mentioned: string[], topics: string[1-3], type: "observation"|"task"|"idea"|"reference"|"person_note" }`

## MCP Server Tools

| Tool | Description |
|------|-------------|
| `capture_thought` | Receives text → calls LiteLLM for embedding + metadata → upserts to Postgres |
| `search_thoughts` | Hybrid search: cosine similarity (pgvector) + BM25 keyword match |
| `browse_recent` | Chronological list of recent entries |
| `brain_stats` | Counts of thoughts, categories, sources |
| `update_thought` | Revise an existing memory entry; if content changes, re-call LiteLLM to regenerate embedding + metadata |
| `delete_thought` | Remove an obsolete entry |

## Key Design Requirements

- **Deduplication**: SHA-256 `content_fingerprint` + `upsert_thought` function — capturing the same content twice updates rather than duplicates
- **Hybrid search**: Combine pgvector cosine distance with BM25 for precision on specific nouns/keywords
- **Markdown-aware chunking**: Chunk at H1/H2/H3 boundaries and paragraph breaks, not fixed character counts
- **Access key security**: `MCP_ACCESS_KEY` env var; all requests must pass the key via query param (`?key=`) or `x-brain-key` header

## Key Implementation Notes

- **Postgres networking**: No `ports` entry in `openbrain-postgres/config.yaml` — port 5432 is only reachable within the hassio Docker bridge network, never from the LAN.
- **Postgres host discovery**: `openbrain-mcp/run.sh` queries the HAOS Supervisor API at startup to find the Postgres container IP automatically. If that fails, it reads the `postgres_host` option you set manually in the add-on UI.
- **Accept header patch**: `index.ts` injects `Accept: application/json, text/event-stream` on every MCP request — Claude Desktop omits this header, which breaks `StreamableHTTPTransport`.
- **Transport per request**: A new `StreamableHTTPTransport` is created per request and `server.connect(transport)` is called each time — this is the correct stateless HTTP pattern for MCP.
- **Chunking threshold**: `chunkMarkdown()` splits at H1/H2/H3 boundaries and double-newlines when content exceeds 1800 chars. Chunks under 40 chars are dropped.

## Running Locally (for development)

Start Postgres with pgvector:
```
docker run -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=openbrain -e POSTGRES_USER=openbrain \
  -v $(pwd)/openbrain-postgres/init.sql:/docker-entrypoint-initdb.d/01-init.sql \
  -p 5432:5432 pgvector/pgvector:pg16
```

Start the MCP server:
```
cd openbrain-mcp
MCP_ACCESS_KEY=dev LITELLM_URL=http://localhost:4000 POSTGRES_HOST=localhost \
POSTGRES_DB=openbrain POSTGRES_USER=openbrain POSTGRES_PASSWORD=dev \
deno task start
```

## Reference Project

The OB1 setup guide at `https://promptkit.natebjones.com/20260224_uq1_guide_main` and the GitHub repo are the foundation — consult them before implementing anything novel that OB1 may already solve.
