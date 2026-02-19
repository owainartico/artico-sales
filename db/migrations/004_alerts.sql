-- =============================================================
-- Artico Sales App — Alert engine columns
-- Migration: 004_alerts.sql
-- =============================================================

-- Add tier, title, and detail payload to alert_log
ALTER TABLE alert_log
  ADD COLUMN IF NOT EXISTS tier         SMALLINT     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS alert_title  VARCHAR(255) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS alert_detail JSONB        NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_alert_log_tier ON alert_log(tier);
