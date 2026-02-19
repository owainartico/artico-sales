-- App configuration key-value store.
-- Used to persist values that must survive server restarts (e.g. Zoho refresh token).
CREATE TABLE IF NOT EXISTS app_config (
  key        VARCHAR(255) PRIMARY KEY,
  value      TEXT         NOT NULL,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
