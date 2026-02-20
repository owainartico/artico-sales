-- Allow a user to be matched against multiple Zoho salesperson names.
-- When zoho_salesperson_ids is set, it overrides zoho_salesperson_id for invoice matching.
-- Use case: Deanne Burrows receives revenue recorded under both "Owain ap Rees" and "Sally ap Rees".
ALTER TABLE users ADD COLUMN IF NOT EXISTS zoho_salesperson_ids TEXT[];
