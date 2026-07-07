-- 001: Embedding model versioning, HNSW index, RRF hybrid search,
--      offline-tolerant capture (NULL embedding = pending).

-- ── Embedding model versioning ────────────────────────────────────────────────
-- NULL embedding_model + NULL embedding  → capture succeeded while Node A was
-- offline; the backfill worker embeds it later. A non-NULL model that differs
-- from the server's configured EMBED_MODEL is re-embedded by the same worker.
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS embedding_model TEXT;

-- All pre-migration rows were embedded with nomic-embed-text.
UPDATE thoughts SET embedding_model = 'nomic-embed-text'
WHERE embedding IS NOT NULL AND embedding_model IS NULL;

-- Backfill worker scans this cheaply.
CREATE INDEX IF NOT EXISTS idx_thoughts_pending
    ON thoughts (created_at) WHERE embedding IS NULL;

-- ── HNSW replaces ivfflat ─────────────────────────────────────────────────────
-- ivfflat clusters are trained from data present at index build; on a small or
-- empty table recall is poor forever. HNSW needs no training data.
DROP INDEX IF EXISTS idx_thoughts_embedding;
CREATE INDEX IF NOT EXISTS idx_thoughts_embedding_hnsw
    ON thoughts USING hnsw (embedding vector_cosine_ops);

-- ── upsert_thought v2 ─────────────────────────────────────────────────────────
-- Adds embedding_model and allows NULL embedding (pending backfill).
DROP FUNCTION IF EXISTS upsert_thought(TEXT, vector, JSONB, TEXT);

CREATE OR REPLACE FUNCTION upsert_thought(
    p_content       TEXT,
    p_embedding     vector(768),    -- may be NULL when Node A is unreachable
    p_metadata      JSONB,
    p_fingerprint   TEXT,
    p_model         TEXT            -- NULL when p_embedding is NULL
) RETURNS thoughts AS $$
DECLARE result thoughts;
BEGIN
    INSERT INTO thoughts (content, embedding, metadata, content_fingerprint, embedding_model)
    VALUES (p_content, p_embedding, p_metadata, p_fingerprint, p_model)
    ON CONFLICT (content_fingerprint) DO UPDATE SET
        content         = EXCLUDED.content,
        embedding       = EXCLUDED.embedding,
        metadata        = EXCLUDED.metadata,
        embedding_model = EXCLUDED.embedding_model,
        updated_at      = now()
    RETURNING * INTO result;
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- ── Reciprocal Rank Fusion hybrid search ──────────────────────────────────────
-- Fuses vector and full-text rankings: score = Σ 1/(k + rank). Replaces the
-- client-side concat that let vector results crowd out keyword matches.
CREATE OR REPLACE FUNCTION hybrid_search(
    query_embedding vector(768),
    query_text      TEXT,
    match_count     INT DEFAULT 10,
    rrf_k           INT DEFAULT 60
) RETURNS TABLE (
    id          UUID,
    content     TEXT,
    metadata    JSONB,
    score       DOUBLE PRECISION,
    created_at  TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
WITH vec AS (
    SELECT s.id, ROW_NUMBER() OVER (ORDER BY s.dist) AS r
    FROM (
        SELECT t.id, t.embedding <=> query_embedding AS dist
        FROM thoughts t
        WHERE t.embedding IS NOT NULL
        ORDER BY dist
        LIMIT GREATEST(match_count * 4, 50)
    ) s
),
txt AS (
    SELECT s.id, ROW_NUMBER() OVER (ORDER BY s.rank DESC) AS r
    FROM (
        SELECT t.id,
               ts_rank(to_tsvector('english', t.content),
                       websearch_to_tsquery('english', query_text)) AS rank
        FROM thoughts t
        WHERE to_tsvector('english', t.content) @@ websearch_to_tsquery('english', query_text)
        ORDER BY rank DESC
        LIMIT GREATEST(match_count * 4, 50)
    ) s
)
SELECT th.id, th.content, th.metadata,
       COALESCE(1.0 / (rrf_k + vec.r), 0) + COALESCE(1.0 / (rrf_k + txt.r), 0) AS score,
       th.created_at
FROM (SELECT vec.id FROM vec UNION SELECT txt.id FROM txt) ids
JOIN thoughts th ON th.id = ids.id
LEFT JOIN vec ON vec.id = th.id
LEFT JOIN txt ON txt.id = th.id
ORDER BY score DESC, th.created_at DESC
LIMIT match_count;
$$;
