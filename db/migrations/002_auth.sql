-- =============================================================
-- Artico Sales App — Auth additions
-- Migration: 002_auth.sql
-- =============================================================

-- Add password hash to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
