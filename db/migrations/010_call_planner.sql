-- ── Call Planner schema ───────────────────────────────────────────────────────
-- Adds postcode to stores and creates the call_plan_items table.

ALTER TABLE stores ADD COLUMN IF NOT EXISTS postcode VARCHAR(10);
CREATE INDEX IF NOT EXISTS idx_stores_postcode ON stores(postcode);

CREATE TABLE IF NOT EXISTS call_plan_items (
  id             SERIAL       PRIMARY KEY,
  rep_id         INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id       INTEGER      NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  planned_week   DATE         NOT NULL,   -- ISO Monday YYYY-MM-DD
  day_of_week    SMALLINT     NOT NULL CHECK (day_of_week BETWEEN 1 AND 5),
  position       SMALLINT     NOT NULL DEFAULT 1,
  status         VARCHAR(20)  NOT NULL DEFAULT 'suggested'
                              CHECK (status IN ('suggested','confirmed','completed','skipped')),
  confirmed_time VARCHAR(10),
  notes          TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (rep_id, store_id, planned_week)
);

CREATE INDEX IF NOT EXISTS idx_call_plan_rep_week ON call_plan_items(rep_id, planned_week);
CREATE INDEX IF NOT EXISTS idx_call_plan_store    ON call_plan_items(store_id);
