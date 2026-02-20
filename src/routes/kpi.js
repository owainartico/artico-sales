'use strict';

/**
 * KPI Incentive Tracker routes.
 *
 * GET  /api/kpi/targets          – List all incentive targets (manager/exec)
 * POST /api/kpi/targets          – Upsert targets for a rep/quarter/year (manager/exec)
 * GET  /api/kpi/my               – KPI progress for the current user (any rep)
 * GET  /api/kpi/team             – All reps KPI summary (manager/exec)
 * GET  /api/kpi/team/csv         – CSV export of team KPIs (manager/exec)
 * POST /api/kpi/weekly-plan      – Submit weekly plan flag for current week (any rep)
 */

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const db = require('../db');
const { fetchInvoicesWithTimeout } = require('../services/sync');

const router = express.Router();

// ── Quarter / window helpers ──────────────────────────────────────────────────

function currentQuarter() {
  const now = new Date();
  return {
    quarter: Math.ceil((now.getMonth() + 1) / 3),
    year:    now.getFullYear(),
  };
}

function quarterDateRange(quarter, year) {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth   = quarter * 3;
  const pad        = n => String(n).padStart(2, '0');
  const endDay     = new Date(year, endMonth, 0).getDate();
  return {
    from: `${year}-${pad(startMonth)}-01`,
    to:   `${year}-${pad(endMonth)}-${pad(endDay)}`,
  };
}

/** Returns the same 18m window pre-warmed by the scheduler → cache hit. */
function get18mWindow() {
  const now  = new Date();
  const toD  = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const fromD = new Date(now.getFullYear(), now.getMonth() - 17, 1);
  const pad  = n => String(n).padStart(2, '0');
  return {
    from: `${fromD.getFullYear()}-${pad(fromD.getMonth() + 1)}-01`,
    to:   `${toD.getFullYear()}-${pad(toD.getMonth() + 1)}-${pad(toD.getDate())}`,
  };
}

/** ISO Monday of the current week. */
function currentWeekStart() {
  const now = new Date();
  const day = now.getDay() || 7;           // 1=Mon … 7=Sun
  const mon = new Date(now);
  mon.setDate(now.getDate() - day + 1);
  return mon.toISOString().slice(0, 10);   // YYYY-MM-DD
}

// ── Resolve rep salesperson names (supports multi-name via zoho_salesperson_ids) ─

async function repSpNames(repId) {
  const { rows } = await db.query(
    `SELECT zoho_salesperson_id, zoho_salesperson_ids FROM users WHERE id = $1`,
    [repId]
  );
  if (!rows[0]) return [];
  const u = rows[0];
  if (Array.isArray(u.zoho_salesperson_ids) && u.zoho_salesperson_ids.length) {
    return u.zoho_salesperson_ids;
  }
  return [u.zoho_salesperson_id].filter(Boolean);
}

// ── Core KPI calculation ──────────────────────────────────────────────────────

/**
 * Calculate all 5 KPIs for a single rep.
 *
 * @param {number}   repId
 * @param {object[]} invoices   – 18m invoice array (from cache)
 * @param {object}   targets    – { new_customers, reactivations, coverage_pct, growth_pct }
 * @param {number}   quarter
 * @param {number}   year
 */
