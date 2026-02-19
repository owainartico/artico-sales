'use strict';

const express = require('express');
const { requireRole } = require('../middleware/auth');
const db = require('../db');
const { fetchInvoices } = require('../services/sync');
const {
  computeOverview,
  computeSkuDetail,
  computeStoreBehaviour,
} = require('../services/productIntelligence');

const router = express.Router();

// All product intelligence routes: manager / executive only
const managerOnly = requireRole('manager', 'executive');

function get12MonthWindow() {
  const now  = new Date();
  const toD  = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const frD  = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const pad  = n => String(n).padStart(2, '0');
  return {
    from: `${frD.getFullYear()}-${pad(frD.getMonth() + 1)}-01`,
    to:   `${toD.getFullYear()}-${pad(toD.getMonth() + 1)}-${pad(toD.getDate())}`,
  };
}

// ── GET /api/products ─────────────────────────────────────────────────────────
// Overview: top SKUs, brand reorder rates
// Optional filters: ?grade=A&channel_type=gift&rep_id=2&period=6 (months)

router.get('/', managerOnly, async (req, res) => {
  try {
    const { from, to } = get12MonthWindow();
    let invoices = await fetchInvoices(from, to);

    // Apply rep filter if needed
    const { grade, channel_type, rep_id } = req.query;
    if (rep_id || grade || channel_type) {
      // Load stores matching filters to get matching zoho_contact_ids
      let conditions = ['s.active = TRUE'];
      let params = [];
      let p = 1;
      if (rep_id)        { conditions.push(`s.rep_id = $${p++}`);        params.push(parseInt(rep_id)); }
      if (grade)         { conditions.push(`s.grade = $${p++}`);         params.push(grade); }
      if (channel_type)  { conditions.push(`s.channel_type ILIKE $${p++}`); params.push(channel_type); }

      const { rows: filteredStores } = await db.query(
        `SELECT zoho_contact_id FROM stores WHERE ${conditions.join(' AND ')}`,
        params
      );
      const allowedCids = new Set(filteredStores.map(s => String(s.zoho_contact_id)));
      invoices = invoices.filter(inv => allowedCids.has(String(inv.customer_id)));
    }

    const { topSkus, brandSummary } = computeOverview(invoices);

    res.json({ topSkus, brandSummary });
  } catch (err) {
    console.error('Products overview error:', err.message);
    res.status(500).json({ error: 'Failed to load product overview' });
  }
});

// ── GET /api/products/sku/:itemId ─────────────────────────────────────────────
// Full metrics + stocking / dropped stores for one SKU

router.get('/sku/:itemId', managerOnly, async (req, res) => {
  try {
    const { from, to } = get12MonthWindow();
    const invoices = await fetchInvoices(from, to);

    const { rows: storeRows } = await db.query(
      `SELECT s.id, s.name, s.grade, s.state, s.zoho_contact_id, u.name AS rep_name
       FROM stores s LEFT JOIN users u ON u.id = s.rep_id
       WHERE s.active = TRUE`
    );

    const detail = computeSkuDetail(req.params.itemId, invoices, storeRows);
    res.json(detail);
  } catch (err) {
    console.error('SKU detail error:', err.message);
    res.status(500).json({ error: 'Failed to load SKU detail' });
  }
});

// ── GET /api/products/store/:storeId/behaviour ────────────────────────────────
// Store behaviour classification + metrics (used in store detail sheet)

router.get('/store/:storeId/behaviour', requireRole('manager', 'executive'), async (req, res) => {
  const storeId = parseInt(req.params.storeId);
  if (isNaN(storeId)) return res.status(400).json({ error: 'Invalid store id' });

  try {
    const { rows } = await db.query(
      `SELECT zoho_contact_id, grade FROM stores WHERE id = $1 AND active = TRUE`,
      [storeId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
    const { zoho_contact_id, grade } = rows[0];

    const { from, to } = get12MonthWindow();
    const invoices = await fetchInvoices(from, to);

    const behaviour = computeStoreBehaviour(zoho_contact_id, grade, invoices);
    res.json(behaviour);
  } catch (err) {
    console.error('Store behaviour error:', err.message);
    res.status(500).json({ error: 'Failed to compute store behaviour' });
  }
});

module.exports = router;
