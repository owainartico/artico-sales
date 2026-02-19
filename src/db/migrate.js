/**
 * Simple migration runner.
 * Runs all SQL files in db/migrations/ in filename order,
 * tracking applied migrations in a migrations table.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./index');

const MIGRATIONS_DIR = path.join(__dirname, '../../db/migrations');

async function migrate() {
  // Ensure migrations tracking table exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = await db.query('SELECT filename FROM migrations ORDER BY filename');
  const appliedSet = new Set(applied.rows.map((r) => r.filename));

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`  skip  ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`  run   ${file}`);
    await db.query(sql);
    await db.query('INSERT INTO migrations (filename) VALUES ($1)', [file]);
    ran++;
  }

  console.log(`Migration complete. ${ran} file(s) applied.`);
  process.exit(0);
}

migrate().catch((err) => {
  // AggregateError (e.g. ECONNREFUSED) has no .message — surface nested errors
  if (err.errors) {
    console.error('Migration failed:', err.errors.map(e => e.message || String(e)).join('; '));
  } else {
    console.error('Migration failed:', err.message || err);
  }
  process.exit(1);
});
