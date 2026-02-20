'use strict';

/**
 * Zoho Books data sync functions.
 *
 * syncStores()          – Upserts Zoho Contacts → local stores table.
 * fetchInvoices()       – Returns raw invoice array from Zoho (not stored locally).
 * fetchSalesOrders()    – Returns raw sales order array from Zoho (not stored locally).
 * startScheduler()      – Starts the 60-minute background sync via setInterval.
 */

const { makeZohoRequest, makeZohoWrite } = require('./zoho');
const db = require('../db');

// ── Pagination helper ─────────────────────────────────────────────────────────

/**
 * Fetch all pages from a paginated Zoho endpoint.
 *
 * @param {string} endpoint   – e.g. '/invoices'
 * @param {string} arrayKey   – key in the response that holds the array, e.g. 'invoices'
 * @param {object} params     – base query params (merged with page/per_page)
 */
async function fetchAllPages(endpoint, arrayKey, params = {}) {
  const results = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const data = await makeZohoRequest(endpoint, {
      ...params,
      page,
      per_page: 200,
    });
    const items = data[arrayKey];
    if (Array.isArray(items)) results.push(...items);
    hasMore = data.page_context?.has_more_page === true;
    page++;
  }

  return results;
}

// ── Custom field helpers ──────────────────────────────────────────────────────

/**
 * Extract a custom field value from Zoho's custom_fields array by api_name.
 * Custom fields are returned as: [{ api_name: 'cf_store_grade', value: 'A', ... }]
 */
function getCustomField(customFields, apiName) {
  if (!apiName || !Array.isArray(customFields)) return null;
  const field = customFields.find((f) => f.api_name === apiName);
  return field ? (field.value ?? null) : null;
}

// ── Sync log helpers ──────────────────────────────────────────────────────────

async function startSyncLog(syncType) {
  const { rows } = await db.query(
    `INSERT INTO zoho_sync_log (sync_type, status, started_at)
     VALUES ($1, 'running', NOW())
     RETURNING id`,
    [syncType]
  );
  return rows[0].id;
}

async function completeSyncLog(id, recordsProcessed) {
  await db.query(
    `UPDATE zoho_sync_log
     SET status = 'completed', completed_at = NOW(), records_processed = $2
     WHERE id = $1`,
    [id, recordsProcessed]
  );
}

async function failSyncLog(id, errorMessage) {
  await db.query(
    `UPDATE zoho_sync_log
     SET status = 'error', completed_at = NOW(), error_message = $2
     WHERE id = $1`,
    [id, String(errorMessage).slice(0, 1000)]
  );
}

// ── Last-sync in-memory cache ─────────────────────────────────────────────────

const _lastSyncAt = {};
const SYNC_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function isSyncRecentEnough(syncType) {
  const ts = _lastSyncAt[syncType];
  return ts && Date.now() - ts < SYNC_CACHE_TTL_MS;
}

function _markSyncDone(syncType) {
  _lastSyncAt[syncType] = Date.now();
}

// ── Item brand map cache ──────────────────────────────────────────────────────
// Maps item_id → brand name. Fetched from /items endpoint, cached 24 hours.
// Invoice line items have item_id but not brand; this map bridges the gap.

let _itemBrandMapCache = null;
let _itemBrandMapFetchedAt = 0;
const ITEM_BRAND_MAP_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Returns a Map<item_id, brand_name> for all active Zoho items that have a brand.
 * Cached for 24 hours. Falls back to empty Map on error.
 */
async function fetchItemBrandMap() {
  if (_itemBrandMapCache && Date.now() - _itemBrandMapFetchedAt < ITEM_BRAND_MAP_TTL) {
    return _itemBrandMapCache;
  }

  console.log('[sync] Fetching item brand map from Zoho...');
  const map = new Map();
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const data = await makeZohoRequest('/items', {
      filter_by: 'Status.Active',
      per_page: 200,
      page,
    });
    const items = data.items || [];
    for (const item of items) {
      const brand = (item.brand || '').trim();
      if (item.item_id && brand) {
        map.set(String(item.item_id), brand);
      }
    }
    hasMore = data.page_context?.has_more_page === true;
    page++;
  }

  _itemBrandMapCache = map;
  _itemBrandMapFetchedAt = Date.now();
  console.log(`[sync] Item brand map cached — ${map.size} items with brands`);
  return map;
}

