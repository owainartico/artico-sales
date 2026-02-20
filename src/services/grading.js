'use strict';

/**
 * Automated customer grading service.
 *
 * Grading criteria (based on visit + invoice history):
 *   A  – visited ≤6 weeks ago  AND  last order ≤6 weeks ago
 *   B  – visited ≤12 weeks ago AND  last order ≤12 weeks ago
 *   C  – visited ≤12 weeks ago AND  fewer than 4 orders in last 12 months
 *   null (ungraded) – doesn't meet C criteria
 *
 * grade_locked = true → never auto-change the grade.
 *
 * Exports:
 *   calculateGrade(lastVisit, lastOrder, orderCount12m)  → { grade, reason }
 *   runAutoGrading()      – grade all ungraded, non-locked stores
 *   runQuarterlyGrading() – reassess all non-locked stores
 */

const db = require('../db');
const { fetchInvoices } = require('./sync');
const { makeZohoWrite } = require('./zoho');

// ── Grade calculation ─────────────────────────────────────────────────────────

const W6  = 6  * 7 * 86_400_000;
const W12 = 12 * 7 * 86_400_000;

/**
 * Pure calculation — no DB/Zoho side effects.
 * @param {string|Date|null} lastVisitDate
 * @param {string|Date|null} lastOrderDate
 * @param {number}           orderCount12m  – invoices in the last 12 months
 * @returns {{ grade: 'A'|'B'|'C'|null, reason: string }}
 */
function calculateGrade(lastVisitDate, lastOrderDate, orderCount12m) {
  const now = Date.now();
  const lv  = lastVisitDate  ? new Date(lastVisitDate).getTime()  : null;
  const lo  = lastOrderDate  ? new Date(lastOrderDate).getTime()  : null;

  const visitIn6w  = lv && (now - lv) <= W6;
  const visitIn12w = lv && (now - lv) <= W12;
  const orderIn6w  = lo && (now - lo) <= W6;
  const orderIn12w = lo && (now - lo) <= W12;

  if (visitIn6w  && orderIn6w)  return { grade: 'A', reason: 'Visited and ordered within 6 weeks' };
  if (visitIn12w && orderIn12w) return { grade: 'B', reason: 'Visited and ordered within 12 weeks' };
  if (visitIn12w && orderCount12m < 4) {
    return { grade: 'C', reason: `Visited within 12 weeks, ${orderCount12m} order${orderCount12m !== 1 ? 's' : ''} in 12m` };
  }
  return { grade: null, reason: 'Insufficient visit/order activity' };
}

// ── Zoho write-back ───────────────────────────────────────────────────────────

async function writeGradeToZoho(zohoContactId, grade) {
  if (!zohoContactId) return;
  try {
    await makeZohoWrite('PUT', `/contacts/${zohoContactId}`, {
      custom_fields: [{ api_name: 'cf_store_grade', value: grade || '' }],
    });
    console.log(`[grading] Zoho contact ${zohoContactId} → grade ${grade || 'cleared'}`);
  } catch (err) {
    // Non-fatal — local data is source of truth; Zoho is best-effort
    console.error(`[grading] Zoho write failed for contact ${zohoContactId}:`, err.message);
  }
}

// ── Grade history log ─────────────────────────────────────────────────────────

async function logGradeChange(storeId, oldGrade, newGrade, reason, changedBy = 'system', locked = false) {
  await db.query(
    `INSERT INTO grade_history (store_id, old_grade, new_grade, reason, changed_by, locked)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [storeId, oldGrade || null, newGrade || null, reason, changedBy, locked]
  );
}

// ── Grade-change alert (Tier 2) ───────────────────────────────────────────────

async function insertGradeChangeAlert(store, oldGrade, newGrade) {
  if (!store.rep_id) return;
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM alert_log
       WHERE alert_type = 'grade_change' AND store_id = $1 AND acknowledged_at IS NULL LIMIT 1`,
      [store.id]
    );
    if (rows.length) return; // already have an unacknowledged alert
    await db.query(
      `INSERT INTO alert_log (alert_type, store_id, rep_id, tier, alert_title, alert_detail)
       VALUES ($1, $2, $3, 2, $4, $5)`,
      [
        'grade_change', store.id, store.rep_id,
        `${store.name} moved from ${oldGrade || '?'} → ${newGrade || '?'}`,
        JSON.stringify({ old_grade: oldGrade, new_grade: newGrade }),
      ]
    );
  } catch (err) {
    console.error('[grading] Alert insert failed:', err.message);
  }
}

