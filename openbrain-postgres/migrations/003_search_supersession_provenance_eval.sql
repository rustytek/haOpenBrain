-- 003: filtered unified search (thoughts + wiki pages), supersession, wiki
--      provenance + page embeddings, conflict review queue, retrieval eval set.

-- ── Supersession ──────────────────────────────────────────────────────────────
-- A thought that a newer thought has replaced is kept, not deleted: it points at
-- its replacement and drops out of default search. Deleting the replacement
-- (ON DELETE SET NULL) makes the older thought current again.
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS superseded_by   UUID REFERENCES thoughts(id) ON DELETE SET NULL;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS superseded_at   TIMESTAMPTZ;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS superseded_note TEXT;

CREATE INDEX IF NOT EXISTS idx_thoughts_superseded
    ON thoughts (superseded_by) WHERE superseded_by IS NOT NULL;

-- ── updated_at means "content or metadata changed" ────────────────────────────
-- The generic trigger bumped updated_at on ANY update, so a background re-embed
-- or a supersession mark made every touched thought look new to the wiki
-- consolidator (which works from an updated_at watermark) and reset the
-- "stale page" clock. Only real edits move the clock now.
CREATE OR REPLACE FUNCTION thoughts_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.content IS DISTINCT FROM OLD.content OR NEW.metadata IS DISTINCT FROM OLD.metadata THEN
        NEW.updated_at = now();
    ELSE
        NEW.updated_at = OLD.updated_at;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS thoughts_set_updated_at ON thoughts;
CREATE TRIGGER thoughts_set_updated_at
    BEFORE UPDATE ON thoughts
    FOR EACH ROW EXECUTE FUNCTION thoughts_touch_updated_at();

-- ── Wiki pages: embeddings (so pages are searchable) and provenance ───────────
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS embedding       vector(768);
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS embedding_model TEXT;
-- Thought ids a page was compiled from. No FK on purpose: a deleted source must
-- stay visible as "missing" so the audit can flag the page for a refresh.
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS sources         UUID[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_wiki_pages_embedding_hnsw
    ON wiki_pages USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_fts
    ON wiki_pages USING GIN (to_tsvector('english', title || ' ' || summary || ' ' || content));

CREATE OR REPLACE FUNCTION wiki_pages_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.title IS DISTINCT FROM OLD.title OR NEW.summary IS DISTINCT FROM OLD.summary
       OR NEW.content IS DISTINCT FROM OLD.content OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.sources IS DISTINCT FROM OLD.sources THEN
        NEW.updated_at = now();
    ELSE
        NEW.updated_at = OLD.updated_at;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wiki_pages_set_updated_at ON wiki_pages;
CREATE TRIGGER wiki_pages_set_updated_at
    BEFORE UPDATE ON wiki_pages
    FOR EACH ROW EXECUTE FUNCTION wiki_pages_touch_updated_at();

-- ── Conflict review queue ─────────────────────────────────────────────────────
-- The nightly pass only PROPOSES that a newer thought replaces an older one.
-- Nothing is superseded until a person accepts the proposal: a small local
-- model's judgement is not trusted to hide memories on its own. 'compatible'
-- rows record pairs already checked, so they are not re-checked every night.
CREATE TABLE IF NOT EXISTS thought_conflicts (
    id          BIGSERIAL   PRIMARY KEY,
    newer_id    UUID        NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    older_id    UUID        NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    verdict     TEXT        NOT NULL CHECK (verdict IN ('supersedes', 'duplicate', 'compatible')),
    reason      TEXT        NOT NULL DEFAULT '',
    status      TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'rejected', 'dismissed')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    UNIQUE (newer_id, older_id)
);

CREATE INDEX IF NOT EXISTS idx_thought_conflicts_pending
    ON thought_conflicts (created_at) WHERE status = 'pending';

