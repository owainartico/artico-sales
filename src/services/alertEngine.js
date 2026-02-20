'use strict';

/**
 * Alert Engine — generates Tier 1 (red) and Tier 2 (amber) alerts.
 *
 * Tier 1 — urgent, revenue-impacting:
 *   ALERT-1  a_grade_visit_breach    A-grade store not visited in 30+ days
 *   ALERT-2  high_value_unvisited    High-revenue store not visited in 45+ days
 *   ALERT-3  churn_risk              Top-20% revenue store, no invoice in 90+ days
 *   ALERT-4  sku_gap                 Store with revenue but only 1 distinct SKU (12m)
 *   ALERT-5  rep_activity_drop       Rep with 0 visits in the last 14 days
 *
 * Tier 2 — informational / positive:
 *   T2-1     store_outperforming     Store revenue up >20% vs same period prior year
 *   T2-2     new_door_high_value     New door (first invoice) with value > $500
 *   T2-3     brand_underindex        (placeholder — requires brand config)
 *   T2-4     focus_line              (placeholder — requires focus-line config)
 *
 * Deduplication: an alert is only inserted if no unacknowledged alert of the
 * same alert_type + store_id + rep_id exists.
 */

const db           = require('../db');
const { fetchInvoices } = require('./sync');

// ── Date helpers ──────────────────────────────────────────────────────────────

