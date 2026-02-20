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
const { syncStores, fetchInvoices, isSyncRecentEnough } = require('../services/sync');
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

module.exports = router;
