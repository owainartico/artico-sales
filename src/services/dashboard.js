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

const db                                               = require('../db');
const { fetchInvoicesWithTimeout, fetchSalesByPersonReport, buildSalesMap, fetchItemBrandMap, invAmount } = require('./sync');

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

/** Returns the last n months ending at (and including) endMonth, oldest first. */
function lastNMonths(endMonth, n) {
  const [y, m] = endMonth.split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
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

/** Returns all Zoho salesperson names for a rep (array — supports multi-name users). */
async function salespersonNames(repId) {
  const { rows } = await db.query(
    `SELECT name, zoho_salesperson_id, zoho_salesperson_ids FROM users WHERE id = $1`, [repId]
  );
  if (!rows[0]) return [];
  const u = rows[0];
  if (Array.isArray(u.zoho_salesperson_ids) && u.zoho_salesperson_ids.length) {
    return u.zoho_salesperson_ids;
  }
  return [u.zoho_salesperson_id || u.name];
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
     WHERE s.rep_id = $1 AND s.active = TRUE AND s.is_prospect = FALSE
     AND NOT EXISTS (
       SELECT 1 FROM visits v
       WHERE v.store_id = s.id AND v.visited_at >= NOW() - INTERVAL '60 days'
     )`, [repId]
  );
  return parseInt(rows[0].n);
}

// ── Invoice crunching ─────────────────────────────────────────────────────────

// ── Territory growth ──────────────────────────────────────────────────────────

/**
 * Territory-based year-on-year revenue comparison.
 * Attributes revenue to whichever rep currently owns each store (via stores.rep_id),
 * regardless of which salesperson's name appears on the Zoho invoice.
 *
 * @param {Array}   invoices   – raw invoice array (must cover current month AND same month LY)
 * @param {Set}     contactIds – Set of zoho_contact_id strings for the territory
 * @param {string}  mFrom      – 'YYYY-MM-DD' first day of current month
 * @param {string}  mTo        – 'YYYY-MM-DD' last day of current month
 * @returns {{ current, ly, growth_pct, store_count }}
 */
function computeTerritoryGrowth(invoices, contactIds, mFrom, mTo) {
  if (!contactIds.size) {
    return { current: 0, ly: 0, growth_pct: null, store_count: 0 };
  }

  // Same month last year
  const lyFrom = `${Number(mFrom.slice(0, 4)) - 1}${mFrom.slice(4)}`;
  const lyTo   = `${Number(mTo.slice(0, 4)) - 1}${mTo.slice(4)}`;

  let current = 0, ly = 0;
  for (const inv of invoices) {
    if (!contactIds.has(String(inv.customer_id))) continue;
    const total = invAmount(inv);
    if (inv.date >= mFrom && inv.date <= mTo) current += total;
    if (inv.date >= lyFrom && inv.date <= lyTo) ly += total;
  }

  return {
    current,
    ly,
    growth_pct: ly > 0 ? Math.round(((current - ly) / ly) * 100) : null,
    store_count: contactIds.size,
  };
}

/** Sum invoices by month for a rep (spNames is an array) → { 'YYYY-MM': amount } */
function byMonth(invoices, spNames) {
  const out = {};
  for (const inv of invoices) {
    if (!spNames.includes(inv.salesperson_name)) continue;
    const m = (inv.date || '').slice(0, 7);
    if (m) out[m] = (out[m] || 0) + invAmount(inv);
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
function newDoorCount(invoices, spNames, monthFrom, monthTo) {
  if (!spNames.length) return 0;
  const thisMonth = new Set(
    invoices
      .filter(i => spNames.includes(i.salesperson_name) && i.date >= monthFrom && i.date <= monthTo)
      .map(i => String(i.customer_id)).filter(Boolean)
  );
  const prior = new Set(
    invoices
      .filter(i => spNames.includes(i.salesperson_name) && i.date < monthFrom)
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

  const spNames  = await salespersonNames(repId);
  const months12 = lastNMonths(month, 12);  // sparkline window
  const months18 = lastNMonths(month, 18);  // matches team dashboard + pre-warm cache key → cache hit
  const { from: histFrom }  = monthBounds(months18[0]);
  const { from: mFrom, to: mTo } = monthBounds(month);
  const yearStart = `${month.slice(0, 4)}-01-01`;

  // ── Parallel fetches ──
  const [invoices, reportRows, ytdReportRows, mTargetRow, ytdTargets, histTargets, visits, overdue, syncAt, storeRows] = await Promise.all([
    // Invoices still needed for: monthly history sparkline, brand breakdown, territory growth, new doors
    fetchInvoicesWithTimeout(histFrom, mTo).catch((err) => { console.error('[dashboard] rep invoice fetch failed:', err.message); return []; }),
    // Reports API: exact ex-GST revenue net of credit notes, for current month and YTD
    fetchSalesByPersonReport(mFrom, mTo).catch((err) => { console.error('[dashboard] rep sales report (month) failed:', err.message); return []; }),
    fetchSalesByPersonReport(yearStart, mTo).catch((err) => { console.error('[dashboard] rep sales report (YTD) failed:', err.message); return []; }),
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
    db.query(`SELECT zoho_contact_id FROM stores WHERE rep_id=$1 AND active=TRUE`, [repId]),
  ]);

  const target     = Number(mTargetRow.rows[0]?.amount || 0);
  const ytd_target = Number(ytdTargets.rows[0]?.total  || 0);

  // ── Revenue from Reports API (exact ex-GST, credit notes already netted) ──
  // Falls back to invoice-based estimate (total/1.1) if the reports API returned nothing.
  const salesMap    = buildSalesMap(reportRows);
  const ytdSalesMap = buildSalesMap(ytdReportRows);

  // Invoice-based monthly breakdown — used for history sparkline and fallback
  const invoiceActuals = byMonth(invoices, spNames);

  const actual = reportRows.length > 0
    ? spNames.reduce((s, n) => s + (salesMap.get(n) || 0), 0)
    : (invoiceActuals[month] || 0);

  const ytd_actual = ytdReportRows.length > 0
    ? spNames.reduce((s, n) => s + (ytdSalesMap.get(n) || 0), 0)
    : Object.entries(invoiceActuals)
        .filter(([m]) => m >= yearStart.slice(0, 7) && m <= month)
        .reduce((s, [, v]) => s + v, 0);

  const percentage = target > 0 ? Math.round((actual / target) * 100) : null;

  // Monthly history — uses invoice-based figures for all months.
  // Current month bar uses the exact reports figure for consistency with the hero number.
  const targetByM = {};
  for (const r of histTargets.rows) targetByM[r.month] = Number(r.amount);
  const monthly_history = months12.map(m => ({
    month: m,
    actual: m === month ? actual : (invoiceActuals[m] || 0),
    target: targetByM[m] || 0,
  }));

  // Territory growth — uses invoice data (needs per-customer breakdown, reports doesn't have it)
  const repContactIds = new Set(storeRows.rows.map(s => String(s.zoho_contact_id)));
  const territory_growth = computeTerritoryGrowth(invoices, repContactIds, mFrom, mTo);

  // Brand breakdown (current month only) — dynamic from item catalog
  const mInvoices = invoices.filter(i => spNames.includes(i.salesperson_name) && i.date >= mFrom && i.date <= mTo);
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

  // If invoices is empty, the Zoho cache hasn't warmed yet (cold start after deploy).
  // Signal this to the frontend so it shows "loading" rather than $0.
  // Don't cache a loading-state result — next request should try again.
  const data_loading = invoices.length === 0;

  const result = {
    month,
    data_loading,
    hero: {
      actual, target, percentage,
      ...runRateStats(month, actual, target),
    },
    ytd: {
      actual: ytd_actual,
      target: ytd_target,
      percentage: ytd_target > 0 ? Math.round((ytd_actual / ytd_target) * 100) : null,
    },
    territory_growth,
    monthly_history,
    brand_breakdown,
    quick_stats: {
      new_doors:          newDoorCount(invoices, spNames, mFrom, mTo),
      visits_this_month:  visits,
      overdue_stores:     overdue,
    },
    last_updated: new Date().toISOString(),
    last_sync_at: syncAt,
  };

  if (!data_loading) setCached(key, result);
  return result;
}

// ── Team dashboard ────────────────────────────────────────────────────────────

async function getTeamDashboard(month = currentMonth(), { force = false } = {}) {
  const key = `team-${month}`;
  if (!force) { const c = getCached(key); if (c) return c; }

  const months18 = lastNMonths(month, 18);
  const { from: histFrom } = monthBounds(months18[0]);
  const { from: mFrom, to: mTo } = monthBounds(month);
  const yearStart  = `${month.slice(0, 4)}-01-01`;
  const prev       = prevMonth(month);
  const { from: prevFrom, to: prevTo } = monthBounds(prev);

  // Current quarter start
  const qMonth  = Math.floor(new Date().getMonth() / 3) * 3;
  const qStart  = `${new Date().getFullYear()}-${String(qMonth + 1).padStart(2, '0')}-01`;

  // ── Parallel fetches ──
  const [repsResult, invoices, reportRows, ytdReportRows, mTargets, ytdTargets, brandMTargets, syncAt, storesByRepResult, gradeDist, gradeTrend] = await Promise.all([
    db.query(`SELECT id, name, zoho_salesperson_id, zoho_salesperson_ids FROM users WHERE role='rep' AND active=TRUE ORDER BY name`),
    // Invoices still needed for: monthly history, brand breakdown, territory growth, new doors
    fetchInvoicesWithTimeout(histFrom, mTo).catch((err) => { console.error('[dashboard] team invoice fetch failed:', err.message); return []; }),
    // Reports API: exact ex-GST revenue net of credit notes, for current month and YTD
    fetchSalesByPersonReport(mFrom, mTo).catch((err) => { console.error('[dashboard] team sales report (month) failed:', err.message); return []; }),
    fetchSalesByPersonReport(yearStart, mTo).catch((err) => { console.error('[dashboard] team sales report (YTD) failed:', err.message); return []; }),
    db.query(`SELECT rep_id, amount FROM revenue_targets WHERE month=$1`, [month]),
    db.query(
      `SELECT rep_id, SUM(amount) AS total FROM revenue_targets
       WHERE month>=$1 AND month<=$2 GROUP BY rep_id`,
      [yearStart.slice(0, 7), month]
    ),
    db.query(`SELECT brand_slug, amount FROM brand_targets WHERE month=$1`, [month]),
    lastSyncAt(),
    db.query(
      `SELECT rep_id, array_agg(zoho_contact_id::text) AS contact_ids
       FROM stores WHERE active=TRUE AND is_prospect=FALSE AND rep_id IS NOT NULL GROUP BY rep_id`
    ),
    // Grade distribution per rep
    db.query(
      `SELECT s.rep_id, s.grade, COUNT(*)::INTEGER AS count
       FROM stores s WHERE s.active = TRUE AND s.is_prospect = FALSE AND s.rep_id IS NOT NULL
       GROUP BY s.rep_id, s.grade`
    ).catch(() => ({ rows: [] })),
    // Quarterly grade trend
    db.query(
      `SELECT
         SUM(CASE WHEN (old_grade='C' AND new_grade IN ('A','B')) OR (old_grade='B' AND new_grade='A') THEN 1 ELSE 0 END)::INTEGER AS upgrades,
         SUM(CASE WHEN (old_grade='A' AND new_grade IN ('B','C')) OR (old_grade='B' AND new_grade='C') OR (old_grade IN ('A','B','C') AND new_grade IS NULL) THEN 1 ELSE 0 END)::INTEGER AS downgrades
       FROM grade_history WHERE changed_at >= $1`,
      [qStart]
    ).catch(() => ({ rows: [{ upgrades: 0, downgrades: 0 }] })),
  ]);

  // ── Revenue maps from Reports API ──
  // Exact ex-GST totals, credit notes already netted by Zoho.
  // Falls back to invoice-based (total/1.1) if the reports API returned nothing.
  const salesMap    = buildSalesMap(reportRows);
  const ytdSalesMap = buildSalesMap(ytdReportRows);

  // Build rep_id → Set<zoho_contact_id>
  const contactsByRep = new Map();
  for (const row of storesByRepResult.rows) {
    contactsByRep.set(row.rep_id, new Set(row.contact_ids));
  }

  const reps = repsResult.rows;
  const tByRep = {}; for (const r of mTargets.rows)  tByRep[r.rep_id]  = Number(r.amount);
  const yByRep = {}; for (const r of ytdTargets.rows) yByRep[r.rep_id] = Number(r.total);

  // Grade distribution map: rep_id → { A, B, C, ungraded }
  const gradeDistByRep = {};
  for (const r of gradeDist.rows) {
    if (!gradeDistByRep[r.rep_id]) gradeDistByRep[r.rep_id] = { A: 0, B: 0, C: 0, ungraded: 0 };
    gradeDistByRep[r.rep_id][r.grade || 'ungraded'] = r.count;
  }

  const quarterly_grade_trend = gradeTrend.rows[0] || { upgrades: 0, downgrades: 0 };
  quarterly_grade_trend.quarter_start = qStart;

  /** Resolve the array of Zoho salesperson names for a rep row. */
  function repSpNames(rep) {
    if (Array.isArray(rep.zoho_salesperson_ids) && rep.zoho_salesperson_ids.length) {
      return rep.zoho_salesperson_ids;
    }
    return [rep.zoho_salesperson_id || rep.name];
  }

  // Leaderboard
  const leaderboard = reps.map(rep => {
    const spNames = repSpNames(rep);

    // Revenue from Reports API — exact ex-GST, credit notes netted.
    // Fall back to invoice-based estimate if the reports API returned nothing.
    const invoiceActuals = byMonth(invoices, spNames);
    const actual = reportRows.length > 0
      ? spNames.reduce((s, n) => s + (salesMap.get(n) || 0), 0)
      : (invoiceActuals[month] || 0);
    const ytd_actual = ytdReportRows.length > 0
      ? spNames.reduce((s, n) => s + (ytdSalesMap.get(n) || 0), 0)
      : Object.entries(invoiceActuals)
          .filter(([m]) => m >= yearStart.slice(0, 7) && m <= month)
          .reduce((s, [, v]) => s + v, 0);

    const target  = tByRep[rep.id] || 0;
    const repContacts  = contactsByRep.get(rep.id) || new Set();
    // Territory growth uses invoices (needs per-customer breakdown, reports don't provide it)
    const tg   = computeTerritoryGrowth(invoices, repContacts, mFrom, mTo);
    const dist = gradeDistByRep[rep.id] || { A: 0, B: 0, C: 0, ungraded: 0 };
    return {
      rep_id: rep.id, name: rep.name, actual, target,
      percentage: target > 0 ? Math.round((actual / target) * 100) : null,
      ytd_actual,
      ytd_target: yByRep[rep.id] || 0,
      territory_growth_pct: tg.growth_pct,
      territory_current:    tg.current,
      territory_ly:         tg.ly,
      territory_stores:     tg.store_count,
      grade_dist:           dist,
    };
  }).sort((a, b) => (b.percentage ?? -1) - (a.percentage ?? -1));

  // Company totals
  const totals = {
    actual:  leaderboard.reduce((s, r) => s + r.actual, 0),
    target:  leaderboard.reduce((s, r) => s + r.target, 0),
  };
  totals.percentage = totals.target > 0 ? Math.round((totals.actual / totals.target) * 100) : null;

  // Company territory growth — union of all assigned store contacts (invoice-based)
  const allAssignedContacts = new Set();
  for (const ids of contactsByRep.values()) for (const id of ids) allAssignedContacts.add(id);
  const company_territory_growth = computeTerritoryGrowth(invoices, allAssignedContacts, mFrom, mTo);

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
    return { rep_id: rep.id, name: rep.name, count: newDoorCount(invoices, repSpNames(rep), mFrom, mTo) };
  });

  // Monthly history — invoice-based for all months.
  // Current month bar uses the exact reports figure so it matches the totals card.
  const monthly_history = months18.map(m => {
    let actual;
    if (m === month) {
      actual = totals.actual; // exact figure from reports API (already computed above)
    } else {
      actual = reps.reduce((s, rep) => s + (byMonth(invoices, repSpNames(rep))[m] || 0), 0);
    }
    return { month: m, actual, target: 0 };
  });

  const data_loading = invoices.length === 0;

  const result = {
    month, data_loading, leaderboard, totals, ytd,
    company_territory_growth,
    quarterly_grade_trend,
    brand_performance, new_doors_by_rep, monthly_history,
    last_updated: new Date().toISOString(),
    last_sync_at: syncAt,
  };

  if (!data_loading) setCached(key, result);
  return result;
}

module.exports = { getRepDashboard, getTeamDashboard, invalidateCache };