function get12MonthWindow() {
  const now   = new Date();
  const toD   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const fromD = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const pad   = n => String(n).padStart(2, '0');
  return {
    from: `${fromD.getFullYear()}-${pad(fromD.getMonth() + 1)}-01`,
    to:   `${toD.getFullYear()}-${pad(toD.getMonth() + 1)}-${pad(toD.getDate())}`,
  };
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ── Deduplication helper ──────────────────────────────────────────────────────

async function isDuplicate(alertType, storeId, repId) {
  const { rows } = await db.query(`
    SELECT 1 FROM alert_log
    WHERE alert_type = $1
      AND (store_id = $2 OR ($2 IS NULL AND store_id IS NULL))
      AND (rep_id   = $3 OR ($3 IS NULL AND rep_id   IS NULL))
      AND acknowledged_at IS NULL
    LIMIT 1
  `, [alertType, storeId ?? null, repId ?? null]);
  return rows.length > 0;
}

async function insertAlert({ alertType, storeId, repId, tier, title, detail, revenueAtRisk, estimatedUplift }) {
  if (await isDuplicate(alertType, storeId, repId)) return false;
  await db.query(`
    INSERT INTO alert_log
      (alert_type, store_id, rep_id, tier, alert_title, alert_detail, revenue_at_risk, estimated_uplift)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    alertType,
    storeId   ?? null,
    repId     ?? null,
    tier,
    title,
    JSON.stringify(detail || {}),
    revenueAtRisk   ?? null,
    estimatedUplift ?? null,
  ]);
  return true;
}

// ── ALERT-1: A-Grade Visit Breach ─────────────────────────────────────────────
// A-grade stores that have not been visited in 30+ days (or never visited).

async function runAlert1(counts) {
  const { rows: stores } = await db.query(`
    SELECT
      s.id, s.name, s.rep_id, u.name AS rep_name,
      MAX(v.visited_at) AS last_visit_at,
      EXTRACT(DAY FROM NOW() - MAX(v.visited_at))::INTEGER AS days_since_visit
    FROM stores s
    LEFT JOIN visits v ON v.store_id = s.id
    LEFT JOIN users u  ON u.id = s.rep_id
    WHERE s.grade = 'A' AND s.active = TRUE AND s.is_prospect = FALSE
    GROUP BY s.id, s.name, s.rep_id, u.name
    HAVING MAX(v.visited_at) IS NULL OR EXTRACT(DAY FROM NOW() - MAX(v.visited_at)) >= 30
  `);

  for (const store of stores) {
    const days = store.days_since_visit ?? null;
    const inserted = await insertAlert({
      alertType:    'a_grade_visit_breach',
      storeId:      store.id,
      repId:        store.rep_id,
      tier:         1,
      title:        `A-Grade not visited: ${store.name}`,
      detail:       { days_since_visit: days, rep_name: store.rep_name },
      revenueAtRisk: null,
    });
    if (inserted) counts.inserted++;
  }
}

// ── ALERT-2: High-Revenue Under-Visited ──────────────────────────────────────
// Stores with 12m revenue > $3,000 that haven't been visited in 45+ days.
// Revenue at risk = (12m_revenue / 365) * days_overdue

async function runAlert2(counts, invoices) {
  // Build revenue map per zoho_contact_id
  const revenueMap = {};
  for (const inv of invoices) {
    const cid = String(inv.customer_id);
    revenueMap[cid] = (revenueMap[cid] || 0) + Number(inv.sub_total || 0);
  }

  const { rows: stores } = await db.query(`
    SELECT
      s.id, s.name, s.rep_id, s.zoho_contact_id, u.name AS rep_name,
      MAX(v.visited_at) AS last_visit_at,
      EXTRACT(DAY FROM NOW() - MAX(v.visited_at))::INTEGER AS days_since_visit
    FROM stores s
    LEFT JOIN visits v ON v.store_id = s.id
    LEFT JOIN users u  ON u.id = s.rep_id
    WHERE s.active = TRUE AND s.is_prospect = FALSE
    GROUP BY s.id, s.name, s.rep_id, s.zoho_contact_id, u.name
    HAVING MAX(v.visited_at) IS NULL OR EXTRACT(DAY FROM NOW() - MAX(v.visited_at)) >= 45
  `);

  const THRESHOLD = 3000;
  for (const store of stores) {
    const rev = revenueMap[String(store.zoho_contact_id)] || 0;
    if (rev < THRESHOLD) continue;

    const days         = store.days_since_visit ?? 999;
    const revenueAtRisk = Math.round((rev / 365) * days);

    const inserted = await insertAlert({
      alertType:    'high_value_unvisited',
      storeId:      store.id,
      repId:        store.rep_id,
      tier:         1,
      title:        `High-value store unvisited: ${store.name}`,
      detail:       { days_since_visit: days, revenue_12m: Math.round(rev), rep_name: store.rep_name },
      revenueAtRisk,
    });
    if (inserted) counts.inserted++;
  }
}

// ── ALERT-3: Churn Risk (Top-20% Revenue, No Recent Invoice) ─────────────────
// Stores in the top 20% of 12m revenue with no invoice in the last 90 days.

async function runAlert3(counts, invoices) {
  // Revenue per customer
  const revenueMap = {};
  for (const inv of invoices) {
    const cid = String(inv.customer_id);
    revenueMap[cid] = (revenueMap[cid] || 0) + Number(inv.sub_total || 0);
  }

  // Last invoice date per customer
  const lastOrderMap = {};
  for (const inv of invoices) {
    const cid = String(inv.customer_id);
    if (!lastOrderMap[cid] || inv.date > lastOrderMap[cid]) {
      lastOrderMap[cid] = inv.date;
    }
  }

  // Compute 80th percentile threshold
  const revenues = Object.values(revenueMap).filter(v => v > 0).sort((a, b) => a - b);
  if (revenues.length === 0) return;
  const p80idx = Math.floor(revenues.length * 0.8);
  const p80    = revenues[p80idx];

  const cutoff = daysAgo(90);

  const { rows: stores } = await db.query(`
    SELECT s.id, s.name, s.rep_id, s.zoho_contact_id, u.name AS rep_name
    FROM stores s
    LEFT JOIN users u ON u.id = s.rep_id
    WHERE s.active = TRUE AND s.is_prospect = FALSE
  `);

  for (const store of stores) {
    const cid = String(store.zoho_contact_id);
    const rev = revenueMap[cid] || 0;
    if (rev < p80) continue;

    const lastOrder = lastOrderMap[cid];
    if (lastOrder && lastOrder >= cutoff) continue; // ordered recently

    const inserted = await insertAlert({
      alertType:    'churn_risk',
      storeId:      store.id,
      repId:        store.rep_id,
      tier:         1,
      title:        `Churn risk: ${store.name}`,
      detail:       { revenue_12m: Math.round(rev), last_order_date: lastOrder || null, rep_name: store.rep_name },
      revenueAtRisk: Math.round(rev * 0.25), // estimate 25% of annual at risk
    });
    if (inserted) counts.inserted++;
  }
}

// ── ALERT-4: SKU Gap ──────────────────────────────────────────────────────────
// Stores that have revenue but only 1 distinct SKU across 12m invoices.
// Signals upsell opportunity.

async function runAlert4(counts, invoices) {
  // Per-customer SKU set
  const skuMap = {};
  for (const inv of invoices) {
    const cid = String(inv.customer_id);
    if (!skuMap[cid]) skuMap[cid] = new Set();
    for (const line of inv.line_items || []) {
      const key = line.item_id || line.item_name;
      if (key) skuMap[cid].add(String(key));
    }
  }

  // Find customers with exactly 1 SKU (and revenue > $0)
  const narrowCids = Object.entries(skuMap)
    .filter(([, s]) => s.size === 1)
    .map(([cid]) => cid);

  if (narrowCids.length === 0) return;

  const { rows: stores } = await db.query(`
    SELECT s.id, s.name, s.rep_id, s.zoho_contact_id, u.name AS rep_name
    FROM stores s
    LEFT JOIN users u ON u.id = s.rep_id
    WHERE s.active = TRUE AND s.is_prospect = FALSE AND s.zoho_contact_id = ANY($1)
  `, [narrowCids]);

  const revenueMap = {};
  for (const inv of invoices) {
    const cid = String(inv.customer_id);
    revenueMap[cid] = (revenueMap[cid] || 0) + Number(inv.sub_total || 0);
  }

  for (const store of stores) {
    const cid = String(store.zoho_contact_id);
    const skus = skuMap[cid]?.size || 0;
    const rev  = revenueMap[cid] || 0;
    if (rev === 0) continue;

    const inserted = await insertAlert({
      alertType:      'sku_gap',
      storeId:        store.id,
      repId:          store.rep_id,
      tier:           1,
      title:          `SKU gap (1 product): ${store.name}`,
      detail:         { sku_count: skus, revenue_12m: Math.round(rev), rep_name: store.rep_name },
      estimatedUplift: Math.round(rev * 0.3), // estimate 30% uplift from range expansion
    });
    if (inserted) counts.inserted++;
  }
}

// ── ALERT-5: Rep Activity Drop ────────────────────────────────────────────────
// Reps who have logged 0 visits in the last 14 days.

async function runAlert5(counts) {
  const cutoff = daysAgo(14);

  const { rows: reps } = await db.query(`
    SELECT id, name FROM users WHERE role = 'rep' AND active = TRUE
  `);

  for (const rep of reps) {
    const { rows } = await db.query(`
      SELECT COUNT(*)::INTEGER AS cnt
      FROM visits
      WHERE rep_id = $1 AND visited_at >= $2
    `, [rep.id, cutoff]);

    if (rows[0].cnt > 0) continue;

    const inserted = await insertAlert({
      alertType: 'rep_activity_drop',
      storeId:   null,
      repId:     rep.id,
      tier:      1,
      title:     `No visits in 14 days: ${rep.name}`,
      detail:    { rep_name: rep.name, days_window: 14 },
    });
    if (inserted) counts.inserted++;
  }
}

// ── T2-1: Store Outperforming ─────────────────────────────────────────────────
// Stores where last 3-month revenue > 120% of the same 3 months last year.

async function runT2Alert1(counts, invoices) {
  const now = new Date();

  // Current 3-month window
  const cur3From = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const cur3From_s = cur3From.toISOString().slice(0, 10);
  const cur3To_s   = now.toISOString().slice(0, 10);

  // Prior-year same 3-month window
  const py3From = new Date(now.getFullYear() - 1, now.getMonth() - 2, 1);
  const py3To   = new Date(now.getFullYear() - 1, now.getMonth() + 1, 0);
  const py3From_s = py3From.toISOString().slice(0, 10);
  const py3To_s   = py3To.toISOString().slice(0, 10);

  // Revenue per customer per window
  const curRev = {};
  const pyRev  = {};
  for (const inv of invoices) {
    const cid = String(inv.customer_id);
    const d   = inv.date || '';
    if (d >= cur3From_s && d <= cur3To_s) {
      curRev[cid] = (curRev[cid] || 0) + Number(inv.sub_total || 0);
    }
    if (d >= py3From_s && d <= py3To_s) {
      pyRev[cid]  = (pyRev[cid]  || 0) + Number(inv.sub_total || 0);
    }
  }

  const { rows: stores } = await db.query(`
    SELECT s.id, s.name, s.rep_id, s.zoho_contact_id, u.name AS rep_name
    FROM stores s
    LEFT JOIN users u ON u.id = s.rep_id
    WHERE s.active = TRUE AND s.is_prospect = FALSE
  `);

  for (const store of stores) {
    const cid  = String(store.zoho_contact_id);
    const cur  = curRev[cid] || 0;
    const prev = pyRev[cid]  || 0;
    if (prev === 0 || cur === 0) continue;

    const growthPct = Math.round(((cur - prev) / prev) * 100);
    if (growthPct < 20) continue; // < 20% growth — skip

    const inserted = await insertAlert({
      alertType:      'store_outperforming',
      storeId:        store.id,
      repId:          store.rep_id,
      tier:           2,
      title:          `Outperforming +${growthPct}%: ${store.name}`,
      detail:         { growth_pct: growthPct, revenue_cur3m: Math.round(cur), revenue_py3m: Math.round(prev), rep_name: store.rep_name },
      estimatedUplift: Math.round(cur - prev),
    });
    if (inserted) counts.inserted++;
  }
}

// ── T2-2: New Door High Value ─────────────────────────────────────────────────
// Customers whose first-ever invoice (in the 12m window) was in the last 30 days
// and exceeded $500.

async function runT2Alert2(counts, invoices) {
  const cutoff30 = daysAgo(30);

  // Last-30-day invoices
  const recentInvoices = invoices.filter(inv => (inv.date || '') >= cutoff30);

  // Prior invoices (before 30 days ago)
  const priorCustomers = new Set(
    invoices
      .filter(inv => (inv.date || '') < cutoff30)
      .map(inv => String(inv.customer_id))
  );

  // Find first invoice per new customer in last 30 days
  const newDoorMap = new Map();
  for (const inv of recentInvoices.sort((a, b) => (a.date || '').localeCompare(b.date || ''))) {
    const cid = String(inv.customer_id);
    if (!priorCustomers.has(cid) && !newDoorMap.has(cid)) {
      newDoorMap.set(cid, inv);
    }
  }

  if (newDoorMap.size === 0) return;

  const contactIds = [...newDoorMap.keys()];
  const { rows: stores } = await db.query(`
    SELECT s.id, s.name, s.rep_id, s.zoho_contact_id, u.name AS rep_name
    FROM stores s
    LEFT JOIN users u ON u.id = s.rep_id
    WHERE s.active = TRUE AND s.is_prospect = FALSE AND s.zoho_contact_id = ANY($1)
  `, [contactIds]);

  const storeByContactId = {};
  for (const s of stores) storeByContactId[String(s.zoho_contact_id)] = s;

  for (const [cid, inv] of newDoorMap) {
    const value = Number(inv.sub_total || 0);
    if (value < 500) continue;

    const store = storeByContactId[cid];

    const inserted = await insertAlert({
      alertType:      'new_door_high_value',
      storeId:        store?.id   ?? null,
      repId:          store?.rep_id ?? null,
      tier:           2,
      title:          `New door ${fmt(value)}: ${store?.name || inv.customer_name || cid}`,
      detail:         {
        first_order_value: Math.round(value),
        first_order_date:  inv.date,
        customer_name:     store?.name || inv.customer_name,
        rep_name:          store?.rep_name || inv.salesperson_name,
      },
      estimatedUplift: Math.round(value * 3), // rough 3x annualised estimate
    });
    if (inserted) counts.inserted++;
  }
}

// ── Simple number formatter (used in alert titles) ────────────────────────────
function fmt(n) {
  if (!n) return '$0';
  return '$' + Math.round(n).toLocaleString('en-AU');
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function runAlertEngine() {
  console.log('[alertEngine] Starting alert engine run');
  const counts = { inserted: 0, skipped: 0 };

  try {
    // Fetch 12-month invoice data (uses cache if warm)
    const { from, to } = get12MonthWindow();
    const invoices = await fetchInvoices(from, to);
    console.log(`[alertEngine] Working with ${invoices.length} invoices`);

    await runAlert1(counts);
    await runAlert2(counts, invoices);
    await runAlert3(counts, invoices);
    await runAlert4(counts, invoices);
    await runAlert5(counts);
    await runT2Alert1(counts, invoices);
    await runT2Alert2(counts, invoices);

    console.log(`[alertEngine] Done — ${counts.inserted} new alerts inserted`);
    return { success: true, ...counts };
  } catch (err) {
    console.error('[alertEngine] Error:', err.message);
    throw err;
  }
}

module.exports = { runAlertEngine };