-- ── Retrieval eval set ────────────────────────────────────────────────────────
-- Real questions with the thought or page that should come back. Lets a search
-- change be measured (hit@5 / hit@10 / MRR) instead of guessed at.
CREATE TABLE IF NOT EXISTS eval_cases (
    id            BIGSERIAL   PRIMARY KEY,
    question      TEXT        UNIQUE NOT NULL,
    expected_kind TEXT        NOT NULL CHECK (expected_kind IN ('thought', 'page')),
    expected_ref  TEXT        NOT NULL,   -- thought UUID, or wiki page slug
    note          TEXT        NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eval_runs (
    id      BIGSERIAL   PRIMARY KEY,
    ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
    label   TEXT        NOT NULL DEFAULT '',
    cases   INT         NOT NULL,
    hit5    DOUBLE PRECISION NOT NULL,
    hit10   DOUBLE PRECISION NOT NULL,
    mrr     DOUBLE PRECISION NOT NULL,
    detail  JSONB       NOT NULL DEFAULT '{}'
);

-- ── Filter helper ─────────────────────────────────────────────────────────────
-- True when any element of the JSON string array metadata->key contains any of
-- the needles, case-insensitively ("sam" matches "Sam Ortiz"). NULL needles = no
-- filter. A non-array value never matches.
CREATE OR REPLACE FUNCTION meta_array_matches(meta JSONB, key TEXT, needles TEXT[])
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT needles IS NULL OR cardinality(needles) = 0 OR (
        jsonb_typeof(meta -> key) = 'array' AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(meta -> key) AS e(val), unnest(needles) AS n(needle)
            WHERE e.val ILIKE '%' || n.needle || '%'
        )
    );
$$;

