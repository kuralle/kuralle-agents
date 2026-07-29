CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY,
  name TEXT,
  email TEXT,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL,
  embedding vector(1536),
  search_document TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))
  ) STORED,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS knowledge_embedding_hnsw
  ON knowledge USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS knowledge_search_gin ON knowledge USING gin (search_document);

CREATE TABLE IF NOT EXISTS memories (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  memory_type TEXT NOT NULL CHECK (memory_type ~ '^[a-z][a-z0-9_]{1,63}$'),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 2000),
  embedding vector(1536),
  search_document TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(memory_type, '') || ' ' || coalesce(content, ''))
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, memory_type)
);

CREATE INDEX IF NOT EXISTS memories_embedding_hnsw
  ON memories USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS memories_search_gin ON memories USING gin (search_document);
CREATE INDEX IF NOT EXISTS memories_user_updated ON memories (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  items TEXT[] NOT NULL,
  total NUMERIC(10, 2) NOT NULL CHECK (total >= 0),
  status TEXT NOT NULL CHECK (status IN ('delivered', 'pending', 'shipped', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session_reports (
  session_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  report JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION match_memories_hybrid(
  query_embedding vector(1536),
  query_text TEXT,
  owner_id UUID,
  result_count INT DEFAULT 5
)
RETURNS TABLE (id BIGINT, memory_type TEXT, content TEXT, score DOUBLE PRECISION)
LANGUAGE SQL STABLE AS $$
  WITH vector_ranked AS (
    SELECT m.id, row_number() OVER (ORDER BY m.embedding <=> query_embedding) AS rank
    FROM memories m
    WHERE m.user_id = owner_id AND m.embedding IS NOT NULL
    LIMIT LEAST(GREATEST(result_count, 1) * 4, 50)
  ),
  text_ranked AS (
    SELECT m.id,
      row_number() OVER (ORDER BY ts_rank_cd(m.search_document, websearch_to_tsquery('english', query_text)) DESC) AS rank
    FROM memories m
    WHERE m.user_id = owner_id
      AND trim(query_text) <> ''
      AND m.search_document @@ websearch_to_tsquery('english', query_text)
    LIMIT LEAST(GREATEST(result_count, 1) * 4, 50)
  ),
  fused AS (
    SELECT coalesce(v.id, t.id) AS id,
      coalesce(0.7 / (60 + v.rank), 0.0) + coalesce(0.3 / (60 + t.rank), 0.0) AS score
    FROM vector_ranked v FULL OUTER JOIN text_ranked t ON v.id = t.id
  )
  SELECT m.id, m.memory_type, m.content, f.score
  FROM fused f JOIN memories m ON m.id = f.id
  ORDER BY f.score DESC
  LIMIT GREATEST(result_count, 1);
$$;
