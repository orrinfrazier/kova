-- Create review_feedback table for storing classified code review feedback.

CREATE TABLE IF NOT EXISTS review_feedback (
  id            BIGSERIAL PRIMARY KEY,
  repo          TEXT NOT NULL,
  pr_number     INT NOT NULL,
  feedback_type TEXT NOT NULL CHECK (feedback_type IN (
    'style_issue', 'logic_error', 'missing_test', 'security_concern',
    'performance', 'naming', 'architecture', 'documentation'
  )),
  comment_text  TEXT NOT NULL,
  author        TEXT NOT NULL,
  file_path     TEXT,
  line          INT,
  embedding     vector(1536),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_review_feedback_repo ON review_feedback (repo);
CREATE INDEX IF NOT EXISTS idx_review_feedback_pr ON review_feedback (repo, pr_number);
