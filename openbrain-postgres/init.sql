-- Runs once on first start (PGDATA empty).
-- Connected to the database defined by POSTGRES_DB.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS thoughts (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    content             TEXT        NOT NULL,
    embedding           vector(768),
    metadata            JSONB       NOT NULL DEFAULT '{}',
    content_fingerprint TEXT        UNIQUE NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ANN index for cosine similarity (rebuild after bulk loads if needed)
CREATE INDEX IF NOT EXISTS idx_thoughts_embedding
    ON thoughts USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_thoughts_metadata
    ON thoughts USING GIN (metadata);

-- Full-text search index
CREATE INDEX IF NOT EXISTS idx_thoughts_fts
    ON thoughts USING GIN (to_tsvector('english', content));

CREATE INDEX IF NOT EXISTS idx_thoughts_created_at
    ON thoughts (created_at DESC);

-- ── Functions ─────────────────────────────────────────────────────────────────

-- Upsert via SHA-256 fingerprint — re-captures update rather than duplicate
CREATE OR REPLACE FUNCTION upsert_thought(
    p_content       TEXT,
    p_embedding     vector(768),
    p_metadata      JSONB,
    p_fingerprint   TEXT
) RETURNS thoughts AS $$
DECLARE result thoughts;
BEGIN
    INSERT INTO thoughts (content, embedding, metadata, content_fingerprint)
    VALUES (p_content, p_embedding, p_metadata, p_fingerprint)
    ON CONFLICT (content_fingerprint) DO UPDATE SET
        content             = EXCLUDED.content,
        embedding           = EXCLUDED.embedding,
        metadata            = EXCLUDED.metadata,
        updated_at          = now()
    RETURNING * INTO result;
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Cosine similarity search via pgvector
CREATE OR REPLACE FUNCTION match_thoughts(
    query_embedding vector(768),
    match_threshold FLOAT   DEFAULT 0.5,
    match_count     INT     DEFAULT 10
) RETURNS TABLE (
    id          UUID,
    content     TEXT,
    metadata    JSONB,
    similarity  FLOAT,
    created_at  TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT  t.id,
            t.content,
            t.metadata,
            1 - (t.embedding <=> query_embedding) AS similarity,
            t.created_at
    FROM    thoughts t
    WHERE   1 - (t.embedding <=> query_embedding) > match_threshold
    ORDER   BY t.embedding <=> query_embedding
    LIMIT   match_count;
END;
$$ LANGUAGE plpgsql;

-- Full-text search (tsvector, BM25-approximate via ts_rank)
CREATE OR REPLACE FUNCTION search_thoughts_text(
    query           TEXT,
    result_limit    INT DEFAULT 10,
    result_offset   INT DEFAULT 0
) RETURNS TABLE (
    id          UUID,
    content     TEXT,
    metadata    JSONB,
    rank        REAL,
    created_at  TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT  t.id,
            t.content,
            t.metadata,
            ts_rank(to_tsvector('english', t.content),
                    websearch_to_tsquery('english', query)) AS rank,
            t.created_at
    FROM    thoughts t
    WHERE   to_tsvector('english', t.content) @@ websearch_to_tsquery('english', query)
         OR t.content ILIKE '%' || query || '%'
    ORDER   BY rank DESC
    LIMIT   result_limit
    OFFSET  result_offset;
END;
$$ LANGUAGE plpgsql;

-- Auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER thoughts_set_updated_at
    BEFORE UPDATE ON thoughts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
