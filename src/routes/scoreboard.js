'use strict';

/**
 * Public Scoreboard — visible to all authenticated users.
 *
 * Shows ONLY:
 *   1. Revenue per Visit ranking
 *   2. Territory Growth % (last 6m vs first 6m of the 12m window)
 *   3. New Doors this month
 *   4. Reactivation Revenue % (revenue from reactivated stores / total)
 *
 * DOES NOT expose: raw revenue, churn flags, store-level data,
 * coaching metrics, or conversion rates.
 */

const express      = require('express');
const { requireAuth } = require('../middleware/auth');
const db           = require('../db');
const { fetchInvoices, invAmount } = require('../services/sync');

const router = express.Router();

function get12MonthWindow() {
  const now = new Date();
  const toD = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const frD = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const pad = n => String(n).padStart(2, '0');
  return {
    from: `${frD.getFullYear()}-${pad(frD.getMonth() + 1)}-01`,
    to:   `${toD.getFullYear()}-${pad(toD.getMonth() + 1)}-${pad(toD.getDate())}`,
  };
}

// ── GET /api/scoreboard ───────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  try {
    const { from, to } = get12MonthWindow();
    const now  = new Date();
    const curM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Midpoint of the 12m window
    const mid = (() => {
      const d = new Date(now.getFullYear(), now.getMonth() - 5, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    })();

    // All active reps
    const { rows: reps } = await db.query(
      `SELECT id, name, zoho_salesperson_id, zoho_salesperson_ids FROM users
       WHERE role = 'rep' AND active = TRUE ORDER BY name`
    );

    // Visits per rep (12m)
    const { rows: visitRows } = await db.query(
      `SELECT rep_id, COUNT(*)::INTEGER AS visit_count
       FROM visits WHERE visited_at >= $1 GROUP BY rep_id`,
      [from]
    );
    const visitsByRep = {};
    for (const v of visitRows) visitsByRep[v.rep_id] = v.visit_count;

    // New doors this month — visits + invoices combined
    // We count distinct stores with first-ever invoice in curM
    const { rows: newDoorVisits } = await db.query(
      `SELECT rep_id, COUNT(DISTINCT store_id)::INTEGER AS cnt
       FROM visits
       WHERE DATE_TRUNC('month', visited_at) = DATE_TRUNC('month', NOW())
       GROUP BY rep_id`
    );
    const newDoorsByVisit = {};
    for (const r of newDoorVisits) newDoorsByVisit[r.rep_id] = r.cnt;

    // Invoice data for revenue calculations
    const invoices = await fetchInvoices(from, to);

    // Build rep name → rep id mapping
    const repByName = {};
    const repById   = {};
    for (const r of reps) {
      repById[r.id] = r;
      const spNames = (Array.isArray(r.zoho_salesperson_ids) && r.zoho_salesperson_ids.length)
        ? r.zoho_salesperson_ids
        : (r.zoho_salesperson_id ? [r.zoho_salesperson_id] : [r.name]);
      for (const sp of spNames) repByName[sp] = r.id;
    }

    // Per-rep invoice buckets
    const rev12m  = {}; // total 12m
    const revFirst6 = {}; // first 6m (from → mid)
    const revLast6  = {}; // last 6m (mid → to)

    // All customers seen before last 3 months (for reactivation calculation)
    const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, 1).toISOString().slice(0, 10);
    const sixMonthsAgo   = new Date(now.getFullYear(), now.getMonth() - 6, 1).toISOString().slice(0, 10);

    // customer_id → last invoice date before the 3m window
    const lastOrderBeforeWindow = {};
    // customer_id → revenue in last 3m
    const recentRevByCust = {};
    // per-rep totals for reactivation
    const reactivationRev = {};
    const totalRevPerRep  = {};

    for (const inv of invoices) {
      const repId = repByName[inv.salesperson_name];
      if (!repId) continue;
      const cid = String(inv.customer_id);

      const total = invAmount(inv);
      rev12m[repId]  = (rev12m[repId]  || 0) + total;
      totalRevPerRep[repId] = (totalRevPerRep[repId] || 0) + total;

      if (inv.date && inv.date < mid) {
        revFirst6[repId] = (revFirst6[repId] || 0) + total;
      } else {
        revLast6[repId]  = (revLast6[repId]  || 0) + total;
      }

      // Reactivation: track per-customer last order before 3m window
      if (inv.date && inv.date < threeMonthsAgo) {
        if (!lastOrderBeforeWindow[cid] || inv.date > lastOrderBeforeWindow[cid]) {
          lastOrderBeforeWindow[cid] = inv.date;
        }
      }
      if (inv.date && inv.date >= threeMonthsAgo) {
        recentRevByCust[cid] = (recentRevByCust[cid] || 0) + total;
        // Track which rep got this revenue
        if (!recentRevByCust[`${cid}_rep`]) recentRevByCust[`${cid}_rep`] = repId;
      }
    }

    // Identify reactivated customers: had order 6-12m ago, nothing 3-6m ago, but ordered in last 3m
    for (const [cid, lastBefore] of Object.entries(lastOrderBeforeWindow)) {
      if (lastBefore < sixMonthsAgo) continue; // too old — not a recent churn
      const recentRev = recentRevByCust[cid] || 0;
      if (recentRev === 0) continue; // didn't reactivate
      const repId = recentRevByCust[`${cid}_rep`];
      if (!repId) continue;
      reactivationRev[repId] = (reactivationRev[repId] || 0) + recentRev;
    }

    // New doors from invoices: first-ever invoice in curM, no prior invoice
    const newDoorInvoice = {};
    {
      const priorCustomers = new Set(
        invoices.filter(inv => (inv.date || '') < `${curM}-01`).map(inv => String(inv.customer_id))
      );
      const thisMonthInvoices = invoices.filter(inv => (inv.date || '').startsWith(curM));
      for (const inv of thisMonthInvoices) {
        const cid   = String(inv.customer_id);
        if (priorCustomers.has(cid)) continue;
        const repId = repByName[inv.salesperson_name];
        if (!repId) continue;
        if (!newDoorInvoice[repId]) newDoorInvoice[repId] = new Set();
        newDoorInvoice[repId].add(cid);
      }
    }

    // Assemble scoreboard rows
    const rows = reps.map(rep => {
      const visits  = visitsByRep[rep.id] || 0;
      const r12m    = rev12m[rep.id]      || 0;
      const first6  = revFirst6[rep.id]   || 0;
      const last6   = revLast6[rep.id]    || 0;
      const reactivated = reactivationRev[rep.id] || 0;
      const totalRev    = totalRevPerRep[rep.id]  || 0;
      const newDoors    = (newDoorInvoice[rep.id]?.size || 0);

      const revPerVisit = visits > 0 ? Math.round(r12m / visits) : 0;
      const growthPct   = first6 > 0 ? Math.round(((last6 - first6) / first6) * 100) : null;
      const reactivationPct = totalRev > 0 ? Math.round((reactivated / totalRev) * 100) : 0;

      return {
        repId:            rep.id,
        name:             rep.name,
        revPerVisit,
        visitCount:       visits,
        growthPct,
        newDoors,
        reactivationPct,
      };
    });

    // Rank each metric (exclude reps with no data from top spots)
    function rank(arr, key, descending = true) {
      return [...arr]
        .sort((a, b) => descending
          ? (b[key] ?? -Infinity) - (a[key] ?? -Infinity)
          : (a[key] ?? Infinity)  - (b[key] ?? Infinity))
        .map((r, i) => ({ ...r, [`${key}Rank`]: i + 1 }));
    }

    // Apply ranks
    const withRanks = rows.map(r => ({
      ...r,
      revPerVisitRank:      rank(rows, 'revPerVisit').find(x => x.repId === r.repId).revPerVisitRank,
      growthPctRank:        rank(rows, 'growthPct').find(x => x.repId === r.repId).growthPctRank,
      newDoorsRank:         rank(rows, 'newDoors').find(x => x.repId === r.repId).newDoorsRank,
      reactivationPctRank:  rank(rows, 'reactivationPct').find(x => x.repId === r.repId).reactivationPctRank,
    }));

    res.json({
      period: { from, to },
      reps:   withRanks,
    });
  } catch (err) {
    console.error('Scoreboard error:', err.message);
    res.status(500).json({ error: 'Failed to load scoreboard' });
  }
});

module.exports = router;
