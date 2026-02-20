'use strict';
/**
 * fix-token.js  — Render shell diagnostic & repair script
 *
 * Run from Render shell:
 *   node scripts/fix-token.js
 *
 * What it does:
 *   1. Checks app_config table exists and has a zoho_refresh_token row
 *   2. Forces a Zoho token refresh (uses the stored/env refresh token)
 *   3. Confirms the new refresh token was saved to app_config
 *   4. Runs classifyProspects + downgradeInactiveToProspect
 *   5. Shows a summary
 */

require('dotenv').config();

const db    = require('../src/db/index');
const { initZohoTokens, refreshAccessToken } = require('../src/services/zoho');
const { fetchInvoices } = require('../src/services/sync');

async function checkAppConfig() {
  console.log('\n── 1. Checking app_config table ─────────────────────────────');
  try {
    const { rows } = await db.query(
      `SELECT key, LEFT(value,30) AS preview, updated_at
       FROM app_config WHERE key = 'zoho_refresh_token'`
    );
    if (rows.length === 0) {
      console.log('  ⚠  No zoho_refresh_token in app_config — will seed from ZOHO_REFRESH_TOKEN env var');
    } else {
      console.log(`  ✓  Found: ${rows[0].preview}…`);
      console.log(`     updated_at: ${rows[0].updated_at}`);
    }
    return rows[0] || null;
  } catch (err) {
    if (err.message.includes('does not exist')) {
      console.log('  ✗  app_config TABLE DOES NOT EXIST — creating it now…');
      await db.query(`
        CREATE TABLE IF NOT EXISTS app_config (
          key        VARCHAR(255) PRIMARY KEY,
          value      TEXT         NOT NULL,
          updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
      `);
      console.log('  ✓  app_config created');
    } else {
      console.log('  ✗  Error:', err.message);
    }
    return null;
  }
}

async function forceTokenRefresh() {
  console.log('\n── 2. Loading stored refresh token ──────────────────────────');
  await initZohoTokens();
  console.log('  ✓  initZohoTokens() complete');

  console.log('\n── 3. Forcing Zoho token refresh ────────────────────────────');
  const before = await db.query(
    `SELECT LEFT(value,30) AS preview, updated_at FROM app_config WHERE key = 'zoho_refresh_token'`
  ).catch(() => ({ rows: [] }));

  let accessToken;
  try {
    accessToken = await refreshAccessToken();
    console.log('  ✓  Access token obtained:', accessToken.slice(0, 20) + '…');
  } catch (err) {
    console.log('  ✗  Token refresh FAILED:', err.message);
    console.log('\n  ACTION REQUIRED: The refresh token in app_config (or env var) is invalid.');
    console.log('  You need to re-authorise via Zoho OAuth and set a fresh ZOHO_REFRESH_TOKEN env var,');
    console.log('  then re-run this script.');
    return false;
  }

  const after = await db.query(
    `SELECT LEFT(value,30) AS preview, updated_at FROM app_config WHERE key = 'zoho_refresh_token'`
  ).catch(() => ({ rows: [] }));

  console.log('\n── 4. Checking token was saved ──────────────────────────────');
  const beforePreview = before.rows[0]?.preview || '(none)';
  const afterPreview  = after.rows[0]?.preview  || '(none)';
  const rotated = beforePreview !== afterPreview;

  console.log(`  Before: ${beforePreview}…`);
  console.log(`  After:  ${afterPreview}…`);
  if (rotated) {
    console.log('  ✓  Refresh token rotated and saved to app_config');
  } else if (after.rows.length === 0) {
    console.log('  ✗  Token NOT saved — app_config write failed (check DB permissions)');
  } else {
    console.log('  ℹ  Token unchanged (Zoho did not rotate it this call, or it was already current)');
  }

  return true;
}

async function testInvoiceFetch() {
  console.log('\n── 5. Fetching invoices (7-day test) ────────────────────────');
  const to   = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  try {
    const invoices = await fetchInvoices(from, to);
    console.log(`  ✓  ${invoices.length} invoices returned for ${from} → ${to}`);
    if (invoices.length > 0) {
      const sample = invoices[0];
      console.log(`  Sample: ${sample.customer_name} | ${sample.date} | $${sample.sub_total}`);
    }
    return invoices.length > 0;
  } catch (err) {
    console.log('  ✗  Invoice fetch failed:', err.message);
    return false;
  }
}

async function runGrading() {
  console.log('\n── 6. Running prospect classification ───────────────────────');
  const { classifyProspects, promoteActiveProspects, downgradeInactiveToProspect } = require('../src/services/grading');
  try {
    const classify  = await classifyProspects();
    console.log(`  classifyProspects:          ${JSON.stringify(classify)}`);
    const promote   = await promoteActiveProspects();
    console.log(`  promoteActiveProspects:     ${JSON.stringify(promote)}`);
    const downgrade = await downgradeInactiveToProspect();
    console.log(`  downgradeInactiveToProspect:${JSON.stringify(downgrade)}`);
  } catch (err) {
    console.log('  ✗  Grading error:', err.message);
  }
}

async function showProspectCount() {
  console.log('\n── 7. Store grade distribution ──────────────────────────────');
  const { rows } = await db.query(`
    SELECT
      CASE WHEN is_prospect THEN 'P (prospect)' WHEN grade IS NULL THEN '? (ungraded)' ELSE grade END AS bucket,
      COUNT(*)::INTEGER AS count
    FROM stores WHERE active = TRUE
    GROUP BY 1 ORDER BY 1
  `);
  for (const r of rows) {
    console.log(`  ${r.bucket.padEnd(14)} ${r.count}`);
  }
}

async function main() {
  console.log('=== Artico fix-token.js diagnostic ===');
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    await checkAppConfig();
    const tokenOk = await forceTokenRefresh();
    if (!tokenOk) {
      console.log('\n✗ Cannot continue — fix the token first.');
      process.exit(1);
    }
    const invoicesOk = await testInvoiceFetch();
    if (invoicesOk) {
      await runGrading();
    } else {
      console.log('  ⚠  Skipping grading — invoice fetch returned 0 results (Zoho may be slow, try again in 30s)');
    }
    await showProspectCount();
    console.log('\n=== Done ===\n');
  } catch (err) {
    console.error('\nFatal error:', err.message);
  } finally {
    await db.pool.end();
    process.exit(0);
  }
}

main();
