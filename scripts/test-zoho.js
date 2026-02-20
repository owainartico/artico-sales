require('dotenv').config();

const { Pool } = require('pg');

const RENDER_DB = 'postgresql://artico_sales_db_user:5ohhKLp3I4zMZepz50pDzDW6AszAvTTs@dpg-d6bp92vgi27c73dqse6g-a.oregon-postgres.render.com/artico_sales_db';

async function run() {
  // Pull the refresh token from the Render DB (the authoritative source)
  const pool = new Pool({ connectionString: RENDER_DB, ssl: { rejectUnauthorized: false } });
  const dbRow = await pool.query("SELECT value FROM app_config WHERE key = 'zoho_refresh_token'");
  await pool.end();

  const refreshToken = dbRow.rows[0]?.value;
  if (!refreshToken) { console.error('No refresh token in Render DB'); return; }
  console.log('Refresh token from DB (prefix):', refreshToken.slice(0, 30));

  // Exchange for access token
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: refreshToken,
  });
  const tr = await fetch('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const td = await tr.json();

  if (!td.access_token) { console.error('Token exchange failed:', td); return; }
  console.log('Access token OK — api_domain:', td.api_domain, '\n');
  const token = td.access_token;

  const orgId = process.env.ZOHO_ORG_ID || '689159620';
  const from  = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  console.log('Fetching invoices', from, '->', today);

  const qs = new URLSearchParams({
    organization_id: orgId,
    date_start: from,
    date_end:   today,
    per_page:   '200',
    page:       '1',
  });

  const res = await fetch('https://www.zohoapis.com/books/v3/invoices?' + qs, {
    headers: { Authorization: 'Zoho-oauthtoken ' + token, Accept: 'application/json' },
  });

  console.log('HTTP status:', res.status);
  const text = await res.text();

  if (!text.startsWith('{')) {
    console.log('Non-JSON response:', text.slice(0, 300));
    return;
  }

  const data = JSON.parse(text);
  if (data.message) console.log('API message:', data.message);
  if (data.code !== undefined && data.code !== 0) { console.log('API error code:', data.code); return; }

  const invoices = data.invoices || [];
  console.log('Invoices returned:', invoices.length);
  if (data.page_context) console.log('Page context:', JSON.stringify(data.page_context));

  if (invoices.length > 0) {
    const sample = invoices[0];
    console.log('\nSample fields:', Object.keys(sample).filter(k =>
      ['invoice_number','date','total','status','salesperson_name','salesperson_id','customer_name'].includes(k)
    ).map(k => k + '=' + JSON.stringify(sample[k])).join(', '));

    // Distinct salesperson names
    const nameMap = {};
    invoices.forEach(inv => {
      const name = inv.salesperson_name || '(blank)';
      if (!nameMap[name]) nameMap[name] = { count: 0, total: 0 };
      nameMap[name].count++;
      nameMap[name].total += parseFloat(inv.total) || 0;
    });

    console.log('\nDistinct salesperson_name values:');
    Object.entries(nameMap).sort((a,b) => a[0].localeCompare(b[0])).forEach(([name, s]) => {
      console.log('  "' + name + '": ' + s.count + ' invoices, $' + s.total.toFixed(2));
    });
  }
}

run().catch(e => console.error('Fatal:', e.message));
