require('dotenv').config();
const { Pool } = require('pg');

const isRemote = (process.env.DATABASE_URL || '').includes('render.com') ||
                  (process.env.DATABASE_URL || '').includes('dpg-');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(isRemote ? { ssl: { rejectUnauthorized: false } } : {}),
});

async function run() {
  // 1. Set Deanne's zoho_salesperson_ids to cover both Owain and Sally's Zoho names
  const r1 = await pool.query(
    `UPDATE users
     SET zoho_salesperson_ids = ARRAY['Owain ap Rees', 'Sally ap Rees']
     WHERE email = 'deanne@artico.net.au'
     RETURNING id, name, zoho_salesperson_ids`,
  );
  if (r1.rowCount) {
    console.log('✓ Deanne updated:', r1.rows[0]);
  } else {
    console.error('✗ Deanne not found');
    process.exit(1);
  }

  // 2. Delete Sally ap Rees
  const r2 = await pool.query(
    `DELETE FROM users WHERE email = 'sally@artico.net.au' RETURNING id, name`,
  );
  if (r2.rowCount) {
    console.log('✓ Sally deleted:', r2.rows[0]);
  } else {
    console.warn('⚠ Sally not found (may already be deleted)');
  }

  // 3. Show final state of relevant users
  const { rows } = await pool.query(
    `SELECT id, name, email, role, zoho_salesperson_id, zoho_salesperson_ids, active
     FROM users
     WHERE name ILIKE '%deanne%' OR name ILIKE '%sally%' OR name ILIKE '%owain%'
     ORDER BY name`,
  );
  console.log('\n--- Affected users ---');
  for (const r of rows) {
    console.log(
      String(r.id).padStart(3),
      '|', r.name.padEnd(22),
      '|', r.role.padEnd(9),
      '|', (r.zoho_salesperson_id || '—').padEnd(20),
      '| ids:', JSON.stringify(r.zoho_salesperson_ids),
    );
  }
}

run().catch(e => console.error('Error:', e.message)).finally(() => pool.end());
