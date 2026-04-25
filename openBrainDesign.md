```markdown
# Open Brain System Architecture Blueprint 

**Project Overview:** 
Build a Sovereign "Open Brain" knowledge infrastructure layer. This system completely decouples cognitive memory from any specific SaaS platform, creating a private, local-first vector database and an MCP (Model Context Protocol) server. The environment is split between a local Mac (handling AI inference) and a remote Intel NUC (handling storage and the MCP interface).
This project is build upon Nate B. Jones Open brain (https://github.com/NateBJones-Projects/OB1 and https://promptkit.natebjones.com/20260224_uq1_guide_main).  Please reference the github repo and the setup guide as a foundation for the design with my modifications listed below.

## 1. Node A: Inference & Gateway (Apple Mac M4, 16GB RAM)
This node is responsible for generating embeddings, extracting metadata, and serving the AI models locally to preserve 100% data privacy.

*   **Inference Engine (Ollama):** 
    *   Run **DeepSeek 8B** (or Qwen 2.5 14B) for logic, metadata extraction, and chat.
    *   Run **`nomic-embed-text`** for local vector embeddings. It is lightweight (~300MB), supports an 8192-token context window, and is highly optimized for Retrieval-Augmented Generation (RAG).
*   **AI Gateway (LiteLLM):**
    *   Acts as the universal AI API gateway, replacing cloud services like OpenRouter. 
    *   Translates Ollama's local endpoints into a standard OpenAI-compatible REST API, allowing the remote MCP server to request embeddings and metadata extractions seamlessly without complex custom integrations.

## 2. Node B: Storage & MCP Server (Intel NUC / HAOS)
This node hosts the persistent memory layer via Docker containers running on Home Assistant OS (HAOS). 

*   **Database Container (PostgreSQL + pgvector):**
    *   **Core Engine:** PostgreSQL handles the structured metadata (dates, tags, people).
    *   **Semantic Engine:** The `pgvector` extension must be enabled to store 1536-dimensional or 768-dimensional vectors (depending on the exact embedding model output) and execute cosine similarity searches.
    *   **Schema Requirements:** The primary `thoughts` table must include columns for `id`, `content`, `embedding`, `metadata`, `content_fingerprint`, `created_at`, and `updated_at`.
*   **MCP Server Container (Node.js / Python):**
    *   Exposes a standardized Model Context Protocol interface.
    *   **Core Tools to Implement:**
        *   `capture_thought`: Receives raw text, calls LiteLLM on the Mac to generate an embedding and extract metadata, and writes the row to Postgres.
        *   `search_thoughts`: Takes a user query, generates a query embedding, and uses cosine similarity via `pgvector` to return relevant context.
        *   `browse_recent`: Returns a chronological list of recent entries.
        *   `brain_stats`: Returns quantitative counts of thoughts, categories, and sources.
        *   `update_thought` & `delete_thought`: For revising or removing obsolete memory entries. When `update_thought` modifies the content field, it must re-call LiteLLM to regenerate both the embedding and the extracted metadata — stale vectors would silently corrupt search results.

## 3. Recommended Design Additions & Optimizations

To ensure this architecture is resilient, accurate, and secure, we should incorporate the following recommendations into the code generation:

*   **Content Fingerprinting (Deduplication):** Implement a SHA-256 hash function to generate a `content_fingerprint` for every captured thought. Add an upsert function (`upsert_thought`) in the database so that capturing the same idea twice updates the existing record rather than creating a duplicate.
*   **Hybrid Search Implementation:** Pure vector search can sometimes fail on specific nouns or keywords. Design the `search_thoughts` tool to use **Hybrid Retrieval**, combining vector similarity search (cosine distance) with BM25 (keyword exact match) to guarantee high precision.
*   **Markdown-Aware Chunking:** When ingesting larger documents, the MCP server should not use fixed character-count splits. Implement chunking logic that respects Markdown heading boundaries (H1, H2, H3) and paragraph breaks so that each embedded chunk retains complete logical context.
*   **Access Key Security:** Even though the Intel NUC is on your local network, the MCP server must be secured. Implement an environment variable (e.g., `MCP_ACCESS_KEY`) that requires all incoming requests from the Mac to pass a key in the URL (e.g., `?key=your-access-key`) or via a custom header like `x-brain-key`.
*   **HAOS Add-on Packaging:** The Intel NUC runs Home Assistant OS. Docker containers must be packaged as HAOS add-ons (GitHub repo with `config.yaml` + `Dockerfile`) rather than a traditional `docker-compose.yml`. Each add-on is a single container. Both the PostgreSQL/pgvector instance and the MCP server are **custom private add-ons** to limit data exposure — no community add-ons are used for either service. The two add-ons communicate over the HAOS internal supervisor network (the Postgres add-on is reachable from the MCP server add-on via its add-on slug hostname). Only the MCP server port should be exposed to the local LAN; the Postgres port must not be exposed outside the internal network.

---
**Instructions for Agentic IDE:** 
Using the specifications above, please generate: the initial PostgreSQL schema/migration script (including the `pgvector` setup and deduplication functions), and the HAOS add-on boilerplate for the MCP server (config.yaml + Dockerfile + TypeScript/Deno server code exposing the required tools). Postgres uses the existing community HAOS add-on; only the MCP server requires a custom add-on.
```