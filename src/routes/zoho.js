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

  // 1. Deanne's DB record
  try {
    const { rows } = await db.query(
      `SELECT id, name, email, role, active, zoho_salesperson_id, zoho_salesperson_ids
       FROM users WHERE name ILIKE '%deanne%' ORDER BY name`
    );
    out.deanne_db = rows;
  } catch (err) {
    out.deanne_db_error = err.message;
  }

  // 2. All users — salesperson ID columns
  try {
    const { rows } = await db.query(
      `SELECT id, name, role, active, zoho_salesperson_id, zoho_salesperson_ids
       FROM users WHERE active = TRUE ORDER BY name`
    );
    out.all_users = rows;
  } catch (err) {
    out.all_users_error = err.message;
  }

  // 3. Does zoho_salesperson_ids column exist?
  try {
    const { rows } = await db.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'zoho_salesperson_ids'`
    );
    out.column_exists = rows.length > 0 ? rows[0] : 'COLUMN MISSING';
  } catch (err) {
    out.column_check_error = err.message;
  }

  // 4. Sample invoices from Zoho — show distinct salesperson_name values (last 30d)
  try {
    const now     = new Date();
    const to      = now.toISOString().slice(0, 10);
    const fromD   = new Date(now); fromD.setDate(fromD.getDate() - 30);
    const from    = fromD.toISOString().slice(0, 10);
    const invoices = await fetchInvoices(from, to);
    const spNames = [...new Set(invoices.map(i => i.salesperson_name).filter(Boolean))].sort();
    out.zoho_salesperson_names_last_30d = spNames;
    out.sample_invoices_count = invoices.length;
    // Show first 5 invoices with their salesperson_name
    out.sample_invoices = invoices.slice(0, 5).map(i => ({
      invoice_id:       i.invoice_id,
      date:             i.date,
      customer_name:    i.customer_name,
      salesperson_name: i.salesperson_name,
      total:            i.total,
    }));
  } catch (err) {
    out.zoho_invoices_error = err.message;
  }

  // 5. Try salespersonNames() logic for Deanne
  try {
    const { rows } = await db.query(
      `SELECT name, zoho_salesperson_id, zoho_salesperson_ids
       FROM users WHERE name ILIKE '%deanne%' LIMIT 1`
    );
    if (rows[0]) {
      const u = rows[0];
      let resolvedNames;
      if (Array.isArray(u.zoho_salesperson_ids) && u.zoho_salesperson_ids.length) {
        resolvedNames = u.zoho_salesperson_ids;
      } else {
        resolvedNames = [u.zoho_salesperson_id || u.name];
      }
      out.resolved_sp_names = resolvedNames;
    } else {
      out.resolved_sp_names = 'Deanne not found in DB';
    }
  } catch (err) {
    out.resolved_sp_names_error = err.message;
  }

  res.json(out);
});

module.exports = router;
