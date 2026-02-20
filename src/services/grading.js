'use strict';

/**
 * Automated customer grading service.
 *
 * Grading criteria (based on visit + invoice history):
 *   A  – visited ≤6 weeks ago  AND  last order ≤6 weeks ago
 *   B  – visited ≤12 weeks ago AND  last order ≤12 weeks ago
 *   C  – any order OR visit in the last 24 months (active customer, minimum grade)
 *   Prospect (is_prospect=TRUE, grade=NULL) – no order AND no visit in 24 months
 *
 * grade_locked = true → never auto-change the grade (prospect downgrades excepted
 *   if there truly is no 24m activity — those get a lapsed alert instead).
 *
 * Exports:
 *   calculateGrade(lastVisit, lastOrder, orderCount12m, hasActivity24m) → { grade, reason }
 *   runAutoGrading()            – grade all ungraded non-prospect stores
 *   runQuarterlyGrading()       – reassess all non-locked stores
 *   classifyProspects()         – mark ungraded inactive stores as prospects
 *   promoteActiveProspects()    – upgrade prospects that now have activity
 *   downgradeInactiveToProspect() – downgrade lapsed graded stores to prospect
 */

const db = require('../db');
const { fetchInvoices } = require('./sync');
const { makeZohoWrite } = require('./zoho');

// ── Timeout-safe invoice fetch ────────────────────────────────────────────────
// Grading fetches a 24m window independently of the dashboard's 13m cache.
// Wrap with a 30s timeout so a slow Zoho response never hangs the process.
// Returns [] on timeout or error — grading functions check for empty and skip.

const GRADING_FETCH_TIMEOUT_MS = 30_000;

function fetchInvoicesForGrading(fromDate, toDate) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Zoho invoice fetch timed out after ${GRADING_FETCH_TIMEOUT_MS / 1000}s`)), GRADING_FETCH_TIMEOUT_MS)
  );
  return Promise.race([fetchInvoices(fromDate, toDate), timeout]);
}

// ── Time constants ─────────────────────────────────────────────────────────────

const W6  = 6  * 7 * 86_400_000;           // 6 weeks in ms
const W12 = 12 * 7 * 86_400_000;           // 12 weeks in ms
const M24 = 24 * 30.44 * 86_400_000;       // ~24 months in ms

// ── Grade calculation ─────────────────────────────────────────────────────────

/**
 * Pure calculation — no DB/Zoho side effects.
 *
 * @param {string|Date|null} lastVisitDate
 * @param {string|Date|null} lastOrderDate
 * @param {number}           orderCount12m  – invoices in the last 12 months
 * @param {boolean}          hasActivity24m – any order OR visit in last 24 months
 * @returns {{ grade: 'A'|'B'|'C'|null, reason: string }}
 */
function calculateGrade(lastVisitDate, lastOrderDate, orderCount12m, hasActivity24m) {
  const now = Date.now();
  const lv  = lastVisitDate ? new Date(lastVisitDate).getTime() : null;
  const lo  = lastOrderDate ? new Date(lastOrderDate).getTime() : null;

  const visitIn6w  = lv && (now - lv) <= W6;
  const visitIn12w = lv && (now - lv) <= W12;
  const orderIn6w  = lo && (now - lo) <= W6;
  const orderIn12w = lo && (now - lo) <= W12;

  if (visitIn6w  && orderIn6w)  return { grade: 'A', reason: 'Visited and ordered within 6 weeks' };
  if (visitIn12w && orderIn12w) return { grade: 'B', reason: 'Visited and ordered within 12 weeks' };
  if (hasActivity24m)           return { grade: 'C', reason: 'Active customer — order or visit in last 24 months' };
  return { grade: null, reason: 'No orders or visits in 24 months' };
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

// ── Alert helpers ─────────────────────────────────────────────────────────────

async function insertGradeChangeAlert(store, oldGrade, newGrade) {
  if (!store.rep_id) return;
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM alert_log
       WHERE alert_type = 'grade_change' AND store_id = $1 AND acknowledged_at IS NULL LIMIT 1`,
      [store.id]
    );
    if (rows.length) return;
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
    console.error('[grading] Grade-change alert insert failed:', err.message);
  }
}