async function calcKpi(repId, invoices, targets, quarter, year) {
  const spNames = await repSpNames(repId);
  const { from: qFrom, to: qTo } = quarterDateRange(quarter, year);
  const { from: lyFrom, to: lyTo } = quarterDateRange(quarter, year - 1);

  // ── 1. New customers ──────────────────────────────────────────────────────
  // Contacts with a rep invoice in current quarter but NO prior invoice in the
  // 18m window (best-effort new customer check using cached data).
  const repInvoices = invoices.filter(i => spNames.includes(i.salesperson_name));
  const qContacts   = new Set(
    repInvoices.filter(i => i.date >= qFrom && i.date <= qTo)
               .map(i => String(i.customer_id))
  );
  const priorContacts = new Set(
    repInvoices.filter(i => i.date < qFrom)
               .map(i => String(i.customer_id))
  );
  const newCustomers = [...qContacts].filter(c => !priorContacts.has(c)).length;

  // ── 2. Reactivations ──────────────────────────────────────────────────────
  // Customer ordered in current quarter AND no order in the 6 months before
  // the quarter start (dormant for at least 6 months → reactivation signal).
  const sixMoBeforeQ = new Date(qFrom);
  sixMoBeforeQ.setMonth(sixMoBeforeQ.getMonth() - 6);
  const dormancyFrom = sixMoBeforeQ.toISOString().slice(0, 10);

  const dormantContacts = new Set(
    repInvoices
      .filter(i => i.date >= dormancyFrom && i.date < qFrom)
      .map(i => String(i.customer_id))
  );
  // Contacts active in quarter that were dormant in the 6m window before
  const reactivations = [...qContacts].filter(c => !dormantContacts.has(c) && priorContacts.has(c)).length;

  // ── 3. Territory coverage (grade-dependent visit windows) ─────────────────
  const { rows: covRows } = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE
        (s.grade = 'A' AND last_v.last_visit >= NOW() - INTERVAL '42 days') OR
        (s.grade IN ('B','C') AND last_v.last_visit >= NOW() - INTERVAL '84 days')
      )::INTEGER AS covered,
      COUNT(*)::INTEGER AS total
    FROM stores s
    LEFT JOIN (
      SELECT store_id, MAX(visited_at) AS last_visit
      FROM visits
      GROUP BY store_id
    ) last_v ON last_v.store_id = s.id
    WHERE s.rep_id = $1
      AND s.active = TRUE
      AND s.is_prospect = FALSE
      AND s.grade IN ('A','B','C')
  `, [repId]);

  const covData   = covRows[0] || { covered: 0, total: 0 };
  const covPct    = covData.total > 0 ? Math.round((covData.covered / covData.total) * 100) : 0;

  // ── 4. Weekly plan ────────────────────────────────────────────────────────
  const weekStart = currentWeekStart();
  const { rows: planRows } = await db.query(
    `SELECT submitted_at FROM weekly_plans WHERE rep_id = $1 AND week_start = $2`,
    [repId, weekStart]
  );
  const weeklyPlanSubmitted = planRows.length > 0;

  // ── 5. Territory growth (quarter vs same quarter LY, by store contacts) ───
  const { rows: storeRows } = await db.query(
    `SELECT zoho_contact_id FROM stores WHERE rep_id = $1 AND active = TRUE AND is_prospect = FALSE`,
    [repId]
  );
  const contactIds = new Set(storeRows.map(r => String(r.zoho_contact_id)));

  let qRevenue = 0, lyRevenue = 0;
  for (const inv of invoices) {
    if (!contactIds.has(String(inv.customer_id))) continue;
    const total = Number(inv.sub_total || 0);
    if (inv.date >= qFrom && inv.date <= qTo)   qRevenue  += total;
    if (inv.date >= lyFrom && inv.date <= lyTo) lyRevenue += total;
  }
  const growthPct = lyRevenue > 0
    ? Math.round(((qRevenue - lyRevenue) / lyRevenue) * 100)
    : null;

  return {
    new_customers: {
      actual: newCustomers,
      target: targets.new_customers,
      pct:    targets.new_customers > 0 ? Math.round((newCustomers / targets.new_customers) * 100) : null,
    },
    reactivations: {
      actual: reactivations,
      target: targets.reactivations,
      pct:    targets.reactivations > 0 ? Math.round((reactivations / targets.reactivations) * 100) : null,
    },
    coverage: {
      covered:        covData.covered,
      total:          covData.total,
      pct:            covPct,
      target_pct:     targets.coverage_pct,
      on_track:       covPct >= targets.coverage_pct,
    },
    weekly_plan: {
      submitted:  weeklyPlanSubmitted,
      week_start: weekStart,
    },
    growth: {
      current_quarter: Math.round(qRevenue),
      ly_quarter:      Math.round(lyRevenue),
      pct:             growthPct,
      target_pct:      targets.growth_pct,
    },
  };
}

/** Default targets (used when no row exists in incentive_targets). */
const DEFAULTS = { new_customers: 5, reactivations: 5, coverage_pct: 90, growth_pct: 5 };

async function getTargetsForRep(repId, quarter, year) {
  const { rows } = await db.query(
    `SELECT new_customers, reactivations, coverage_pct, growth_pct
     FROM incentive_targets WHERE rep_id = $1 AND quarter = $2 AND year = $3`,
    [repId, quarter, year]
  );
  return rows[0] || { ...DEFAULTS };
}

// ── GET /api/kpi/targets ──────────────────────────────────────────────────────

router.get('/targets', requireAuth, requireRole('manager', 'executive'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT it.*, u.name AS rep_name
      FROM incentive_targets it
      JOIN users u ON u.id = it.rep_id
      ORDER BY u.name, it.year DESC, it.quarter DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('[kpi] GET targets error:', err.message);
    res.status(500).json({ error: 'Failed to load KPI targets' });
  }
});

// ── POST /api/kpi/targets ─────────────────────────────────────────────────────

router.post('/targets', requireAuth, requireRole('manager', 'executive'), async (req, res) => {
  try {
    const { rep_id, quarter, year, new_customers, reactivations, coverage_pct, growth_pct } = req.body;

    if (!rep_id || !quarter || !year) {
      return res.status(400).json({ error: 'rep_id, quarter, and year are required' });
    }
    if (quarter < 1 || quarter > 4) return res.status(400).json({ error: 'Invalid quarter' });

    const nc  = Math.max(0, parseInt(new_customers)  ?? DEFAULTS.new_customers);
    const r   = Math.max(0, parseInt(reactivations)  ?? DEFAULTS.reactivations);
    const cov = Math.min(100, Math.max(0, parseInt(coverage_pct) ?? DEFAULTS.coverage_pct));
    const g   = parseInt(growth_pct) ?? DEFAULTS.growth_pct;

    const { rows } = await db.query(`
      INSERT INTO incentive_targets
        (rep_id, quarter, year, new_customers, reactivations, coverage_pct, growth_pct, set_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (rep_id, quarter, year) DO UPDATE SET
        new_customers = EXCLUDED.new_customers,
        reactivations = EXCLUDED.reactivations,
        coverage_pct  = EXCLUDED.coverage_pct,
        growth_pct    = EXCLUDED.growth_pct,
        set_by        = EXCLUDED.set_by,
        updated_at    = NOW()
      RETURNING *
    `, [rep_id, quarter, year, nc, r, cov, g, req.session.userId]);

    res.json(rows[0]);
  } catch (err) {
    console.error('[kpi] POST targets error:', err.message);
    res.status(500).json({ error: 'Failed to save KPI target' });
  }
});

// ── GET /api/kpi/my ───────────────────────────────────────────────────────────

router.get('/my', requireAuth, async (req, res) => {
  try {
    const repId = req.session.userId;
    const { quarter, year } = currentQuarter();
    const { from, to } = get18mWindow();

    const [invoices, targets] = await Promise.all([
      fetchInvoicesWithTimeout(from, to).catch((err) => {
        console.error('[kpi] my: invoice fetch failed:', err.message);
        return [];
      }),
      getTargetsForRep(repId, quarter, year),
    ]);

    const actuals = await calcKpi(repId, invoices, targets, quarter, year);
    const qLabel  = `Q${quarter} ${year}`;

    res.json({ quarter, year, quarter_label: qLabel, targets, actuals });
  } catch (err) {
    console.error('[kpi] GET my error:', err.message);
    res.status(500).json({ error: 'Failed to load KPI progress' });
  }
});

// ── GET /api/kpi/team ─────────────────────────────────────────────────────────

router.get('/team', requireAuth, requireRole('manager', 'executive'), async (req, res) => {
  try {
    const { quarter, year } = currentQuarter();
    const { from, to } = get18mWindow();

    const [invoices, { rows: reps }, { rows: allTargets }] = await Promise.all([
      fetchInvoicesWithTimeout(from, to).catch((err) => {
        console.error('[kpi] team: invoice fetch failed:', err.message);
        return [];
      }),
      db.query(`SELECT id, name FROM users WHERE role = 'rep' AND active = TRUE ORDER BY name`),
      db.query(
        `SELECT * FROM incentive_targets WHERE quarter = $1 AND year = $2`,
        [quarter, year]
      ),
    ]);

    const targetsById = {};
    for (const t of allTargets) targetsById[t.rep_id] = t;

    const repKpis = await Promise.all(
      reps.map(async rep => {
        const targets = targetsById[rep.id] || { ...DEFAULTS };
        const actuals = await calcKpi(rep.id, invoices, targets, quarter, year);
        return { rep_id: rep.id, name: rep.name, targets, actuals };
      })
    );

    res.json({ quarter, year, quarter_label: `Q${quarter} ${year}`, reps: repKpis });
  } catch (err) {
    console.error('[kpi] GET team error:', err.message);
    res.status(500).json({ error: 'Failed to load team KPIs' });
  }
});

// ── GET /api/kpi/team/csv ─────────────────────────────────────────────────────

router.get('/team/csv', requireAuth, requireRole('manager', 'executive'), async (req, res) => {
  try {
    const { quarter, year } = currentQuarter();
    const { from, to } = get18mWindow();

    const [invoices, { rows: reps }, { rows: allTargets }] = await Promise.all([
      fetchInvoicesWithTimeout(from, to).catch(() => []),
      db.query(`SELECT id, name FROM users WHERE role = 'rep' AND active = TRUE ORDER BY name`),
      db.query(`SELECT * FROM incentive_targets WHERE quarter = $1 AND year = $2`, [quarter, year]),
    ]);

    const targetsById = {};
    for (const t of allTargets) targetsById[t.rep_id] = t;

    const rows = await Promise.all(
      reps.map(async rep => {
        const targets = targetsById[rep.id] || { ...DEFAULTS };
        const a = await calcKpi(rep.id, invoices, targets, quarter, year);
        return [
          rep.name,
          a.new_customers.actual, a.new_customers.target,
          a.reactivations.actual, a.reactivations.target,
          `${a.coverage.covered}/${a.coverage.total}`, `${a.coverage.pct}%`, `${a.coverage.target_pct}%`,
          a.weekly_plan.submitted ? 'Yes' : 'No',
          a.growth.pct !== null ? `${a.growth.pct}%` : 'N/A', `${a.growth.target_pct}%`,
        ].join(',');
      })
    );

    const header = 'Rep,New Cust Actual,New Cust Target,Reactivations Actual,Reactivations Target,Coverage (visited/total),Coverage %,Coverage Target,Weekly Plan,Growth %,Growth Target';
    const csv = [header, ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="kpi-Q${quarter}-${year}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[kpi] CSV error:', err.message);
    res.status(500).json({ error: 'Failed to generate CSV' });
  }
});

// ── POST /api/kpi/weekly-plan ─────────────────────────────────────────────────

router.post('/weekly-plan', requireAuth, async (req, res) => {
  try {
    const repId    = req.session.userId;
    const weekStart = currentWeekStart();

    await db.query(
      `INSERT INTO weekly_plans (rep_id, week_start, submitted_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (rep_id, week_start) DO UPDATE SET submitted_at = NOW()`,
      [repId, weekStart]
    );

    res.json({ ok: true, week_start: weekStart });
  } catch (err) {
    console.error('[kpi] POST weekly-plan error:', err.message);
    res.status(500).json({ error: 'Failed to submit weekly plan' });
  }
});

module.exports = router;
