'use strict';

/**
 * Zoho integration routes.
 *
 * GET  /api/zoho-test   – connectivity check (open in dev; add auth in later prompts)
 * POST /api/sync        – trigger on-demand store sync (admin only)
 */

const express = require('express');
const { makeZohoRequest } = require('../services/zoho');
const { syncStores, fetchInvoices, isSyncRecentEnough } = require('../services/sync');

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

module.exports = router;