// ── Invoice data helpers ──────────────────────────────────────────────────────

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

/**
 * Build per-customer invoice stats from cached invoices.
 * @returns {Map<string, { lastOrderDate: string|null, orderCount12m: number }>}
 */
function buildInvoiceStats(invoices, windowFrom) {
  const map = new Map();
  for (const inv of invoices) {
    const cid = String(inv.customer_id);
    if (!map.has(cid)) map.set(cid, { lastOrderDate: null, orderCount12m: 0 });
    const e = map.get(cid);
    if (!e.lastOrderDate || inv.date > e.lastOrderDate) e.lastOrderDate = inv.date;
    if (inv.date >= windowFrom) e.orderCount12m++;
  }
  return map;
}

// ── Core batch grading ────────────────────────────────────────────────────────

/**
 * Grade a batch of stores and apply changes to DB + Zoho.
 *
 * @param {object[]} stores        – rows from stores table
 * @param {object[]} invoices      – cached invoice array
 * @param {Map}      visitMap      – store_id → last_visit (date string or Date)
 * @param {string}   windowFrom    – 12-month window start date string
 * @param {string}   changedBy     – 'system' or user name
 * @param {boolean}  onlyUngraded  – true → only process stores where grade IS NULL
 */
async function gradeStores(stores, invoices, visitMap, windowFrom, changedBy = 'system', onlyUngraded = false) {
  const invStats = buildInvoiceStats(invoices, windowFrom);
  let graded = 0, changed = 0, errors = 0;

  for (const store of stores) {
    try {
      if (onlyUngraded && store.grade !== null) continue;

      const cid        = String(store.zoho_contact_id || '');
      const inv        = invStats.get(cid) || { lastOrderDate: null, orderCount12m: 0 };
      const lastVisit  = visitMap.get(store.id) || null;

      const { grade: suggested, reason } = calculateGrade(lastVisit, inv.lastOrderDate, inv.orderCount12m);

      // No change → skip
      if (suggested === store.grade) continue;

      const oldGrade = store.grade;
      const newGrade = suggested;

      // 1. Update local DB
      await db.query(`UPDATE stores SET grade = $1 WHERE id = $2`, [newGrade, store.id]);

      // 2. Write to Zoho (non-fatal on failure)
      if (store.zoho_contact_id) await writeGradeToZoho(store.zoho_contact_id, newGrade);

      // 3. Log the change
      await logGradeChange(store.id, oldGrade, newGrade, reason, changedBy, store.grade_locked || false);

      // 4. Tier-2 alert if this is a grade *change* (not initial assignment)
      if (oldGrade !== null && oldGrade !== newGrade) {
        await insertGradeChangeAlert(store, oldGrade, newGrade);
        changed++;
      }

      graded++;
    } catch (err) {
      console.error(`[grading] Store ${store.id} error:`, err.message);
      errors++;
    }
  }

  return { graded, changed, errors };
}

// ── Public runners ────────────────────────────────────────────────────────────

/**
 * Auto-grade all stores where grade IS NULL and grade_locked = FALSE.
 * Called once at startup (after scheduler warms up) and via /api/grades/run-auto.
 */
async function runAutoGrading() {
  console.log('[grading] Auto-grade: starting for ungraded stores...');
  const { from: windowFrom, to: windowTo } = get12MonthWindow();

  const [{ rows: stores }, invoices, { rows: visitRows }] = await Promise.all([
    db.query(`
      SELECT id, name, grade, grade_locked, zoho_contact_id, rep_id
      FROM stores
      WHERE active = TRUE AND grade IS NULL AND is_prospect = FALSE AND grade_locked = FALSE
    `),
    fetchInvoices(windowFrom, windowTo).catch(() => []),
    db.query(`SELECT store_id, MAX(visited_at) AS last_visit FROM visits GROUP BY store_id`),
  ]);

  const visitMap = new Map(visitRows.map(r => [r.store_id, r.last_visit]));
  const result   = await gradeStores(stores, invoices, visitMap, windowFrom, 'system', true);

  console.log(`[grading] Auto-grade done — ${result.graded} graded, ${result.errors} errors`);
  return result;
}

/**
 * Quarterly reassessment: recalculate grade for ALL non-locked stores.
 * Called by cron on last day of each quarter, and via /api/grades/run-quarterly.
 */
