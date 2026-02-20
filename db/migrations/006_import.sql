-- ── Migration 006: CSV import support ────────────────────────────────────────

-- Rep code on users (e.g. CW, EM, JA, KC, CVV, TT, KP, LH, SAR, OAR)
ALTER TABLE users ADD COLUMN IF NOT EXISTS rep_code VARCHAR(10);

-- Visit type (VISIT or PHONE from PixSell category column)
ALTER TABLE visits ADD COLUMN IF NOT EXISTS visit_type VARCHAR(20) NOT NULL DEFAULT 'visit';

-- Deduplication index: same store + rep + exact timestamp = duplicate
CREATE UNIQUE INDEX IF NOT EXISTS idx_visits_dedup
  ON visits (store_id, rep_id, visited_at);

-- Set rep codes for known reps
UPDATE users SET rep_code = CASE name
  WHEN 'Caroline Williams'  THEN 'CW'
  WHEN 'Elizabeth Marton'   THEN 'EM'
  WHEN 'Jackie Aldenhoven'  THEN 'JA'
  WHEN 'Kathryn Collison'   THEN 'KC'
  WHEN 'Carey van Venrooy'  THEN 'CVV'
  WHEN 'Tania Talivai'      THEN 'TT'
  WHEN 'Kim Piper'          THEN 'KP'
  WHEN 'Louise Hickey'      THEN 'LH'
  WHEN 'Sally ap Rees'      THEN 'SAR'
  WHEN 'Owain ap Rees'      THEN 'OAR'
  ELSE rep_code
END
WHERE name IN (
  'Caroline Williams','Elizabeth Marton','Jackie Aldenhoven',
  'Kathryn Collison','Carey van Venrooy','Tania Talivai',
  'Kim Piper','Louise Hickey','Sally ap Rees','Owain ap Rees'
);
