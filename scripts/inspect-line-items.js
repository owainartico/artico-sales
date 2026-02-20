require('dotenv').config();
const { Pool } = require('pg');

async function getToken() {
  const pool = new Pool({
    connectionString: 'postgresql://artico_sales_db_user:5ohhKLp3I4zMZepz50pDzDW6AszAvTTs@dpg-d6bp92vgi27c73dqse6g-a.oregon-postgres.render.com/artico_sales_db',
    ssl: { rejectUnauthorized: false },
  });
  const { rows } = await pool.query("SELECT value FROM app_config WHERE key='zoho_refresh_token'");
  await pool.end();
  const tr = await fetch('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: rows[0]?.value,
    }),
  });
  return (await tr.json()).access_token;
}

async function run() {
  const token = await getToken();
  if (!token) { console.error('No token'); return; }
  const orgId = process.env.ZOHO_ORG_ID || '689159620';
  const headers = { Authorization: 'Zoho-oauthtoken ' + token, Accept: 'application/json' };

  // Fetch active items - page through all
  let page = 1, total = 0;
  const brandCounts = {};
  const brandItems  = {};  // brand -> sample item names

  while (true) {
    const res = await fetch(
      `https://www.zohoapis.com/books/v3/items?organization_id=${orgId}&filter_by=Status.Active&per_page=200&page=${page}`,
      { headers }
    );
    const data = await res.json();
    const items = data.items || [];
    if (!items.length) break;
    total += items.length;

    for (const item of items) {
      const brand = (item.brand || '').trim() || '(no brand)';
      brandCounts[brand] = (brandCounts[brand] || 0) + 1;
      if (!brandItems[brand]) brandItems[brand] = [];
      if (brandItems[brand].length < 3) brandItems[brand].push(`${item.sku || '?'}: ${item.name}`);
    }

    if (!data.page_context?.has_more_page) break;
    page++;
  }

  console.log(`\nTotal active items fetched: ${total} (${page} page${page > 1 ? 's' : ''})\n`);
  console.log('=== Distinct brand values on active items ===');
  Object.entries(brandCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([brand, count]) => {
      console.log(`\n  "${brand}" (${count} items)`);
      (brandItems[brand] || []).forEach(s => console.log(`    - ${s}`));
    });
}

run().catch(e => console.error('Fatal:', e.message));
