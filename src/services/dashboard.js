'use strict';

/**
 * Dashboard data service.
 * Aggregates Zoho invoice data + local DB stats into dashboard payloads.
 * Results are cached in memory for 15 minutes.
 *
 * Exports:
 *   getRepDashboard(repId, month, { force })  → rep dashboard payload
 *   getTeamDashboard(month, { force })        → team dashboard payload
 *   invalidateCache(key?)                     → clear one key or all
 */

const db                              = require('../db');
const { fetchInvoices, fetchItemBrandMap } = require('./sync');

// ── In-memory cache ───────────────────────────────────────────────────────────

const _cache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

function getCached(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL) { _cache.delete(key); return null; }
  return entry.data;
}

function setCached(key, data) {
  _cache.set(key, { data, fetchedAt: Date.now() });
}

function invalidateCache(key) {
  if (key) _cache.delete(key);
  else _cache.clear();
}

// ── Date utilities ────────────────────────────────────────────────────────────

function currentMonth() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}

function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const mm = String(m).padStart(2, '0');
  const ll = String(last).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${ll}` };
}

/** Returns the 12 months ending at (and including) endMonth, oldest first. */
function last12Months(endMonth) {
  const [y, m] = endMonth.split('-').map(Number);
  const out = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(y, m - 1 - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** One month before ym */
function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Days-remaining stats for current month */
function runRateStats(ym, actual, target) {
  const now = new Date();
  const [y, m] = ym.split('-').map(Number);
  const total = new Date(y, m, 0).getDate();
  const isCurrent = now.getFullYear() === y && now.getMonth() + 1 === m;
  const elapsed   = isCurrent ? now.getDate() : total;
  const remaining = isCurrent ? Math.max(0, total - now.getDate()) : 0;
  return {
    days_remaining:       remaining,
    daily_run_rate:       elapsed   > 0 ? Math.round(actual / elapsed)            : 0,
    required_daily_rate:  remaining > 0 ? Math.round((target - actual) / remaining) : 0,
  };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function salespersonName(repId) {
  const { rows } = await db.query(
    `SELECT name, zoho_salesperson_id FROM users WHERE id = $1`, [repId]
  );
  if (!rows[0]) return null;
  return rows[0].zoho_salesperson_id || rows[0].name;
}

async function lastSyncAt() {
  const { rows } = await db.query(
    `SELECT completed_at FROM zoho_sync_log
     WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1`
  );
  return rows[0]?.completed_at || null;
}

async function visitsThisMonth(repId, monthFrom) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n FROM visits WHERE rep_id = $1 AND visited_at >= $2`,
    [repId, monthFrom]
  );
  return parseInt(rows[0].n);
}