// ── Invoice in-memory cache ───────────────────────────────────────────────────
// Keyed by "fromDate::toDate". Only used for unfiltered (full-range) fetches.
// Avoids the ~40s cold Zoho fetch on every dashboard load.

const _invoiceCache = new Map();
const INVOICE_CACHE_TTL = 60 * 60 * 1000; // 60 minutes

function _getCachedInvoices(fromDate, toDate) {
  const key   = `${fromDate}::${toDate}`;
  const entry = _invoiceCache.get(key);
  if (!entry || Date.now() - entry.ts > INVOICE_CACHE_TTL) {
    _invoiceCache.delete(key);
    return null;
  }
  return entry.data;
}

function _setCachedInvoices(fromDate, toDate, data) {
  _invoiceCache.set(`${fromDate}::${toDate}`, { data, ts: Date.now() });
}

function invalidateInvoiceCache() {
  _invoiceCache.clear();
}

// ── syncStores() ──────────────────────────────────────────────────────────────

/**
 * Fetch all customer Contacts from Zoho Books and upsert into local stores table.
 *
 * Fields pulled from Zoho (confirmed via /api/zoho-test):
 *   contact_id            → zoho_contact_id
 *   company_name          → name  (falls back to contact_name if blank)
 *   cf_category           → channel_type  (dropdown: 'Gift Store', etc.)
 *   cf_store_grade        → grade  (TODO: field does not exist in Zoho yet — create it)
 *   cf_sales_rep          → rep_id  (matched against local users table)
 *   cf_sales_region       → TODO: no region column in stores schema yet; add in a later migration
 *   billing_address.state → state
 */

async function syncStores({ force = false } = {}) {
  if (!force && isSyncRecentEnough('stores')) {
    console.log('[sync] Skipping store sync — last run < 15 minutes ago');
    return { skipped: true };
  }

  const logId = await startSyncLog('contacts');
  console.log('[sync] Starting store sync from Zoho Books contacts');

  try {
    // Fetch all customer contacts (paginated)
    const contacts = await fetchAllPages('/contacts', 'contacts', {
      contact_type: 'customer',
    });

    // Build salesperson-name → local user.id lookup maps
    const { rows: users } = await db.query(
      `SELECT id, name, zoho_salesperson_id FROM users WHERE active = true`
    );
    const repByZohoId = {};
    const repByName = {};
    for (const u of users) {
      if (u.zoho_salesperson_id) repByZohoId[u.zoho_salesperson_id] = u.id;
      repByName[u.name.toLowerCase()] = u.id;
    }

    function findRepId(salespersonName) {
      if (!salespersonName) return null;
      // First try matching zoho_salesperson_id (may store Zoho's salesperson name or ID)
      return (
        repByZohoId[salespersonName] ||
        repByName[salespersonName.toLowerCase()] ||
        null
      );
    }

    let upserted = 0;
    const newDefaultC = []; // new stores that got default C (Zoho had no grade)

    for (const contact of contacts) {
      const zohoContactId = contact.contact_id;
      if (!zohoContactId) continue;

      const name =
        contact.company_name || contact.contact_name || '(unnamed)';
      const customFields = contact.custom_fields || [];

      // Grade from Zoho — may be null if cf_store_grade is blank or not set yet.
      // New stores with no Zoho grade default to 'C' (see COALESCE in INSERT below).
      const zohoGrade = getCustomField(customFields, 'cf_store_grade') || null;

      // Channel type (confirmed api_name: cf_category)
      const channelType = getCustomField(customFields, 'cf_category');

      // Zoho Books billing_address is an object: { address, city, state, zip, country, fax }
      const state = contact.billing_address?.state || null;

      // Assigned rep on contact (confirmed api_name: cf_sales_rep)
      const repId = findRepId(getCustomField(customFields, 'cf_sales_rep'));

      const { rows: [row] } = await db.query(
        `INSERT INTO stores
           (zoho_contact_id, name, channel_type, grade, state, rep_id, last_synced_at)
         VALUES ($1, $2, $3, COALESCE($4, 'C'), $5, $6, NOW())
         ON CONFLICT (zoho_contact_id) DO UPDATE SET
           name           = EXCLUDED.name,
           channel_type   = EXCLUDED.channel_type,
           grade          = COALESCE(EXCLUDED.grade, stores.grade),
           state          = EXCLUDED.state,
           rep_id         = EXCLUDED.rep_id,
           last_synced_at = NOW()
         RETURNING id, name, zoho_contact_id, rep_id, (xmax = 0) AS is_new_insert`,
        [zohoContactId, name, channelType, zohoGrade, state, repId]
      );

      upserted++;

      // Track new stores that had no Zoho grade — they received the default C
      if (row.is_new_insert && zohoGrade === null) {
        newDefaultC.push(row);
      }
    }

    // For each newly synced store that had no grade in Zoho:
    // log the initial assignment and write C back to Zoho so it stays in sync.
    let defaultCCount = 0;
    for (const store of newDefaultC) {
      try {
        await db.query(
          `INSERT INTO grade_history (store_id, old_grade, new_grade, reason, changed_by)
           VALUES ($1, NULL, 'C', 'New customer - default grade C', 'system')`,
          [store.id]
        );

        if (store.zoho_contact_id) {
          makeZohoWrite('PUT', `/contacts/${store.zoho_contact_id}`, {
            custom_fields: [{ api_name: 'cf_store_grade', value: 'C' }],
          }).catch(err =>
            console.error(`[sync] Zoho grade write failed for contact ${store.zoho_contact_id}:`, err.message)
          );
        }

        defaultCCount++;
      } catch (err) {
        console.error(`[sync] Failed to log default grade for store ${store.id} (${store.name}):`, err.message);
      }
    }

    if (defaultCCount > 0) {
      console.log(`[sync] Default C grade assigned to ${defaultCCount} new store(s)`);
    }

    await completeSyncLog(logId, upserted);
    _markSyncDone('stores');
    console.log(`[sync] Store sync complete — ${upserted} contacts upserted`);
    return { upserted };
  } catch (err) {
    await failSyncLog(logId, err.message);
    console.error('[sync] Store sync failed:', err.message);
    throw err;
  }
}

