-- 002: Wiki layer (compiled knowledge pages), operations log, app state KV.

-- ── Wiki pages ────────────────────────────────────────────────────────────────
-- LLM-compiled synthesis articles (Karpathy llm-wiki pattern). `name` is the
-- kebab-case slug used in [[wikilinks]]; `summary` is the one-liner shown in
-- the index so the whole catalog fits in one context window.
CREATE TABLE IF NOT EXISTS wiki_pages (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        UNIQUE NOT NULL,
    title       TEXT        NOT NULL,
    summary     TEXT        NOT NULL DEFAULT '',
    content     TEXT        NOT NULL,
    kind        TEXT        NOT NULL DEFAULT 'concept'
                CHECK (kind IN ('concept', 'entity', 'summary', 'synthesis', 'overview')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS wiki_pages_set_updated_at ON wiki_pages;
CREATE TRIGGER wiki_pages_set_updated_at
    BEFORE UPDATE ON wiki_pages
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_wiki_pages_updated_at ON wiki_pages (updated_at DESC);

-- ── Operations log ────────────────────────────────────────────────────────────
-- Append-only provenance trail (Karpathy log.md / OB1 provenance layer):
-- every capture, update, delete, wiki write, consolidation, export.
CREATE TABLE IF NOT EXISTS ops_log (
    id      BIGSERIAL   PRIMARY KEY,
    ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
    action  TEXT        NOT NULL,
    source  TEXT,
    subject TEXT,
    detail  JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_ops_log_ts ON ops_log (ts DESC);

-- ── App state KV ──────────────────────────────────────────────────────────────
-- Small durable state for the MCP server: telegram update offset,
-- last consolidation watermark, etc.
CREATE TABLE IF NOT EXISTS app_state (
    key        TEXT        PRIMARY KEY,
    value      JSONB       NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