async function runQuarterlyGrading() {
  console.log('[grading] Quarterly reassessment: starting...');
  const { from: windowFrom, to: windowTo } = get12MonthWindow();

  const [{ rows: stores }, invoices, { rows: visitRows }] = await Promise.all([
    db.query(`
      SELECT id, name, grade, grade_locked, zoho_contact_id, rep_id
      FROM stores
      WHERE active = TRUE AND is_prospect = FALSE AND grade_locked = FALSE
    `),
    fetchInvoices(windowFrom, windowTo).catch(() => []),
    db.query(`SELECT store_id, MAX(visited_at) AS last_visit FROM visits GROUP BY store_id`),
  ]);

  const visitMap = new Map(visitRows.map(r => [r.store_id, r.last_visit]));
  const result   = await gradeStores(stores, invoices, visitMap, windowFrom, 'system', false);

  console.log(`[grading] Quarterly done — ${result.graded} updated, ${result.changed} changed, ${result.errors} errors`);
  return result;
}

// ── Prospect classification ───────────────────────────────────────────────────

/**
 * 24-month invoice window helper.
 */
function get24MonthWindow() {
  const now  = new Date();
  const from = new Date(now.getFullYear() - 2, now.getMonth(), 1);
  const pad  = n => String(n).padStart(2, '0');
  return {
    from: `${from.getFullYear()}-${pad(from.getMonth() + 1)}-01`,
    to:   now.toISOString().slice(0, 10),
  };
}

/**
 * Mark stores as prospects: grade IS NULL + no invoice in 24m + no visit ever.
 * Safe to run repeatedly — only affects non-prospect, non-locked stores.
 */
async function classifyProspects() {
  console.log('[grading] classifyProspects: checking ungraded stores…');

  const { rows: candidates } = await db.query(`
    SELECT s.id, s.name, s.zoho_contact_id,
           (SELECT COUNT(*) FROM visits WHERE store_id = s.id LIMIT 1)::INTEGER AS visit_count
    FROM stores s
    WHERE s.active = TRUE AND s.grade IS NULL AND s.is_prospect = FALSE AND s.grade_locked = FALSE
  `);

  if (!candidates.length) {
    console.log('[grading] classifyProspects: nothing to classify');
    return { prospected: 0 };
  }

  const { from, to } = get24MonthWindow();
  const invoices = await fetchInvoices(from, to).catch(() => []);
  const activeContacts = new Set(invoices.map(i => String(i.customer_id)));

  let prospected = 0;
  for (const store of candidates) {
    const hasInvoice = store.zoho_contact_id && activeContacts.has(String(store.zoho_contact_id));
    if (!hasInvoice && store.visit_count === 0) {
      await db.query(`UPDATE stores SET is_prospect = TRUE WHERE id = $1`, [store.id]);
      prospected++;
    }
  }

  console.log(`[grading] classifyProspects: ${prospected} store(s) marked as prospects`);
  return { prospected };
}

/**
 * Promote prospects that have gained invoice or visit activity → assign grade C.
 */
async function promoteActiveProspects() {
  console.log('[grading] promoteActiveProspects: checking prospects for activity…');

  const { rows: prospects } = await db.query(`
    SELECT s.id, s.name, s.zoho_contact_id, s.rep_id,
           (SELECT COUNT(*) FROM visits WHERE store_id = s.id LIMIT 1)::INTEGER AS visit_count
    FROM stores s
    WHERE s.active = TRUE AND s.is_prospect = TRUE
  `);

  if (!prospects.length) {
    console.log('[grading] promoteActiveProspects: no prospects to check');
    return { promoted: 0 };
  }

  const { from, to } = get24MonthWindow();
  const invoices = await fetchInvoices(from, to).catch(() => []);
  const activeContacts = new Set(invoices.map(i => String(i.customer_id)));

  let promoted = 0;
  for (const store of prospects) {
    const hasInvoice = store.zoho_contact_id && activeContacts.has(String(store.zoho_contact_id));
    if (!hasInvoice && store.visit_count === 0) continue;

    // Has invoice or visit activity — promote to active customer with grade C
    await db.query(
      `UPDATE stores SET is_prospect = FALSE, grade = 'C' WHERE id = $1`,
      [store.id]
    );
    await logGradeChange(store.id, null, 'C', 'Promoted from prospect — first activity recorded', 'system');
    if (store.zoho_contact_id) {
      writeGradeToZoho(store.zoho_contact_id, 'C').catch(() => {});
    }
    promoted++;
  }

  console.log(`[grading] promoteActiveProspects: ${promoted} prospect(s) promoted to grade C`);
  return { promoted };
}

module.exports = {
  calculateGrade,
  writeGradeToZoho,
  logGradeChange,
  runAutoGrading,
  runQuarterlyGrading,
  classifyProspects,
  promoteActiveProspects,
};
