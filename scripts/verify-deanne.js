require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, zoho_salesperson_id, zoho_salesperson_ids
     FROM users WHERE active = true ORDER BY name`
  );
  console.log('Active users:');
  for (const u of rows) {
    const ids = u.zoho_salesperson_ids
      ? JSON.stringify(u.zoho_salesperson_ids)
      : JSON.stringify(u.zoho_salesperson_id || '—');
    console.log(' ', String(u.id).padStart(3), u.name.padEnd(22), u.role.padEnd(9), ids);
  }
}

run().catch(e => console.error('Error:', e.message)).finally(() => pool.end());