async function overdueStoreCount(repId) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n FROM stores s
     WHERE s.rep_id = $1 AND s.active = TRUE
     AND NOT EXISTS (
       SELECT 1 FROM visits v
       WHERE v.store_id = s.id AND v.visited_at >= NOW() - INTERVAL '60 days'
     )`, [repId]
  );
  return parseInt(rows[0].n);
}

// ── Invoice crunching ─────────────────────────────────────────────────────────

/** Sum invoices by month for one salesperson → { 'YYYY-MM': amount } */
function byMonth(invoices, spName) {
  const out = {};
  for (const inv of invoices) {
    if (inv.salesperson_name !== spName) continue;
    const m = (inv.date || '').slice(0, 7);
    if (m) out[m] = (out[m] || 0) + Number(inv.total || 0);
  }
  return out;
}

/** Convert a brand display name to a URL-safe slug for DB lookups */
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Sum invoice line item totals grouped by brand name.
 * Uses an item_id → brand_name map fetched from Zoho item catalog.
 * Returns { [brandName]: totalAmount }
 */
function buildBrandTotals(invoices, itemBrandMap) {
  const totals = {};
  for (const inv of invoices) {
    for (const line of inv.line_items || []) {
      const brand = itemBrandMap.get(String(line.item_id || ''));
      if (!brand) continue;
      totals[brand] = (totals[brand] || 0) + Number(line.item_total || 0);
    }
  }
  return totals;
}

/**
 * Approximate new-door count: customers invoiced this month by this rep
 * that don't appear in any earlier invoice in the dataset (best-effort, 12-month window).
 */
function newDoorCount(invoices, spName, monthFrom, monthTo) {
  if (!spName) return 0;
  const thisMonth = new Set(
    invoices
      .filter(i => i.salesperson_name === spName && i.date >= monthFrom && i.date <= monthTo)
      .map(i => String(i.customer_id)).filter(Boolean)
  );
  const prior = new Set(
    invoices
      .filter(i => i.salesperson_name === spName && i.date < monthFrom)
      .map(i => String(i.customer_id)).filter(Boolean)
  );
  let n = 0;
  for (const id of thisMonth) if (!prior.has(id)) n++;
  return n;
}

// ── Rep dashboard ─────────────────────────────────────────────────────────────

async function getRepDashboard(repId, month = currentMonth(), { force = false } = {}) {
  const key = `rep-${repId}-${month}`;
  if (!force) { const c = getCached(key); if (c) return c; }

  const spName   = await salespersonName(repId);
  const months12 = last12Months(month);
  const { from: histFrom }  = monthBounds(months12[0]);
  const { from: mFrom, to: mTo } = monthBounds(month);
  const yearStart = `${month.slice(0, 4)}-01-01`;

  // ── Parallel fetches ──
  const [invoices, mTargetRow, ytdTargets, histTargets, visits, overdue, syncAt] = await Promise.all([
    fetchInvoices(histFrom, mTo).catch(() => []),
    db.query(`SELECT amount FROM revenue_targets WHERE rep_id=$1 AND month=$2`, [repId, month]),
    db.query(
      `SELECT SUM(amount) AS total FROM revenue_targets
       WHERE rep_id=$1 AND month>=$2 AND month<=$3`,
      [repId, yearStart.slice(0, 7), month]
    ),
    db.query(
      `SELECT month, amount FROM revenue_targets WHERE rep_id=$1 AND month=ANY($2)`,
      [repId, months12]
    ),
    visitsThisMonth(repId, mFrom),
    overdueStoreCount(repId),
    lastSyncAt(),
  ]);

  const target     = Number(mTargetRow.rows[0]?.amount || 0);
  const ytd_target = Number(ytdTargets.rows[0]?.total  || 0);

  const actuals    = byMonth(invoices, spName || '');
  const actual     = actuals[month] || 0;
  const percentage = target > 0 ? Math.round((actual / target) * 100) : null;

  // YTD actual = sum from Jan to current month
  const ytd_actual = Object.entries(actuals)
    .filter(([m]) => m >= yearStart.slice(0, 7) && m <= month)
    .reduce((s, [, v]) => s + v, 0);

  // Monthly history
  const targetByM = {};
  for (const r of histTargets.rows) targetByM[r.month] = Number(r.amount);
  const monthly_history = months12.map(m => ({
    month: m,
    actual: actuals[m] || 0,
    target: targetByM[m] || 0,
  }));

  // Brand breakdown (current month only) — dynamic from item catalog
  const mInvoices = invoices.filter(i => i.salesperson_name === (spName || '') && i.date >= mFrom && i.date <= mTo);
  const itemBrandMap = await fetchItemBrandMap().catch(() => new Map());
  const brandTotalsMap = buildBrandTotals(mInvoices, itemBrandMap);
  const totalBrandRev = Object.values(brandTotalsMap).reduce((s, v) => s + v, 0);
  const brand_breakdown = Object.entries(brandTotalsMap)
    .map(([name, actual]) => ({
      slug: slugify(name),
      name,
      actual,
      pct_of_total: totalBrandRev > 0 ? Math.round((actual / totalBrandRev) * 100) : 0,
    }))
    .sort((a, b) => b.actual - a.actual);

  const result = {
    month,
    hero: {
      actual, target, percentage,
      ...runRateStats(month, actual, target),
    },
    ytd: {
      actual: ytd_actual,
      target: ytd_target,
      percentage: ytd_target > 0 ? Math.round((ytd_actual / ytd_target) * 100) : null,
    },
    monthly_history,
    brand_breakdown,
    quick_stats: {
      new_doors:          newDoorCount(invoices, spName || '', mFrom, mTo),
      visits_this_month:  visits,
      overdue_stores:     overdue,
    },
    last_updated: new Date().toISOString(),
    last_sync_at: syncAt,
  };

  setCached(key, result);
  return result;
}

// ── Team dashboard ────────────────────────────────────────────────────────────

async function getTeamDashboard(month = currentMonth(), { force = false } = {}) {
  const key = `team-${month}`;
  if (!force) { const c = getCached(key); if (c) return c; }

  const months12 = last12Months(month);
  const { from: histFrom } = monthBounds(months12[0]);
  const { from: mFrom, to: mTo } = monthBounds(month);
  const yearStart  = `${month.slice(0, 4)}-01-01`;
  const prev       = prevMonth(month);
  const { from: prevFrom, to: prevTo } = monthBounds(prev);

  // ── Parallel fetches ──
  const [repsResult, invoices, mTargets, ytdTargets, brandMTargets, syncAt] = await Promise.all([
    db.query(`SELECT id, name, zoho_salesperson_id FROM users WHERE role='rep' AND active=TRUE ORDER BY name`),
    fetchInvoices(histFrom, mTo).catch(() => []),
    db.query(`SELECT rep_id, amount FROM revenue_targets WHERE month=$1`, [month]),
    db.query(
      `SELECT rep_id, SUM(amount) AS total FROM revenue_targets
       WHERE month>=$1 AND month<=$2 GROUP BY rep_id`,
      [yearStart.slice(0, 7), month]
    ),
    db.query(`SELECT brand_slug, amount FROM brand_targets WHERE month=$1`, [month]),
    lastSyncAt(),
  ]);

  const reps = repsResult.rows;
  const tByRep = {}; for (const r of mTargets.rows)  tByRep[r.rep_id]  = Number(r.amount);
  const yByRep = {}; for (const r of ytdTargets.rows) yByRep[r.rep_id] = Number(r.total);

  // Leaderboard
  const leaderboard = reps.map(rep => {
    const sp = rep.zoho_salesperson_id || rep.name;
    const actuals = byMonth(invoices, sp);
    const actual  = actuals[month] || 0;
    const target  = tByRep[rep.id] || 0;
    const ytd_actual = Object.entries(actuals)
      .filter(([m]) => m >= yearStart.slice(0, 7) && m <= month)
      .reduce((s, [, v]) => s + v, 0);
    return {
      rep_id: rep.id, name: rep.name, actual, target,
      percentage: target > 0 ? Math.round((actual / target) * 100) : null,
      ytd_actual,
      ytd_target: yByRep[rep.id] || 0,
    };
  }).sort((a, b) => (b.percentage ?? -1) - (a.percentage ?? -1));

  // Company totals
  const totals = {
    actual:  leaderboard.reduce((s, r) => s + r.actual, 0),
    target:  leaderboard.reduce((s, r) => s + r.target, 0),
  };
  totals.percentage = totals.target > 0 ? Math.round((totals.actual / totals.target) * 100) : null;

  const ytd = {
    actual:  leaderboard.reduce((s, r) => s + r.ytd_actual, 0),
    target:  leaderboard.reduce((s, r) => s + r.ytd_target, 0),
  };
  ytd.percentage = ytd.target > 0 ? Math.round((ytd.actual / ytd.target) * 100) : null;

  // Brand performance — dynamic from item catalog
  const mInvoices   = invoices.filter(i => i.date >= mFrom    && i.date <= mTo);
  const prvInvoices = invoices.filter(i => i.date >= prevFrom  && i.date <= prevTo);
  const bTargetBySlug = {}; for (const r of brandMTargets.rows)   bTargetBySlug[r.brand_slug]  = Number(r.amount);

  const itemBrandMap   = await fetchItemBrandMap().catch(() => new Map());
  const mBrandTotals   = buildBrandTotals(mInvoices, itemBrandMap);
  const prvBrandTotals = buildBrandTotals(prvInvoices, itemBrandMap);

  // Union of brand names seen in current or previous month
  const allBrandNames = new Set([...Object.keys(mBrandTotals), ...Object.keys(prvBrandTotals)]);
  const brand_performance = [...allBrandNames]
    .map(brandName => {
      const slug        = slugify(brandName);
      const actual      = mBrandTotals[brandName]   || 0;
      const prev_actual = prvBrandTotals[brandName] || 0;
      const target      = bTargetBySlug[slug]       || 0;
      const trend       = prev_actual > 0 ? Math.round(((actual - prev_actual) / prev_actual) * 100) : null;
      return { slug, name: brandName, actual, target,
               percentage: target > 0 ? Math.round((actual / target) * 100) : null, trend };
    })
    .sort((a, b) => b.actual - a.actual);

  // New doors by rep (12-month approximation)
  const new_doors_by_rep = reps.map(rep => {
    const sp = rep.zoho_salesperson_id || rep.name;
    return { rep_id: rep.id, name: rep.name, count: newDoorCount(invoices, sp, mFrom, mTo) };
  });

  // Monthly history for company total
  const monthly_history = months12.map(m => {
    const actual = reps.reduce((s, rep) => {
      const sp = rep.zoho_salesperson_id || rep.name;
      return s + (byMonth(invoices, sp)[m] || 0);
    }, 0);
    return { month: m, actual, target: 0 }; // target aggregation not stored by month-company
  });

  const result = {
    month, leaderboard, totals, ytd,
    brand_performance, new_doors_by_rep, monthly_history,
    last_updated: new Date().toISOString(),
    last_sync_at: syncAt,
  };

  setCached(key, result);
  return result;
}

module.exports = { getRepDashboard, getTeamDashboard, invalidateCache };
