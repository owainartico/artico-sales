'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const db = require('../db');
const { fetchInvoices } = require('../services/sync');

const router = express.Router();

// ── Date helpers ──────────────────────────────────────────────────────────────

function get12MonthWindow() {
  const now   = new Date();
  const toD   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const fromD = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const pad   = n => String(n).padStart(2, '0');
  return {
    from: `${fromD.getFullYear()}-${pad(fromD.getMonth() + 1)}-01`,
    to:   `${toD.getFullYear()}-${pad(toD.getMonth() + 1)}-${pad(toD.getDate())}`,
    months12: (() => {
      const out = [];
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
      }
      return out;
    })(),
  };
}

function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last   = new Date(y, m, 0).getDate();
  const pad    = n => String(n).padStart(2, '0');
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last)}` };
}

// ── GET /api/stores  (store list with filters) ────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  try {
    const isManager = ['manager', 'executive'].includes(req.session.role);
    const { q, grade, state, rep_id, visit_status } = req.query;

    let conditions = ['s.active = TRUE'];
    let params = [];
    let p = 1;

    if (!isManager) {
      conditions.push(`s.rep_id = $${p++}`);
      params.push(req.session.userId);
    } else if (rep_id) {
      conditions.push(`s.rep_id = $${p++}`);
      params.push(parseInt(rep_id));
    }

    if (q && q.trim()) {
      conditions.push(`s.name ILIKE $${p++}`);
      params.push(`%${q.trim()}%`);
    }
    if (grade) {
      conditions.push(`s.grade = $${p++}`);
      params.push(grade);
    }
    if (state) {
      conditions.push(`s.state = $${p++}`);
      params.push(state);
    }

    const { rows } = await db.query(`
      SELECT
        s.id, s.name, s.grade, s.channel_type, s.state, s.zoho_contact_id,
        s.rep_id, u.name AS rep_name,
        lv.visited_at AS last_visit_at,
        lv.note       AS last_visit_note,
        CASE
          WHEN lv.visited_at IS NULL THEN NULL
          ELSE EXTRACT(DAY FROM NOW() - lv.visited_at)::INTEGER
        END AS days_since_visit
      FROM stores s
      LEFT JOIN users u ON u.id = s.rep_id
      LEFT JOIN LATERAL (
        SELECT visited_at, note FROM visits
        WHERE store_id = s.id
        ORDER BY visited_at DESC
        LIMIT 1
      ) lv ON TRUE
      WHERE ${conditions.join(' AND ')}
      ORDER BY s.name ASC
    `, params);

    // visit_status filter (applied in JS so we can reuse for different categories)
    let result = rows;
    if (visit_status === 'ok') {
      result = rows.filter(r => r.days_since_visit !== null && r.days_since_visit <= 30);
    } else if (visit_status === 'amber') {
      result = rows.filter(r => r.days_since_visit !== null && r.days_since_visit > 30 && r.days_since_visit <= 60);
    } else if (visit_status === 'overdue') {
      result = rows.filter(r => r.days_since_visit === null || r.days_since_visit > 60);
    } else if (visit_status === 'never') {
      result = rows.filter(r => r.days_since_visit === null);
    }

    res.json(result);
  } catch (err) {
    console.error('Stores list error:', err.message);
    res.status(500).json({ error: 'Failed to load stores' });
  }
});

// ── GET /api/stores/new-doors  (must be before /:id) ─────────────────────────

router.get('/new-doors', requireAuth, async (req, res) => {
  try {
    const now  = new Date();
    const curM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const month = req.query.month || curM;

    const isManager = ['manager', 'executive'].includes(req.session.role);
    let filterRepId  = null;
    if (!isManager) {
      filterRepId = req.session.userId;
    } else if (req.query.rep_id) {
      filterRepId = parseInt(req.query.rep_id);
    }

    const { from: windowFrom, to: windowTo } = get12MonthWindow();
    const { from: mFrom, to: mTo } = monthBounds(month);

    // Fetch cached 12-month invoices
    const allInvoices = await fetchInvoices(windowFrom, windowTo);

    // Invoices in selected month vs prior months within the window
    const monthInvoices = allInvoices.filter(inv => inv.date >= mFrom && inv.date <= mTo);
    const priorInvoices = allInvoices.filter(inv => inv.date >= windowFrom && inv.date < mFrom);
    const priorCustomers = new Set(priorInvoices.map(inv => String(inv.customer_id)));

    // New door = customer invoiced this month, NOT seen in prior months of window
    const newDoorMap = new Map(); // customer_id → first (chronological) invoice this month
    for (const inv of monthInvoices.sort((a, b) => a.date.localeCompare(b.date))) {
      const cid = String(inv.customer_id);
      if (!priorCustomers.has(cid) && !newDoorMap.has(cid)) {
        newDoorMap.set(cid, inv);
      }
    }

    if (newDoorMap.size === 0) {
      return res.json({ month, doors: [], totals: { count: 0, value: 0 } });
    }

    // Batch-lookup store info for all new door customer IDs
    const contactIds = [...newDoorMap.keys()];
    const { rows: storeRows } = await db.query(
      `SELECT id, name, grade, state, rep_id, zoho_contact_id FROM stores
       WHERE zoho_contact_id = ANY($1)`,
      [contactIds]
    );
    const storeByContactId = {};
    for (const s of storeRows) storeByContactId[String(s.zoho_contact_id)] = s;

    // Load reps for name lookup
    const { rows: reps } = await db.query(
      `SELECT id, name, zoho_salesperson_id FROM users WHERE role = 'rep' AND active = TRUE`
    );
    const repBySp = {};
    for (const r of reps) {
      if (r.zoho_salesperson_id) repBySp[r.zoho_salesperson_id] = r;
      repBySp[r.name] = r;
    }

    const doors = [];
    for (const [cid, inv] of newDoorMap) {
      const store = storeByContactId[cid];
      const rep   = repBySp[inv.salesperson_name] || null;

      if (filterRepId && rep?.id !== filterRepId) continue;

      doors.push({
        customer_id:        cid,
        customer_name:      store?.name || inv.customer_name || '(unknown)',
        store_id:           store?.id   || null,
        grade:              store?.grade || null,
        state:              store?.state || null,
        rep_id:             rep?.id     || null,
        rep_name:           rep?.name   || inv.salesperson_name || '—',
        first_order_date:   inv.date,
        first_order_value:  Number(inv.total || 0),
      });
    }

    doors.sort((a, b) => b.first_order_value - a.first_order_value);

    res.json({
      month,
      doors,
      totals: {
        count: doors.length,
        value: Math.round(doors.reduce((s, d) => s + d.first_order_value, 0)),
      },
    });
  } catch (err) {
    console.error('New doors error:', err.message);
    res.status(500).json({ error: 'Failed to load new doors' });
  }
});

// ── GET /api/stores/:id  (store detail + revenue) ────────────────────────────

router.get('/:id', requireAuth, async (req, res) => {
  const storeId = parseInt(req.params.id);
  if (isNaN(storeId)) return res.status(400).json({ error: 'Invalid store id' });

  try {
    const isManager = ['manager', 'executive'].includes(req.session.role);

    const { rows: storeRows } = await db.query(`
      SELECT s.*, u.name AS rep_name
      FROM stores s
      LEFT JOIN users u ON u.id = s.rep_id
      WHERE s.id = $1 AND s.active = TRUE
    `, [storeId]);

    if (!storeRows[0]) return res.status(404).json({ error: 'Store not found' });
    const store = storeRows[0];

    if (!isManager && store.rep_id !== req.session.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Visit history (last 10)
    const { rows: visitRows } = await db.query(`
      SELECT v.id, v.visited_at, v.note, u.name AS rep_name
      FROM visits v
      JOIN users u ON u.id = v.rep_id
      WHERE v.store_id = $1
      ORDER BY v.visited_at DESC
      LIMIT 10
    `, [storeId]);

    // Revenue from cached invoices
    const { from: windowFrom, to: windowTo, months12 } = get12MonthWindow();
    const allInvoices = await fetchInvoices(windowFrom, windowTo);
    const storeInvoices = allInvoices.filter(
      inv => String(inv.customer_id) === String(store.zoho_contact_id)
    );

    // Monthly revenue breakdown
    const monthlyRevMap = {};
    for (const inv of storeInvoices) {
      const m = (inv.date || '').slice(0, 7);
      if (m) monthlyRevMap[m] = (monthlyRevMap[m] || 0) + Number(inv.total || 0);
    }
    const monthly_breakdown = months12.map(m => ({
      month: m,
      revenue: Math.round(monthlyRevMap[m] || 0),
    }));

    const revenue_12m = monthly_breakdown.reduce((s, r) => s + r.revenue, 0);

    // Trend: compare first half vs second half of the 12-month window
    const first6  = monthly_breakdown.slice(0, 6).reduce((s, r) => s + r.revenue, 0);
    const last6   = monthly_breakdown.slice(6).reduce((s, r)  => s + r.revenue, 0);
    const trend_pct = first6 > 0 ? Math.round(((last6 - first6) / first6) * 100) : null;

    // SKU count — distinct item names/IDs across all matched invoices
    const skuSet = new Set();
    for (const inv of storeInvoices) {
      for (const line of inv.line_items || []) {
        const key = line.item_id || line.item_name;
        if (key) skuSet.add(String(key));
      }
    }

    // Last order date
    const lastOrderDate = storeInvoices
      .map(inv => inv.date)
      .filter(Boolean)
      .sort()
      .pop() || null;

    res.json({
      id:               store.id,
      name:             store.name,
      grade:            store.grade,
      channel_type:     store.channel_type,
      state:            store.state,
      zoho_contact_id:  store.zoho_contact_id,
      rep_id:           store.rep_id,
      rep_name:         store.rep_name,
      last_synced_at:   store.last_synced_at,
      visit_history:    visitRows,
      revenue_12m,
      trend_pct,
      sku_count:        skuSet.size,
      last_order_date:  lastOrderDate,
      monthly_breakdown,
    });
  } catch (err) {
    console.error('Store detail error:', err.message);
    res.status(500).json({ error: 'Failed to load store' });
  }
});

module.exports = router;
