-- Grade system schema: store grading, history, and prospect classification
-- Safe to re-run: all statements use IF NOT EXISTS / IF NOT EXISTS guards.

ALTER TABLE stores ADD COLUMN IF NOT EXISTS grade_locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS is_prospect  BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS grade_history (
  id          SERIAL      PRIMARY KEY,
  store_id    INTEGER     NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  old_grade   CHAR(1)     CHECK (old_grade IN ('A','B','C')),
  new_grade   CHAR(1)     CHECK (new_grade IN ('A','B','C')),
  reason      TEXT        NOT NULL DEFAULT '',
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by  TEXT        NOT NULL DEFAULT 'system',
  locked      BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_grade_history_store      ON grade_history(store_id);
CREATE INDEX IF NOT EXISTS idx_grade_history_changed_at ON grade_history(changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_stores_prospect          ON stores(is_prospect) WHERE is_prospect = TRUE;
