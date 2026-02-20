'use strict';

/**
 * Zoho integration routes.
 *
 * GET  /api/zoho-test        – connectivity check
 * POST /api/sync             – trigger on-demand store sync
 * GET  /api/debug-deanne     – temporary debug endpoint (REMOVE after fix confirmed)
 */

const express = require('express');
const { makeZohoRequest } = require('../services/zoho');
const { syncStores, fetchInvoices, fetchInvoicesWithTimeout, invalidateInvoiceCache, refreshInvoiceCacheInBackground, getInvoiceCacheStats, isSyncRecentEnough } = require('../services/sync');
const { requireRole } = require('../middleware/auth');
const db = require('../db');

const router = express.Router();

// ── GET /api/zoho-test ────────────────────────────────────────────────────────
//
// Verifies the Zoho connection is working.
// Returns a summary of data visible via the API — useful before building UI.
//
// TODO: Restrict to admin role once auth middleware is wired up (Prompt 3).

router.get('/zoho-test', async (req, res) => {
  try {
    const orgId = process.env.ZOHO_ORG_ID || '689159620';

    // ── 1. Contacts count ──────────────────────────────────────────────────
    // Fetch first page of customer contacts.
    // page_context.total gives the full count if Zoho returns it;
    // otherwise we report the count of the first page only.
    const contactsData = await makeZohoRequest('/contacts', {
      contact_type: 'customer',
      per_page: 200,
      page: 1,
    });

    const storesInZoho =
      contactsData.page_context?.total ??
      contactsData.page_context?.count ??
      (contactsData.contacts?.length || 0);

    const hasMorePages = contactsData.page_context?.has_more_page === true;

    // ── 2. Invoices (last 30 days) ─────────────────────────────────────────
    const toDate = new Date().toISOString().slice(0, 10);
    const fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const invoices = await fetchInvoices(fromDate, toDate);

    // ── 3. Sample custom fields from first contact ─────────────────────────
    // Helps identify the api_name values for cf_store_grade and channel type.
    const sampleContact = contactsData.contacts?.[0] || null;
    const sampleCustomFields = sampleContact?.custom_fields || [];

    res.json({
      ok: true,
      org_id: orgId,
      stores_in_zoho: storesInZoho,
      stores_count_is_full_total: !hasMorePages,
      invoices_last_30_days: invoices.length,
      sample_invoice: invoices[0] || null,
      // Expose custom field schema to help confirm api_names
      sample_contact_custom_fields: sampleCustomFields,
    });
  } catch (err) {
    console.error('[zoho-test]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/sync ────────────────────────────────────────────────────────────
//
// Triggers an on-demand store sync from Zoho Books.
// Pass { "force": true } in the JSON body to bypass the 15-minute cache.
//
// TODO: Restrict to manager/executive role once auth middleware is wired up (Prompt 3).

router.post('/sync', async (req, res) => {
  const force = req.body?.force === true;

  if (!force && isSyncRecentEnough('stores')) {
    return res.json({
      ok: true,
      skipped: true,
      reason: 'Last sync was less than 15 minutes ago. Pass { "force": true } to override.',
    });
  }

  try {
    const result = await syncStores({ force: true });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[api/sync]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/debug-deanne ─────────────────────────────────────────────────────
// Temporary diagnostic endpoint — executive only. Remove after Deanne fix confirmed.

router.get('/debug-deanne', requireRole('executive'), async (req, res) => {
  const out = {};

  // 1. zoho_salesperson_ids column exists?
  try {
    const { rows } = await db.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'zoho_salesperson_ids'`
    );
    out.column_exists = rows.length > 0 ? rows[0] : 'COLUMN MISSING — migration has not run yet';
  } catch (err) {
    out.column_check_error = err.message;
  }

  // 2. All active users with their salesperson mapping
  try {
    const { rows } = await db.query(
      `SELECT id, name, email, role, active, zoho_salesperson_id, zoho_salesperson_ids
       FROM users ORDER BY name`
    );
    out.all_users = rows.map(u => ({
      id:   u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      active: u.active,
      zoho_salesperson_id:  u.zoho_salesperson_id,
      zoho_salesperson_ids: u.zoho_salesperson_ids,
      // Show what the matching code will actually use
      resolved_sp_names: (() => {
        if (Array.isArray(u.zoho_salesperson_ids) && u.zoho_salesperson_ids.length) {
          return u.zoho_salesperson_ids;
        }
        return [u.zoho_salesperson_id || u.name];
      })(),
    }));
  } catch (err) {
    out.all_users_error = err.message;
  }

  // 3. Fetch recent invoices and show ALL distinct salesperson_name values from Zoho
  //    + per-name invoice count + total revenue (last 60 days)
  try {
    const now   = new Date();
    const to    = now.toISOString().slice(0, 10);
    const fromD = new Date(now.getFullYear(), now.getMonth() - 1, 1); // start of last month
    const from  = fromD.toISOString().slice(0, 10);
    const invoices = await fetchInvoices(from, to);

    // Distinct salesperson names with counts/totals
    const spMap = new Map();
    for (const inv of invoices) {
      const sp = inv.salesperson_name || '(none)';
      if (!spMap.has(sp)) spMap.set(sp, { count: 0, total: 0 });
      const e = spMap.get(sp);
      e.count++;
      e.total += Number(inv.sub_total || 0);
    }
    out.zoho_salesperson_names = [...spMap.entries()]
      .map(([name, { count, total }]) => ({ name, invoice_count: count, total: Math.round(total) }))
      .sort((a, b) => b.total - a.total);
    out.zoho_total_invoices = invoices.length;
    out.zoho_date_range = { from, to };

    // For each resolved_sp_names in all_users, count matching invoices
    if (out.all_users) {
      for (const u of out.all_users) {
        const matched = invoices.filter(i => u.resolved_sp_names.includes(i.salesperson_name));
        u.matched_invoices = matched.length;
        u.matched_revenue  = Math.round(matched.reduce((s, i) => s + Number(i.sub_total || 0), 0));
      }
    }
  } catch (err) {
    out.zoho_invoices_error = err.message;
  }

  res.json(out);
});

// ── GET /api/debug-invoice-fields ────────────────────────────────────────────
// Fetch 5 recent invoices and show all numeric/amount fields so we can verify
// which field to use for ex-GST revenue.  Executive only.

router.get('/debug-invoice-fields', requireRole('executive'), async (req, res) => {
  try {
    const to   = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const invoices = await fetchInvoices(from, to);
    const sample = invoices.slice(0, 5).map(inv => ({
      invoice_id:       inv.invoice_id,
      date:             inv.date,
      customer_name:    inv.customer_name,
      salesperson_name: inv.salesperson_name,
      // Amount fields — we want ex-GST
      total:            inv.total,
      sub_total:        inv.sub_total,
      tax_total:        inv.tax_total,
      total_inclusive_of_tax: inv.total_inclusive_of_tax,
      // Any other fields with "total" or "amount" in the name
      _all_amount_keys: Object.entries(inv)
        .filter(([k, v]) => typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)) && v !== '' && (k.includes('total') || k.includes('amount') || k.includes('tax') || k.includes('sub'))))
        .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {}),
    }));
    res.json({ date_range: { from, to }, sample });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/debug/grading-status ─────────────────────────────────────────────
// Diagnostics: grade distribution, invoice cache state, Deanne user record.
// Executive only.

router.get('/debug/grading-status', requireRole('executive'), async (req, res) => {
  // DB-only: no Zoho API calls. Returns instantly from local data.
  try {
    const [
      { rows: gradeDist },
      { rows: deanne },
      { rows: sampleUngraded },
      { rows: totalStores },
    ] = await Promise.all([
      db.query(`
        SELECT
          CASE WHEN is_prospect THEN 'prospect' WHEN grade IS NULL THEN 'ungraded' ELSE grade END AS bucket,
          COUNT(*)::INTEGER AS count
        FROM stores
        WHERE active = TRUE
        GROUP BY 1
        ORDER BY 1
      `),
      db.query(`
        SELECT id, name, email, role, active, zoho_salesperson_id, zoho_salesperson_ids
        FROM users WHERE name ILIKE '%deanne%'
      `),
      db.query(`
        SELECT id, name, grade, is_prospect, zoho_contact_id
        FROM stores
        WHERE active = TRUE AND grade IS NULL AND is_prospect = FALSE
        LIMIT 10
      `),
      db.query(`SELECT COUNT(*)::INTEGER AS count FROM stores WHERE active = TRUE`),
    ]);

    res.json({
      total_active_stores: totalStores[0]?.count || 0,
      grade_distribution: gradeDist,
      ungraded_not_prospect_sample: sampleUngraded,
      deanne: deanne[0] || null,
      note: 'Invoice cache stats omitted — use /api/grades/run-auto to trigger grading. Check Render logs for invoice fetch counts.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/debug/invoice-cache ─────────────────────────────────────────────
// Shows current invoice cache state — no Zoho API call. Executive only.
// If entries is empty → pre-warm hasn't completed or failed.

router.get('/debug/invoice-cache', requireRole('executive'), (req, res) => {
  const stats = getInvoiceCacheStats();
  res.json({
    ok: true,
    ...stats,
    note: 'If entries is empty, the 18m invoice cache has not been populated yet. Use POST /api/debug/cache-refresh to force reload.',
  });
});

// ── GET /api/debug/token-status ───────────────────────────────────────────────
// Shows Zoho token state from app_config (NOT zoho_tokens — that table doesn't
// exist; the refresh token lives in app_config under key 'zoho_refresh_token').
// Also shows invoice cache state and attempts a live Zoho ping. Executive only.

router.get('/debug/token-status', requireRole('executive'), async (req, res) => {
  const out = {};

  // 1. Check app_config for persisted refresh token
  try {
    const { rows } = await db.query(
      `SELECT key, LEFT(value, 20) AS value_preview, updated_at
       FROM app_config WHERE key = 'zoho_refresh_token'`
    );
    out.refresh_token_in_db = rows.length > 0
      ? { found: true, preview: rows[0].value_preview + '…', updated_at: rows[0].updated_at }
      : { found: false, note: 'No refresh token in app_config — will use ZOHO_REFRESH_TOKEN env var' };
  } catch (err) {
    out.refresh_token_db_error = err.message;
  }

  // 2. Invoice cache state
  out.invoice_cache = getInvoiceCacheStats();

  // 3. Live Zoho ping
  try {
    const to   = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const data = await makeZohoRequest('/invoices', {
      date_start: from, date_end: to, status: 'paid', per_page: 1, page: 1,
    });
    out.zoho_ping = {
      ok: true,
      token_valid: true,
      invoices_found: data.invoices?.length || 0,
      sample_date: data.invoices?.[0]?.date || null,
    };
  } catch (err) {
    out.zoho_ping = { ok: false, token_valid: false, error: err.message };
  }

  res.json(out);
});

// ── GET /api/debug/zoho-ping ──────────────────────────────────────────────────
// Tests Zoho token by fetching 1 recent invoice. Executive only.

router.get('/debug/zoho-ping', requireRole('executive'), async (req, res) => {
  try {
    const to   = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const data = await makeZohoRequest('/invoices', {
      date_start: from, date_end: to,
      status: 'paid', per_page: 1, page: 1,
    });
    res.json({
      ok: true,
      token_valid:   true,
      invoices_found: data.invoices?.length || 0,
      has_more_pages: data.page_context?.has_more_page ?? null,
      sample_date:    data.invoices?.[0]?.date || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, token_valid: false, error: err.message });
  }
});

// ── POST /api/debug/cache-refresh ────────────────────────────────────────────
// Clears invoice cache and triggers a fresh 18m fetch. Executive only.
// Non-blocking — responds immediately, fetch runs in background.
// Check Render logs for "[scheduler] fetchInvoices cached" to confirm success.

router.post('/debug/cache-refresh', requireRole('executive'), (req, res) => {
  const now  = new Date();
  const toD  = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const fromD = new Date(now.getFullYear(), now.getMonth() - 17, 1);
  const pad  = n => String(n).padStart(2, '0');
  const from = `${fromD.getFullYear()}-${pad(fromD.getMonth() + 1)}-01`;
  const to   = `${toD.getFullYear()}-${pad(toD.getMonth() + 1)}-${pad(toD.getDate())}`;

  // Clear first (user-triggered explicit reload), then refill.
  // Unlike the hourly scheduler we want a true forced reload here.
  invalidateInvoiceCache();
  console.log(`[cache-refresh] Cache cleared. Re-warming ${from} to ${to}…`);

  refreshInvoiceCacheInBackground(from, to)
    .then(inv => console.log(`[cache-refresh] Done — ${inv.length} invoices loaded`))
    .catch(err => console.error('[cache-refresh] Failed:', err.message));

  res.json({
    ok: true,
    message: `Cache cleared. Re-warming ${from} to ${to} in background (~60s). Reload dashboard once Render logs show "fetchInvoices cached".`,
  });
});

module.exports = router;
