-- KPI incentive tracker schema
-- incentive_targets: quarterly KPI targets per rep (manager-configured)
-- weekly_plans: simple "plan submitted" flag per rep per week

CREATE TABLE IF NOT EXISTS incentive_targets (
  id            SERIAL   PRIMARY KEY,
  rep_id        INTEGER  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quarter       SMALLINT NOT NULL CHECK (quarter BETWEEN 1 AND 4),
  year          SMALLINT NOT NULL CHECK (year >= 2020),
  new_customers SMALLINT NOT NULL DEFAULT 5,
  reactivations SMALLINT NOT NULL DEFAULT 5,
  coverage_pct  SMALLINT NOT NULL DEFAULT 90,
  growth_pct    SMALLINT NOT NULL DEFAULT 5,
  set_by        INTEGER  REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rep_id, quarter, year)
);
CREATE INDEX IF NOT EXISTS idx_incentive_targets_rep ON incentive_targets(rep_id);

CREATE TABLE IF NOT EXISTS weekly_plans (
  id           SERIAL  PRIMARY KEY,
  rep_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start   DATE    NOT NULL,  -- ISO Monday of the week
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rep_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_weekly_plans_rep_week ON weekly_plans(rep_id, week_start);
