/**
 * Quick integration test: login then call dashboard/team.
 * Run: node scripts/test-dashboard.js
 */
require('dotenv').config();
const http = require('http');

function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      host: 'localhost', port: 3000, method, path,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data ? Buffer.byteLength(data) : 0,
        ...headers,
      },
    };
    const r = http.request(options, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: d }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  // 1. Login
  const login = await req('POST', '/auth/login', { email: 'admin@artico.com.au', password: 'Artico2024' });
  console.log('Login status:', login.status, login.body.slice(0, 120));

  const cookie = login.headers['set-cookie']?.[0]?.split(';')[0];
  if (!cookie) {
    console.log('No session cookie — checking /auth/me without login:');
    const me = await req('GET', '/auth/me', null, {});
    console.log('me:', me.status, me.body);
    return;
  }
  console.log('Session cookie obtained ✓');

  // 2. /auth/me
  const me = await req('GET', '/auth/me', null, { Cookie: cookie });
  console.log('\n/auth/me:', me.status, me.body);

  // 3. Team dashboard
  console.log('\nFetching /api/dashboard/team ...');
  const dash = await req('GET', '/api/dashboard/team', null, { Cookie: cookie });
  console.log('Dashboard status:', dash.status);
  if (dash.status !== 200) {
    console.log('Response body:', dash.body);
    return;
  }
  const d = JSON.parse(dash.body);
  console.log('Keys:', Object.keys(d).join(', '));
  console.log('month:', d.month);
  console.log('leaderboard:', d.leaderboard?.length, 'reps');
  console.log('monthly_history:', d.monthly_history?.length, 'months');
  console.log('brand_performance:', d.brand_performance?.length, 'brands');
  console.log('last_updated:', d.last_updated);
  console.log('last_sync_at:', d.last_sync_at);
  console.log('totals:', JSON.stringify(d.totals));
  console.log('ytd:', JSON.stringify(d.ytd));

  // 4. Rep dashboard (also check)
  const repDash = await req('GET', '/api/dashboard/rep', null, { Cookie: cookie });
  console.log('\n/api/dashboard/rep status:', repDash.status, repDash.body.slice(0, 120));

})().catch(e => console.error('Test failed:', e.message, e.stack));