async function insertLapsedAlert(store, oldGrade) {
  if (!store.rep_id) return;
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM alert_log
       WHERE alert_type = 'customer_lapsed' AND store_id = $1 AND acknowledged_at IS NULL LIMIT 1`,
      [store.id]
    );
    if (rows.length) return;
    await db.query(
      `INSERT INTO alert_log (alert_type, store_id, rep_id, tier, alert_title, alert_detail)
       VALUES ('customer_lapsed', $1, $2, 2, $3, $4)`,
      [
        store.id, store.rep_id,
        `${store.name} has lapsed — no activity in 24 months`,
        JSON.stringify({ old_grade: oldGrade }),
      ]
    );
  } catch (err) {
    console.error('[grading] Lapsed alert insert failed:', err.message);
  }
}

// ── Date window helpers ───────────────────────────────────────────────────────

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

function get24MonthWindow() {
  const now  = new Date();
  const from = new Date(now.getFullYear() - 2, now.getMonth(), 1);
  const toD  = new Date(now.getFullYear(), now.getMonth() + 1, 0); // last day of current month
  const pad  = n => String(n).padStart(2, '0');
  return {
    from: `${from.getFullYear()}-${pad(from.getMonth() + 1)}-01`,
    to:   `${toD.getFullYear()}-${pad(toD.getMonth() + 1)}-${pad(toD.getDate())}`,
  };
}

// ── Invoice stats ─────────────────────────────────────────────────────────────

/**
 * Build per-customer invoice stats from a 24m invoice array.
 * Tracks 12m order count (for A/B assessment) and 24m activity flag (for C floor).
 *
 * @param {object[]} invoices
 * @param {string}   windowFrom12m  – 12m window start (YYYY-MM-DD)
 * @param {string}   windowFrom24m  – 24m window start (YYYY-MM-DD)
 * @returns {Map<string, { lastOrderDate, orderCount12m, hasOrder24m }>}
 */
function buildInvoiceStats(invoices, windowFrom12m, windowFrom24m) {
  const map = new Map();
  for (const inv of invoices) {
    const cid = String(inv.customer_id);
    if (!map.has(cid)) map.set(cid, { lastOrderDate: null, orderCount12m: 0, hasOrder24m: false });
    const e = map.get(cid);
    if (!e.lastOrderDate || inv.date > e.lastOrderDate) e.lastOrderDate = inv.date;
    if (inv.date >= windowFrom12m) e.orderCount12m++;
    if (inv.date >= windowFrom24m) e.hasOrder24m = true;
  }
  return map;
}

// ── Core batch grading ────────────────────────────────────────────────────────

/**
 * Grade a batch of stores, applying changes to DB + Zoho.
 * Handles three outcomes per store:
 *   1. Grade assigned/upgraded/downgraded (A→B, C→A, etc.)
 *   2. Store lapsed: had a grade, now no 24m activity → downgrade to Prospect
 *   3. No change → skip
 *
 * @param {object[]} stores        – rows from stores table (must include grade, grade_locked, zoho_contact_id, rep_id)
 * @param {object[]} invoices      – 24m invoice array (used for both 12m and 24m stats)
 * @param {Map}      visitMap      – store_id → last_visit_date
 * @param {string}   windowFrom12m – 12m window start date
 * @param {string}   windowFrom24m – 24m window start date
 * @param {string}   changedBy     – label for grade_history.changed_by
 * @param {boolean}  onlyUngraded  – if true, skip stores that already have a grade
 */
async function gradeStores(stores, invoices, visitMap, windowFrom12m, windowFrom24m, changedBy = 'system', onlyUngraded = false) {
  const invStats = buildInvoiceStats(invoices, windowFrom12m, windowFrom24m);
  let graded = 0, changed = 0, errors = 0;

  for (const store of stores) {
    try {
      if (onlyUngraded && store.grade !== null) continue;

      const cid       = String(store.zoho_contact_id || '');
      const inv       = invStats.get(cid) || { lastOrderDate: null, orderCount12m: 0, hasOrder24m: false };
      const lastVisit = visitMap.get(store.id) || null;

      // Has any visit in the last 24 months?
      const hasVisit24m = lastVisit
        ? (Date.now() - new Date(lastVisit).getTime()) <= M24
        : false;
      const hasActivity24m = inv.hasOrder24m || hasVisit24m;

      const { grade: suggested, reason } = calculateGrade(
        lastVisit, inv.lastOrderDate, inv.orderCount12m, hasActivity24m
      );

      const oldGrade = store.grade;

      // ── Case A: No change ─────────────────────────────────────────────────
      if (suggested === oldGrade) continue;

      // ── Case B: Null suggested + store already has no grade ───────────────
      // → will be handled by classifyProspects(); skip here
      if (suggested === null && (oldGrade === null || oldGrade === undefined)) continue;

      // ── Case C: Null suggested + store currently HAS a grade → lapsed ─────
      // → convert to Prospect, log, alert rep
      if (suggested === null && oldGrade !== null) {
        await db.query(
          `UPDATE stores SET grade = NULL, is_prospect = TRUE WHERE id = $1`,
          [store.id]
        );
        if (store.zoho_contact_id) writeGradeToZoho(store.zoho_contact_id, null).catch(() => {});
        await logGradeChange(store.id, oldGrade, null, 'No orders in 24 months - moved to Prospect', changedBy);
        await insertLapsedAlert(store, oldGrade);
        changed++;
        graded++;
        continue;
      }

      // ── Case D: Normal grade change (initial or reassessment) ─────────────
      await db.query(`UPDATE stores SET grade = $1 WHERE id = $2`, [suggested, store.id]);
      if (store.zoho_contact_id) await writeGradeToZoho(store.zoho_contact_id, suggested);
      await logGradeChange(store.id, oldGrade, suggested, reason, changedBy, store.grade_locked || false);

      if (oldGrade !== null) {
        await insertGradeChangeAlert(store, oldGrade, suggested);
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
 * Auto-grade all ungraded (grade IS NULL), non-prospect, non-locked stores.
 * Uses 24m invoices so any store with activity in 24m gets at least grade C.
 * Called at startup (after invoice cache warms) and via /api/grades/run-auto.
 */
async function runAutoGrading() {
  console.log('[grading] Auto-grade: starting for ungraded stores...');
  const { from: wFrom12, to: wTo } = get12MonthWindow();
  const { from: wFrom24 }          = get24MonthWindow();

  const [{ rows: stores }, invoices, { rows: visitRows }] = await Promise.all([
    db.query(`
      SELECT id, name, grade, grade_locked, zoho_contact_id, rep_id
      FROM stores
      WHERE active = TRUE AND grade IS NULL AND is_prospect = FALSE AND grade_locked = FALSE
    `),
    fetchInvoicesForGrading(wFrom24, wTo).catch((err) => {
      console.error('[grading] Auto-grade: invoice fetch failed:', err.message);
      return [];
    }),
    db.query(`SELECT store_id, MAX(visited_at) AS last_visit FROM visits GROUP BY store_id`),
  ]);

  console.log(`[grading] Auto-grade: ${stores.length} ungraded stores, ${invoices.length} invoices in 24m window`);

  if (invoices.length === 0 && stores.length > 0) {
    console.warn('[grading] Auto-grade: SKIPPING — invoice fetch returned 0 results (possible Zoho API failure). Will retry on next run.');
    return { graded: 0, changed: 0, errors: 0, skipped: true, reason: 'Invoice fetch returned 0 results' };
  }

  const visitMap = new Map(visitRows.map(r => [r.store_id, r.last_visit]));
  const result   = await gradeStores(stores, invoices, visitMap, wFrom12, wFrom24, 'system', true);

  console.log(`[grading] Auto-grade done — ${result.graded} graded, ${result.errors} errors`);
  return result;
}

/**
 * Quarterly reassessment: recalculate grade for ALL non-locked stores.
 * Includes downgrade-to-prospect for lapsed customers (via gradeStores Case C).
 * Called by cron on last day of each quarter, and via /api/grades/run-quarterly.
 */
async function runQuarterlyGrading() {
  console.log('[grading] Quarterly reassessment: starting...');
  const { from: wFrom12, to: wTo } = get12MonthWindow();
  const { from: wFrom24 }          = get24MonthWindow();

  const [{ rows: stores }, invoices, { rows: visitRows }] = await Promise.all([
    db.query(`
      SELECT id, name, grade, grade_locked, zoho_contact_id, rep_id
      FROM stores
      WHERE active = TRUE AND is_prospect = FALSE AND grade_locked = FALSE
    `),
    fetchInvoicesForGrading(wFrom24, wTo).catch((err) => {
      console.error('[grading] Quarterly: invoice fetch failed:', err.message);
      return [];
    }),
    db.query(`SELECT store_id, MAX(visited_at) AS last_visit FROM visits GROUP BY store_id`),
  ]);

  console.log(`[grading] Quarterly: ${stores.length} stores to reassess, ${invoices.length} invoices in 24m window`);

  if (invoices.length === 0) {
    console.warn('[grading] Quarterly: SKIPPING — invoice fetch returned 0 results (possible Zoho API failure).');
    return { graded: 0, changed: 0, errors: 0, skipped: true, reason: 'Invoice fetch returned 0 results' };
  }

  const visitMap = new Map(visitRows.map(r => [r.store_id, r.last_visit]));
  const result   = await gradeStores(stores, invoices, visitMap, wFrom12, wFrom24, 'system', false);

  console.log(`[grading] Quarterly done — ${result.graded} updated, ${result.changed} changed, ${result.errors} errors`);
  return result;
}

// ── Prospect classification ───────────────────────────────────────────────────

/**
 * Mark ungraded stores as prospects when they have no invoice or visit in 24m.
 * Runs after runAutoGrading() — at that point any store still grade=null has
 * no qualifying activity, so this sweep correctly identifies true prospects.
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
  const invoices = await fetchInvoicesForGrading(from, to).catch(() => []);
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
  const invoices = await fetchInvoicesForGrading(from, to).catch(() => []);
  const activeContacts = new Set(invoices.map(i => String(i.customer_id)));

  let promoted = 0;
  for (const store of prospects) {
    const hasInvoice = store.zoho_contact_id && activeContacts.has(String(store.zoho_contact_id));
    if (!hasInvoice && store.visit_count === 0) continue;

    await db.query(`UPDATE stores SET is_prospect = FALSE, grade = 'C' WHERE id = $1`, [store.id]);
    await logGradeChange(store.id, null, 'C', 'Promoted from prospect — first activity recorded', 'system');
    if (store.zoho_contact_id) writeGradeToZoho(store.zoho_contact_id, 'C').catch(() => {});
    promoted++;
  }

  console.log(`[grading] promoteActiveProspects: ${promoted} prospect(s) promoted to grade C`);
  return { promoted };
}

/**
 * Downgrade currently-graded stores that have had no order or visit in 24 months.
 * Sets is_prospect=TRUE, grade=NULL, logs to grade_history, alerts rep.
 * Respects grade_locked — locked stores get a lapsed alert but keep their grade.
 */
async function downgradeInactiveToProspect() {
  console.log('[grading] downgradeInactiveToProspect: checking for lapsed customers…');
  const { from: wFrom12, to: wTo } = get12MonthWindow();
  const { from: wFrom24 }          = get24MonthWindow();

  const [{ rows: stores }, invoices, { rows: visitRows }] = await Promise.all([
    db.query(`
      SELECT id, name, grade, grade_locked, zoho_contact_id, rep_id
      FROM stores
      WHERE active = TRUE AND grade IS NOT NULL AND is_prospect = FALSE
    `),
    fetchInvoicesForGrading(wFrom24, wTo).catch((err) => {
      console.error('[grading] downgradeInactiveToProspect: invoice fetch failed:', err.message);
      return [];
    }),
    db.query(`SELECT store_id, MAX(visited_at) AS last_visit FROM visits GROUP BY store_id`),
  ]);

  console.log(`[grading] downgradeInactiveToProspect: ${stores.length} graded stores, ${invoices.length} invoices in 24m window`);

  if (invoices.length === 0) {
    console.warn('[grading] downgradeInactiveToProspect: SKIPPING — invoice fetch returned 0 results (would incorrectly downgrade all stores). Will retry on next run.');
    return { downgraded: 0, alerted: 0, errors: 0, skipped: true, reason: 'Invoice fetch returned 0 results' };
  }

  const visitMap = new Map(visitRows.map(r => [r.store_id, r.last_visit]));
  const invStats = buildInvoiceStats(invoices, wFrom12, wFrom24);

  let downgraded = 0, alerted = 0, errors = 0;

  for (const store of stores) {
    try {
      const cid         = String(store.zoho_contact_id || '');
      const inv         = invStats.get(cid) || { hasOrder24m: false };
      const lastVisit   = visitMap.get(store.id) || null;
      const hasVisit24m = lastVisit
        ? (Date.now() - new Date(lastVisit).getTime()) <= M24
        : false;

      if (inv.hasOrder24m || hasVisit24m) continue; // Still active

      if (store.grade_locked) {
        // Locked: don't remove grade, but alert rep that customer is lapsed
        await insertLapsedAlert(store, store.grade);
        alerted++;
        continue;
      }

      // Not locked: downgrade to Prospect
      await db.query(`UPDATE stores SET grade = NULL, is_prospect = TRUE WHERE id = $1`, [store.id]);
      if (store.zoho_contact_id) writeGradeToZoho(store.zoho_contact_id, null).catch(() => {});
      await logGradeChange(store.id, store.grade, null, 'No orders in 24 months - moved to Prospect', 'system');
      await insertLapsedAlert(store, store.grade);
      downgraded++;
    } catch (err) {
      console.error(`[grading] Downgrade error for store ${store.id}:`, err.message);
      errors++;
    }
  }

  console.log(`[grading] downgradeInactiveToProspect: ${downgraded} downgraded, ${alerted} alerted (locked), ${errors} errors`);
  return { downgraded, alerted, errors };
}

module.exports = {
  calculateGrade,
  writeGradeToZoho,
  logGradeChange,
  runAutoGrading,
  runQuarterlyGrading,
  classifyProspects,
  promoteActiveProspects,
  downgradeInactiveToProspect,
};
