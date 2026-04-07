-- Enable the pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- code_embeddings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS code_embeddings (
  id         BIGSERIAL PRIMARY KEY,
  file_path  TEXT NOT NULL,
  chunk_text TEXT NOT NULL,
  embedding  vector(1536),
  repo       TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo, file_path, chunk_text)
);

CREATE INDEX IF NOT EXISTS idx_code_embeddings_repo ON code_embeddings (repo);

-- ---------------------------------------------------------------------------
-- episodes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS episodes (
  id            BIGSERIAL PRIMARY KEY,
  issue_number  INT NOT NULL,
  issue_title   TEXT NOT NULL,
  approach      TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('success', 'fail')),
  files_changed TEXT[] NOT NULL DEFAULT '{}',
  embedding     vector(1536),
  repo          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_episodes_repo ON episodes (repo);

-- ---------------------------------------------------------------------------
-- patterns
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS patterns (
  id                  BIGSERIAL PRIMARY KEY,
  pattern_description TEXT NOT NULL,
  frequency           INT NOT NULL DEFAULT 0,
  success_rate        REAL NOT NULL DEFAULT 0.0,
  embedding           vector(1536),
  repo                TEXT NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo, pattern_description)
);

CREATE INDEX IF NOT EXISTS idx_patterns_repo ON patterns (repo);
