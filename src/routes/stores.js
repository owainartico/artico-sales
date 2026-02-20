'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
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
        s.id, s.name, s.grade, s.grade_locked, s.channel_type, s.state, s.zoho_contact_id,
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
      `SELECT id, name, zoho_salesperson_id, zoho_salesperson_ids FROM users WHERE role = 'rep' AND active = TRUE`
    );
    const repBySp = {};
    for (const r of reps) {
      const spNames = (Array.isArray(r.zoho_salesperson_ids) && r.zoho_salesperson_ids.length)
        ? r.zoho_salesperson_ids
        : (r.zoho_salesperson_id ? [r.zoho_salesperson_id] : [r.name]);
      for (const sp of spNames) repBySp[sp] = r;
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
        first_order_value:  Number(inv.sub_total || 0),
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

// ── GET /api/stores/grade-review  (manager/exec only) ────────────────────────

// Grade thresholds for 12-month rolling window
const GRADE_BENCH = {
  A: { revenue: 5000, orders: 6, sku: 20 },
  B: { revenue: 1500, orders: 3, sku:  8 },
};
// Expected visits per year per grade
const VISIT_MIN = { A: 4, B: 2, C: 0 };
const VISIT_MAX = { A: Infinity, B: 5, C: 3 };

function suggestGrade(revenue, orders, sku) {
  const score = (v, hi, lo) => v >= hi ? 2 : v >= lo ? 1 : 0;
  const total = (
    score(revenue, GRADE_BENCH.A.revenue, GRADE_BENCH.B.revenue) * 2 +
    score(orders,  GRADE_BENCH.A.orders,  GRADE_BENCH.B.orders)      +
    score(sku,     GRADE_BENCH.A.sku,     GRADE_BENCH.B.sku)
  ) / 4;
  return total >= 1.5 ? 'A' : total >= 0.5 ? 'B' : 'C';
}

function visitMismatch(grade, visitCount) {
  const g = grade || 'C';
  if (visitCount < VISIT_MIN[g]) return 'under';
  if (visitCount > VISIT_MAX[g]) return 'over';
  return null;
}

const GRADE_ORDER = { A: 0, B: 1, C: 2 };

router.get('/grade-review', requireAuth, requireRole('manager', 'executive'), async (req, res) => {
  try {
    const { from: windowFrom, to: windowTo } = get12MonthWindow();

    const [allInvoices, { rows: stores }, { rows: visitRows }] = await Promise.all([
      fetchInvoices(windowFrom, windowTo),
      db.query(`
        SELECT s.id, s.name, s.grade, s.state, s.zoho_contact_id, s.rep_id, u.name AS rep_name
        FROM stores s
        LEFT JOIN users u ON u.id = s.rep_id
        WHERE s.active = TRUE
        ORDER BY s.name
      `),
      db.query(`
        SELECT store_id, COUNT(*)::INTEGER AS visit_count
        FROM visits
        WHERE visited_at >= $1
        GROUP BY store_id
      `, [windowFrom]),
    ]);

    const visitByStore = {};
    for (const r of visitRows) visitByStore[r.store_id] = r.visit_count;

    // Build customer_id → invoices map for O(1) per-store lookup
    const invoicesByCustomer = new Map();
    for (const inv of allInvoices) {
      const cid = String(inv.customer_id);
      if (!invoicesByCustomer.has(cid)) invoicesByCustomer.set(cid, []);
      invoicesByCustomer.get(cid).push(inv);
    }

    const upgrades = [], downgrades = [], visit_mismatch = [];

    for (const store of stores) {
      const storeInvs = invoicesByCustomer.get(String(store.zoho_contact_id)) || [];
      const revenue_12m = storeInvs.reduce((s, i) => s + Number(i.sub_total || 0), 0);
      const order_count = storeInvs.length;

      const skuSet = new Set();
      for (const inv of storeInvs) {
        for (const line of inv.line_items || []) {
          if (line.item_id) skuSet.add(String(line.item_id));
        }
      }
      const sku_depth = skuSet.size;
      const visit_count = visitByStore[store.id] || 0;

      const current   = store.grade || null;
      const suggested = suggestGrade(revenue_12m, order_count, sku_depth);
      const vm        = visitMismatch(current, visit_count);

      const row = {
        store_id:                store.id,
        name:                    store.name,
        state:                   store.state,
        rep_id:                  store.rep_id,
        rep_name:                store.rep_name,
        current_grade:           current,
        suggested_grade:         suggested,
        metrics: {
          revenue_12m:  Math.round(revenue_12m),
          order_count,
          sku_depth,
          visit_count,
        },
        visit_mismatch:           !!vm,
        visit_mismatch_direction: vm,
      };

      if (current && suggested !== current) {
        if (GRADE_ORDER[suggested] < GRADE_ORDER[current]) {
          upgrades.push(row);
        } else {
          downgrades.push(row);
        }
      }
      if (vm) visit_mismatch.push(row);
    }

    const byRevDesc = (a, b) => b.metrics.revenue_12m - a.metrics.revenue_12m;
    upgrades.sort(byRevDesc);
    downgrades.sort(byRevDesc);
    visit_mismatch.sort(byRevDesc);

    res.json({
      upgrades,
      downgrades,
      visit_mismatch,
      summary: {
        upgrades:      upgrades.length,
        downgrades:    downgrades.length,
        visit_mismatch: visit_mismatch.length,
      },
    });
  } catch (err) {
    console.error('Grade review error:', err.message);
    res.status(500).json({ error: 'Failed to load grade review' });
  }
});

// ── PATCH /api/stores/:id/lock-grade  (manager/exec only) ────────────────────

router.patch('/:id/lock-grade', requireAuth, requireRole('manager', 'executive'), async (req, res) => {
  const storeId = parseInt(req.params.id);
  if (isNaN(storeId)) return res.status(400).json({ error: 'Invalid store id' });

  const locked = req.body?.locked === true;
  try {
    const { rows } = await db.query(
      `UPDATE stores SET grade_locked = $1 WHERE id = $2 AND active = TRUE RETURNING id, grade_locked`,
      [locked, storeId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Store not found' });

    // Log the lock/unlock action in grade_history
    const { logGradeChange } = require('../services/grading');
    const { rows: storeRows } = await db.query(`SELECT grade FROM stores WHERE id = $1`, [storeId]);
    const changedBy = req.session.userId ? String(req.session.userId) : 'user';
    await logGradeChange(
      storeId, storeRows[0]?.grade, storeRows[0]?.grade,
      locked ? 'Grade manually locked' : 'Grade lock removed',
      changedBy, locked
    ).catch(() => {}); // non-fatal

    res.json({ ok: true, store_id: storeId, grade_locked: locked });
  } catch (err) {
    console.error('Lock grade error:', err.message);
    res.status(500).json({ error: 'Failed to update grade lock' });
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

    // Grade history (last 10 entries)
    const { rows: gradeHistRows } = await db.query(`
      SELECT id, old_grade, new_grade, reason, changed_at, changed_by, locked
      FROM grade_history
      WHERE store_id = $1
      ORDER BY changed_at DESC
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
      if (m) monthlyRevMap[m] = (monthlyRevMap[m] || 0) + Number(inv.sub_total || 0);
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
      grade_locked:     store.grade_locked || false,
      channel_type:     store.channel_type,
      state:            store.state,
      zoho_contact_id:  store.zoho_contact_id,
      rep_id:           store.rep_id,
      rep_name:         store.rep_name,
      last_synced_at:   store.last_synced_at,
      visit_history:    visitRows,
      grade_history:    gradeHistRows,
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
