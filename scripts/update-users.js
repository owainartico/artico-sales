const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://artico_sales_db_user:5ohhKLp3I4zMZepz50pDzDW6AszAvTTs@dpg-d6bp92vgi27c73dqse6g-a.oregon-postgres.render.com/artico_sales_db',
  ssl: { rejectUnauthorized: false },
});

async function run() {
  // 1. Update Owain
  await pool.query(
    `UPDATE users SET email='owain@artico.net.au', role='executive',
      zoho_salesperson_id='Owain ap Rees', must_change_password=TRUE
     WHERE name='Owain ap Rees'`,
  );
  console.log('1. Owain updated');

  // 2. Upsert Deanne Burrows (sales recorded under Owain in Zoho)
  await pool.query(
    `INSERT INTO users (name, email, role, zoho_salesperson_id, must_change_password, active)
     VALUES ('Deanne Burrows','deanne@artico.net.au','manager','Owain ap Rees',TRUE,TRUE)
     ON CONFLICT (email) DO UPDATE SET
       name                = EXCLUDED.name,
       role                = EXCLUDED.role,
       zoho_salesperson_id = EXCLUDED.zoho_salesperson_id,
       must_change_password = TRUE,
       active              = TRUE`,
  );
  console.log('2. Deanne Burrows upserted');

  // 3. Update rep emails to @artico.net.au
  const repEmails = [
    ['Kathryn Collison',  'kathryn@artico.net.au'],
    ['Caroline Williams', 'caroline@artico.net.au'],
    ['Jackie Aldenhoven', 'jackie@artico.net.au'],
    ['Elizabeth Marton',  'elizabeth@artico.net.au'],
    ['Carey van Venrooy', 'carey@artico.net.au'],
    ['Tania Talivai',     'tania@artico.net.au'],
    ['Kate Mortimer',     'kate@artico.net.au'],
    ['Kim Piper',         'kim@artico.net.au'],
    ['Louise Hickey',     'louise@artico.net.au'],
    ['Sally ap Rees',     'sally@artico.net.au'],
  ];
  for (const [name, email] of repEmails) {
    const r = await pool.query(
      'UPDATE users SET email=$1, must_change_password=TRUE WHERE name=$2 RETURNING id',
      [email, name],
    );
    console.log('3.', name, '->', email, r.rowCount ? 'OK' : 'NOT FOUND');
  }

  // 4. Final state
  const { rows } = await pool.query(
    'SELECT id, name, email, role, zoho_salesperson_id, must_change_password, active FROM users ORDER BY id',
  );
  console.log('\n--- Final users table ---');
  for (const r of rows) {
    const mcp = r.must_change_password ? '✓' : '✗';
    console.log(
      String(r.id).padStart(2),
      '|', r.name.padEnd(22),
      '|', r.role.padEnd(9),
      '|', r.email.padEnd(30),
      '| must_change=' + mcp,
      '| zoho=' + JSON.stringify(r.zoho_salesperson_id),
    );
  }
}

run().catch(e => console.error('Error:', e.message)).finally(() => pool.end());