-- ── Unified search ────────────────────────────────────────────────────────────
-- Reciprocal Rank Fusion of vector and full-text ranks over thoughts AND wiki
-- pages, with metadata filters. Replaces hybrid_search() for the MCP server
-- (the old function stays for anything still calling it).
--   * query_embedding NULL  -> keyword-only (inference node offline).
--   * Thought filters (types/people/topics/source) exclude wiki pages, which
--     carry none of that metadata; date filters apply to both.
--   * Superseded thoughts are left out unless include_superseded.
CREATE OR REPLACE FUNCTION brain_search(
    query_embedding    vector(768),
    query_text         TEXT,
    match_count        INT         DEFAULT 10,
    f_types            TEXT[]      DEFAULT NULL,
    f_people           TEXT[]      DEFAULT NULL,
    f_topics           TEXT[]      DEFAULT NULL,
    f_source           TEXT        DEFAULT NULL,
    f_since            TIMESTAMPTZ DEFAULT NULL,
    f_until            TIMESTAMPTZ DEFAULT NULL,
    include_superseded BOOLEAN     DEFAULT FALSE,
    include_pages      BOOLEAN     DEFAULT TRUE,
    rrf_k              INT         DEFAULT 60
) RETURNS TABLE (
    kind          TEXT,              -- 'thought' | 'page'
    id            UUID,
    ref           TEXT,              -- thought UUID as text, or page slug
    title         TEXT,              -- page title; NULL for thoughts
    content       TEXT,
    metadata      JSONB,
    score         DOUBLE PRECISION,
    created_at    TIMESTAMPTZ,       -- pages: updated_at
    superseded_by UUID
)
LANGUAGE sql STABLE AS $$
WITH lim AS (
    SELECT GREATEST(match_count * 4, 50) AS n,
           (include_pages
            AND (f_types  IS NULL OR cardinality(f_types)  = 0)
            AND (f_people IS NULL OR cardinality(f_people) = 0)
            AND (f_topics IS NULL OR cardinality(f_topics) = 0)
            AND f_source IS NULL) AS pages_ok
),
tv AS (   -- thoughts by vector distance
    SELECT 'thought'::text AS kind, t.id, t.embedding <=> query_embedding AS dist
    FROM thoughts t, lim
    WHERE query_embedding IS NOT NULL AND t.embedding IS NOT NULL
      AND (include_superseded OR t.superseded_by IS NULL)
      AND (f_types IS NULL OR cardinality(f_types) = 0 OR t.metadata->>'type' = ANY (f_types))
      AND meta_array_matches(t.metadata, 'people', f_people)
      AND meta_array_matches(t.metadata, 'topics', f_topics)
      AND (f_source IS NULL OR t.metadata->>'source' = f_source)
      AND (f_since IS NULL OR t.created_at >= f_since)
      AND (f_until IS NULL OR t.created_at <= f_until)
    ORDER BY dist
    LIMIT (SELECT n FROM lim)
),
pv AS (   -- pages by vector distance
    SELECT 'page'::text AS kind, p.id, p.embedding <=> query_embedding AS dist
    FROM wiki_pages p, lim
    WHERE lim.pages_ok AND query_embedding IS NOT NULL AND p.embedding IS NOT NULL
      AND (f_since IS NULL OR p.updated_at >= f_since)
      AND (f_until IS NULL OR p.updated_at <= f_until)
    ORDER BY dist
    LIMIT (SELECT n FROM lim)
),
tt AS (   -- thoughts by full-text rank
    SELECT 'thought'::text AS kind, t.id,
           ts_rank(to_tsvector('english', t.content), websearch_to_tsquery('english', query_text)) AS rank
    FROM thoughts t, lim
    WHERE to_tsvector('english', t.content) @@ websearch_to_tsquery('english', query_text)
      AND (include_superseded OR t.superseded_by IS NULL)
      AND (f_types IS NULL OR cardinality(f_types) = 0 OR t.metadata->>'type' = ANY (f_types))
      AND meta_array_matches(t.metadata, 'people', f_people)
      AND meta_array_matches(t.metadata, 'topics', f_topics)
      AND (f_source IS NULL OR t.metadata->>'source' = f_source)
      AND (f_since IS NULL OR t.created_at >= f_since)
      AND (f_until IS NULL OR t.created_at <= f_until)
    ORDER BY rank DESC
    LIMIT (SELECT n FROM lim)
),
pt AS (   -- pages by full-text rank
    SELECT 'page'::text AS kind, p.id,
           ts_rank(to_tsvector('english', p.title || ' ' || p.summary || ' ' || p.content),
                   websearch_to_tsquery('english', query_text)) AS rank
    FROM wiki_pages p, lim
    WHERE lim.pages_ok
      AND to_tsvector('english', p.title || ' ' || p.summary || ' ' || p.content)
          @@ websearch_to_tsquery('english', query_text)
      AND (f_since IS NULL OR p.updated_at >= f_since)
      AND (f_until IS NULL OR p.updated_at <= f_until)
    ORDER BY rank DESC
    LIMIT (SELECT n FROM lim)
),
vec AS (
    SELECT u.kind, u.id, ROW_NUMBER() OVER (ORDER BY u.dist) AS r
    FROM (SELECT * FROM tv UNION ALL SELECT * FROM pv) u
),
txt AS (
    SELECT u.kind, u.id, ROW_NUMBER() OVER (ORDER BY u.rank DESC) AS r
    FROM (SELECT * FROM tt UNION ALL SELECT * FROM pt) u
),
fused AS (
    SELECT COALESCE(vec.kind, txt.kind) AS kind, COALESCE(vec.id, txt.id) AS id,
           COALESCE(1.0 / (rrf_k + vec.r), 0) + COALESCE(1.0 / (rrf_k + txt.r), 0) AS score
    FROM vec FULL OUTER JOIN txt ON vec.kind = txt.kind AND vec.id = txt.id
)
SELECT f.kind, f.id,
       CASE WHEN f.kind = 'page' THEN p.name ELSE t.id::text END,
       p.title,
       COALESCE(t.content, p.content),
       CASE WHEN f.kind = 'page'
            THEN jsonb_build_object('kind', p.kind, 'summary', p.summary, 'sources', cardinality(p.sources))
            ELSE t.metadata END,
       f.score,
       COALESCE(t.created_at, p.updated_at),
       t.superseded_by
FROM fused f
LEFT JOIN thoughts   t ON f.kind = 'thought' AND t.id = f.id
LEFT JOIN wiki_pages p ON f.kind = 'page'    AND p.id = f.id
ORDER BY f.score DESC, COALESCE(t.created_at, p.updated_at) DESC
LIMIT match_count;
$$;
