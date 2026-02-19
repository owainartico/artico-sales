-- =============================================================
-- Artico Sales App — Initial Schema
-- Migration: 001_initial.sql
-- =============================================================

-- ─────────────────────────────────────────
-- USERS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  SERIAL PRIMARY KEY,
  email               VARCHAR(255) UNIQUE NOT NULL,
  name                VARCHAR(255) NOT NULL,
  role                VARCHAR(50)  NOT NULL CHECK (role IN ('rep', 'manager', 'executive')),
  zoho_salesperson_id VARCHAR(255),          -- Zoho CRM salesperson ID for revenue matching
  active              BOOLEAN      NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(active);


-- ─────────────────────────────────────────
-- STORES  (synced from Zoho Contacts)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stores (
  id               SERIAL PRIMARY KEY,
  zoho_contact_id  VARCHAR(255) UNIQUE NOT NULL,
  name             VARCHAR(255) NOT NULL,
  channel_type     VARCHAR(100),              -- e.g. 'gift', 'pharmacy', 'online'
  grade            CHAR(1) CHECK (grade IN ('A', 'B', 'C')),  -- from Zoho cf_store_grade
  state            VARCHAR(50),               -- AU state abbreviation
  rep_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  active           BOOLEAN      NOT NULL DEFAULT true,
  last_synced_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_stores_rep_id ON stores(rep_id);
CREATE INDEX IF NOT EXISTS idx_stores_state  ON stores(state);
CREATE INDEX IF NOT EXISTS idx_stores_grade  ON stores(grade);
CREATE INDEX IF NOT EXISTS idx_stores_active ON stores(active);


-- ─────────────────────────────────────────
-- VISITS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS visits (
  id          SERIAL PRIMARY KEY,
  rep_id      INTEGER      NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  store_id    INTEGER      NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  visited_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  note        TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_visits_rep_id     ON visits(rep_id);
CREATE INDEX IF NOT EXISTS idx_visits_store_id   ON visits(store_id);
CREATE INDEX IF NOT EXISTS idx_visits_visited_at ON visits(visited_at DESC);


-- ─────────────────────────────────────────
-- REVENUE TARGETS  (per rep, per month)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revenue_targets (
  id         SERIAL PRIMARY KEY,
  rep_id     INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month      CHAR(7)      NOT NULL,   -- YYYY-MM
  amount     NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  set_by     INTEGER      NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (rep_id, month)
);

CREATE INDEX IF NOT EXISTS idx_revenue_targets_rep_month ON revenue_targets(rep_id, month);


-- ─────────────────────────────────────────
-- BRAND TARGETS  (per brand, per month)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brand_targets (
  id         SERIAL PRIMARY KEY,
  brand_slug VARCHAR(100)  NOT NULL,  -- matches slug in config/brands.js
  month      CHAR(7)       NOT NULL,  -- YYYY-MM
  amount     NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  set_by     INTEGER       NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (brand_slug, month)
);

CREATE INDEX IF NOT EXISTS idx_brand_targets_slug_month ON brand_targets(brand_slug, month);


-- ─────────────────────────────────────────
-- ALERT LOG
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_log (
  id                SERIAL PRIMARY KEY,
  alert_type        VARCHAR(100)  NOT NULL,  -- e.g. 'lapsed_store', 'at_risk', 'new_door'
  store_id          INTEGER       REFERENCES stores(id) ON DELETE SET NULL,
  rep_id            INTEGER       REFERENCES users(id)  ON DELETE SET NULL,
  triggered_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  acknowledged_at   TIMESTAMPTZ,
  acknowledged_by   INTEGER       REFERENCES users(id)  ON DELETE SET NULL,
  revenue_at_risk   NUMERIC(12,2),
  estimated_uplift  NUMERIC(12,2),
  action_taken      TEXT
);

CREATE INDEX IF NOT EXISTS idx_alert_log_store_id     ON alert_log(store_id);
CREATE INDEX IF NOT EXISTS idx_alert_log_rep_id       ON alert_log(rep_id);
CREATE INDEX IF NOT EXISTS idx_alert_log_triggered_at ON alert_log(triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_log_unack        ON alert_log(acknowledged_at) WHERE acknowledged_at IS NULL;


-- ─────────────────────────────────────────
-- ZOHO SYNC LOG
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS zoho_sync_log (
  id                SERIAL PRIMARY KEY,
  sync_type         VARCHAR(100)  NOT NULL,  -- e.g. 'contacts', 'invoices'
  started_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  records_processed INTEGER       NOT NULL DEFAULT 0,
  status            VARCHAR(50)   NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'completed', 'error')),
  error_message     TEXT
);

CREATE INDEX IF NOT EXISTS idx_zoho_sync_log_type   ON zoho_sync_log(sync_type);
CREATE INDEX IF NOT EXISTS idx_zoho_sync_log_status ON zoho_sync_log(status);


-- ─────────────────────────────────────────
-- TARGET AUDIT LOG
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS target_audit_log (
  id           SERIAL PRIMARY KEY,
  target_id    INTEGER       NOT NULL,  -- FK into revenue_targets or brand_targets
  target_type  VARCHAR(50)   NOT NULL CHECK (target_type IN ('rep', 'brand')),
  changed_by   INTEGER       NOT NULL REFERENCES users(id),
  old_value    NUMERIC(12,2),
  new_value    NUMERIC(12,2),
  changed_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_target_audit_target ON target_audit_log(target_id, target_type);
CREATE INDEX IF NOT EXISTS idx_target_audit_date   ON target_audit_log(changed_at DESC);
