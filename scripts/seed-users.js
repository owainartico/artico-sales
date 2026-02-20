const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://artico_sales_db_user:5ohhKLp3I4zMZepz50pDzDW6AszAvTTs@dpg-d6bp92vgi27c73dqse6g-a.oregon-postgres.render.com/artico_sales_db',
  ssl: { rejectUnauthorized: false },
});

const users = [
  { name: 'Owain ap Rees',      email: 'owain@artico.com.au',              role: 'executive' },
  { name: 'Kathryn Collison',   email: 'kathryn.collison@artico.com.au',   role: 'rep' },
  { name: 'Caroline Williams',  email: 'caroline.williams@artico.com.au',  role: 'rep' },
  { name: 'Jackie Aldenhoven',  email: 'jackie.aldenhoven@artico.com.au',  role: 'rep' },
  { name: 'Elizabeth Marton',   email: 'elizabeth.marton@artico.com.au',   role: 'rep' },
  { name: 'Carey van Venrooy',  email: 'carey.vanvenrooy@artico.com.au',   role: 'rep' },
  { name: 'Tania Talivai',      email: 'tania.talivai@artico.com.au',      role: 'rep' },
  { name: 'Kate Mortimer',      email: 'kate.mortimer@artico.com.au',      role: 'rep' },
  { name: 'Kim Piper',          email: 'kim.piper@artico.com.au',          role: 'rep' },
  { name: 'Louise Hickey',      email: 'louise.hickey@artico.com.au',      role: 'rep' },
  { name: 'Sally ap Rees',      email: 'sally.aprees@artico.com.au',       role: 'rep' },
];

async function run() {
  // Upsert each user by email; zoho_salesperson_id = exact Zoho name
  for (const u of users) {
    const result = await pool.query(
      `INSERT INTO users (name, email, role, zoho_salesperson_id, must_change_password, active)
       VALUES ($1, $2, $3, $4, TRUE, TRUE)
       ON CONFLICT (email) DO UPDATE SET
         name                = EXCLUDED.name,
         role                = EXCLUDED.role,
         zoho_salesperson_id = EXCLUDED.zoho_salesperson_id,
         must_change_password = TRUE,
         active              = TRUE
       RETURNING id, email, name, role, zoho_salesperson_id`,
      [u.name, u.email, u.role, u.name],
    );
    const row = result.rows[0];
    console.log(`[${row.role.padEnd(9)}] id=${String(row.id).padStart(2)} ${row.email.padEnd(38)} zoho="${row.zoho_salesperson_id}"`);
  }

  // Show final state
  console.log('\n--- All users ---');
  const all = await pool.query('SELECT id, name, email, role, zoho_salesperson_id, must_change_password FROM users ORDER BY id');
  all.rows.forEach(r =>
    console.log(`  ${r.id} | ${r.name.padEnd(22)} | ${r.role.padEnd(9)} | must_change=${r.must_change_password} | zoho="${r.zoho_salesperson_id}"`)
  );
}

run().catch(e => console.error('Error:', e.message)).finally(() => pool.end());