// ── fetchInvoices(fromDate, toDate, extraParams?) ─────────────────────────────

/**
 * Fetch invoices with status 'sent' or 'paid' within the given date range.
 * Returns raw invoice objects — not stored locally.
 *
 * Each invoice contains (at minimum):
 *   invoice_id, customer_id, salesperson_name, date, sub_total (ex-GST), total (inc-GST), line_items[]
 *   Use sub_total for all revenue calculations — it is the ex-GST amount.
 *
 * line_items contains: item_id, name, quantity, item_total (ex-GST per line)
 *   TODO: Confirm 'sku' field name on line items if SKU-based brand matching is needed.
 *
 * TODO: Verify that 'date_start'/'date_end' are the correct Zoho Books filter
 *       param names for invoices. If date filtering returns all invoices, try
 *       'from_date'/'to_date' instead.
 *
 * @param {string} fromDate    – 'YYYY-MM-DD'
 * @param {string} toDate      – 'YYYY-MM-DD'
 * @param {object} extraParams – optional extra Zoho query params (e.g. { customer_id })
 */
async function fetchInvoices(fromDate, toDate, extraParams = {}) {
  // Use cache for unfiltered (full-range) calls — these are the expensive ones
  const useCache = Object.keys(extraParams).length === 0;
  if (useCache) {
    const cached = _getCachedInvoices(fromDate, toDate);
    if (cached) {
      console.log(`[sync] fetchInvoices cache hit — ${fromDate} to ${toDate} (${cached.length} invoices)`);
      return cached;
    }
  }

  console.log(`[sync] fetchInvoices fetching from Zoho — ${fromDate} to ${toDate}`);
  const baseParams = {
    date_start: fromDate,
    date_end: toDate,
    ...extraParams,
  };

  // Zoho Books only accepts one status value per request
  const [sent, paid] = await Promise.all([
    fetchAllPages('/invoices', 'invoices', { ...baseParams, status: 'sent' }),
    fetchAllPages('/invoices', 'invoices', { ...baseParams, status: 'paid' }),
  ]);

  // Deduplicate — a paid invoice might appear in both sets
  const seen = new Set();
  const all = [];
  for (const inv of [...sent, ...paid]) {
    if (!seen.has(inv.invoice_id)) {
      seen.add(inv.invoice_id);
      all.push(inv);
    }
  }

  if (useCache) {
    _setCachedInvoices(fromDate, toDate, all);
    console.log(`[sync] fetchInvoices cached — ${all.length} invoices`);
  }

  return all;
}

// ── fetchSalesOrders(fromDate, toDate, extraParams?) ──────────────────────────

