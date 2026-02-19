-- Session store table for connect-pg-simple
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    VARCHAR     NOT NULL COLLATE "default",
  "sess"   JSON        NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);

ALTER TABLE "session"
  DROP CONSTRAINT IF EXISTS "session_pkey";
ALTER TABLE "session"
  ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- First-login flag on users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