/**
 * Fetch sales orders within the given date range.
 * Returns raw sales order objects — not stored locally.
 *
 * Used for new-door calculation (first order detection).
 *
 * TODO: Verify that 'date_start'/'date_end' are the correct Zoho Books filter
 *       param names for sales orders.
 *
 * TODO: Confirm which sales order statuses represent confirmed/real orders.
 *       Possible values: draft, open, invoiced, cancelled, void.
 *       Currently fetching 'open' and 'invoiced'.
 *
 * @param {string} fromDate    – 'YYYY-MM-DD'
 * @param {string} toDate      – 'YYYY-MM-DD'
 * @param {object} extraParams – optional extra Zoho query params (e.g. { customer_id })
 */
async function fetchSalesOrders(fromDate, toDate, extraParams = {}) {
  const baseParams = {
    date_start: fromDate,
    date_end: toDate,
    ...extraParams,
  };

  const [open, invoiced] = await Promise.all([
    fetchAllPages('/salesorders', 'salesorders', { ...baseParams, status: 'open' }),
    fetchAllPages('/salesorders', 'salesorders', { ...baseParams, status: 'invoiced' }),
  ]);

  const seen = new Set();
  const all = [];
  for (const so of [...open, ...invoiced]) {
    if (!seen.has(so.salesorder_id)) {
      seen.add(so.salesorder_id);
      all.push(so);
    }
  }

  return all;
}

// ── Background scheduler ──────────────────────────────────────────────────────

let _schedulerStarted = false;

/**
 * Start the 60-minute background store sync.
 * Safe to call multiple times — only the first call has effect.
 */
function startScheduler() {
  if (_schedulerStarted) return;
  _schedulerStarted = true;

  const SIXTY_MIN = 60 * 60 * 1000;

  // Helper to compute a month window ending at the current month.
  // n=13 covers same-month-LY (needed for territory growth on rep dashboards).
  function getMonthWindow(n) {
    const now   = new Date();
    const toD   = new Date(now.getFullYear(), now.getMonth() + 1, 0); // last day of current month
    const fromD = new Date(now.getFullYear(), now.getMonth() - (n - 1), 1);
    const pad   = x => String(x).padStart(2, '0');
    return {
      fromDate: `${fromD.getFullYear()}-${pad(fromD.getMonth() + 1)}-01`,
      toDate:   `${toD.getFullYear()}-${pad(toD.getMonth() + 1)}-${pad(toD.getDate())}`,
    };
  }

  // First sync 30 seconds after startup (lets DB connections settle)
  setTimeout(async () => {
    console.log('[scheduler] Running initial store sync');
    try {
      await syncStores({ force: true });
    } catch (err) {
      console.error('[scheduler] Initial store sync failed:', err.message);
    }

    // Pre-warm invoice cache so first dashboard load is instant
    // 13 months covers same-month LY needed for territory growth (rep dashboards)
    console.log('[scheduler] Pre-warming invoice cache...');
    const { fromDate, toDate } = getMonthWindow(13);
    fetchInvoices(fromDate, toDate).catch((err) =>
      console.error('[scheduler] Invoice cache pre-warm failed:', err.message)
    );

    // Pre-warm item brand map
    fetchItemBrandMap().catch((err) =>
      console.error('[scheduler] Item brand map pre-warm failed:', err.message)
    );
  }, 30_000);

  setInterval(async () => {
    console.log('[scheduler] Running scheduled store sync');
    try {
      await syncStores({ force: true });
    } catch (err) {
      console.error('[scheduler] Scheduled store sync failed:', err.message);
    }

    // Refresh invoice cache each hour to keep data current
    console.log('[scheduler] Refreshing invoice cache...');
    const { fromDate, toDate } = getMonthWindow(13);
    invalidateInvoiceCache();
    fetchInvoices(fromDate, toDate).catch((err) =>
      console.error('[scheduler] Invoice cache refresh failed:', err.message)
    );

    // Refresh item brand map every hour too (brand assignments rarely change,
    // but 24h TTL means it will use the cached version most of the time)
    fetchItemBrandMap().catch((err) =>
      console.error('[scheduler] Item brand map refresh failed:', err.message)
    );
  }, SIXTY_MIN);

  console.log('[scheduler] Store sync scheduled — runs every 60 minutes');
}

module.exports = {
  syncStores,
  fetchInvoices,
  fetchSalesOrders,
  fetchItemBrandMap,
  startScheduler,
  isSyncRecentEnough,
  invalidateInvoiceCache,
};
