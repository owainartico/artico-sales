'use strict';

/**
 * Metric calculation service.
 *
 * All calculations are done on-the-fly from Zoho Books data — invoices
 * and sales orders are NOT stored locally.
 *
 * Functions:
 *   getRepRevenue(repId, month)              → { actual, target, percentage, ytd_actual, ytd_target }
 *   getBrandRevenue(brandSlug, month)        → { actual, target, percentage }
 *   getStoreLastOrderDate(zohoContactId)     → 'YYYY-MM-DD' | null
 *   isNewDoor(zohoContactId, checkDate)      → boolean
 *   getNewDoors(repId, fromDate, toDate)     → [{ zoho_contact_id, store_name, store_id, first_order_date }]
 */

const db = require('../db');
const { fetchInvoices, fetchSalesOrders } = require('./sync');
const { BRANDS_BY_SLUG } = require('../../config/brands');

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Returns the first and last day of a 'YYYY-MM' month as 'YYYY-MM-DD' strings. */
function monthBounds(month) {
  const [year, mon] = month.split('-').map(Number);
  const lastDay = new Date(year, mon, 0).getDate(); // day-0 of next month = last of this
  return {
    fromDate: `${year}-${String(mon).padStart(2, '0')}-01`,
    toDate: `${year}-${String(mon).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  };
}

/** Returns Jan 1 of the year through the last day of the given 'YYYY-MM' month. */
function yearToDateBounds(month) {
  const { toDate } = monthBounds(month);
  const year = month.slice(0, 4);
  return { fromDate: `${year}-01-01`, toDate };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

/**
 * Returns the Zoho salesperson name for a rep.
 * Uses zoho_salesperson_id if set (should store the Zoho salesperson_name string),
 * otherwise falls back to the user's display name.
 *
 * Invoices carry a top-level `salesperson_name` field (confirmed via /api/zoho-test).
 * When creating users, store that exact string in the zoho_salesperson_id column.
 */
/** Returns array of Zoho salesperson names for a rep (supports multi-name users). */
async function getRepSalespersonNames(repId) {
  const { rows } = await db.query(
    `SELECT name, zoho_salesperson_id, zoho_salesperson_ids FROM users WHERE id = $1`,
    [repId]
  );
  if (!rows[0]) return [];
  const u = rows[0];
  if (Array.isArray(u.zoho_salesperson_ids) && u.zoho_salesperson_ids.length) {
    return u.zoho_salesperson_ids;
  }
  return [u.zoho_salesperson_id || u.name];
}

async function getRepTarget(repId, month) {
  const { rows } = await db.query(
    `SELECT amount FROM revenue_targets WHERE rep_id = $1 AND month = $2`,
    [repId, month]
  );
  return rows[0]?.amount ? Number(rows[0].amount) : 0;
}

async function getBrandTarget(brandSlug, month) {
  const { rows } = await db.query(
    `SELECT amount FROM brand_targets WHERE brand_slug = $1 AND month = $2`,
    [brandSlug, month]
  );
  return rows[0]?.amount ? Number(rows[0].amount) : 0;
}

/** Sum YTD targets for a rep (Jan through the month of 'YYYY-MM'). */
async function getRepYtdTarget(repId, month) {
  const year = month.slice(0, 4);
  const endMonthNum = parseInt(month.slice(5, 7), 10);
  const months = [];
  for (let m = 1; m <= endMonthNum; m++) {
    months.push(`${year}-${String(m).padStart(2, '0')}`);
  }
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM revenue_targets
     WHERE rep_id = $1 AND month = ANY($2)`,
    [repId, months]
  );
  return Number(rows[0].total);
}

// ── getRepRevenue ─────────────────────────────────────────────────────────────

/**
 * Revenue for one rep in a given month, plus YTD.
 *
 * @param {number} repId   – local users.id
 * @param {string} month   – 'YYYY-MM'
 * @returns {{ actual, target, percentage, ytd_actual, ytd_target }}
 */
async function getRepRevenue(repId, month) {
  const spNames = await getRepSalespersonNames(repId);
  if (!spNames.length) {
    return { actual: 0, target: 0, percentage: null, ytd_actual: 0, ytd_target: 0 };
  }

  const { fromDate: monthFrom, toDate: monthTo } = monthBounds(month);
  const { fromDate: ytdFrom } = yearToDateBounds(month);

  // Fetch YTD invoices in one call (month is always within YTD)
  const [invoices, target, ytd_target] = await Promise.all([
    fetchInvoices(ytdFrom, monthTo),
    getRepTarget(repId, month),
    getRepYtdTarget(repId, month),
  ]);

  const repInvoices = invoices.filter(
    (inv) => spNames.includes(inv.salesperson_name)
  );

  const ytd_actual = repInvoices.reduce(
    (sum, inv) => sum + Number(inv.total || 0),
    0
  );

  const actual = repInvoices
    .filter((inv) => inv.date >= monthFrom && inv.date <= monthTo)
    .reduce((sum, inv) => sum + Number(inv.total || 0), 0);

  return {
    actual,
    target,
    percentage: target > 0 ? Math.round((actual / target) * 100) : null,
    ytd_actual,
    ytd_target,
  };
}

// ── getBrandRevenue ───────────────────────────────────────────────────────────

/**
 * Revenue for one brand in a given month, calculated from invoice line items.
 *
 * Brand matching uses SKU prefixes defined in config/brands.js.
 * If zohoItemGroupId is set on the brand, that takes priority over SKU prefix matching.
 *
 * TODO: Confirm the correct line item field for SKU. Zoho Books line items may use:
 *   - 'sku'        – if items have SKUs assigned
 *   - 'item_name'  – the item's display name
 *   - 'item_id'    – Zoho's internal item ID
 * Once brands.js is populated with real skuPrefixes/zohoItemGroupId values
 * (see the TODO at top of that file), verify this matching logic against real invoices.
 *
 * @param {string} brandSlug – slug from config/brands.js
 * @param {string} month     – 'YYYY-MM'
 * @returns {{ actual, target, percentage }}
 */
async function getBrandRevenue(brandSlug, month) {
  const brand = BRANDS_BY_SLUG[brandSlug];
  if (!brand) throw new Error(`Unknown brand slug: ${brandSlug}`);

  const { fromDate, toDate } = monthBounds(month);

  const [invoices, target] = await Promise.all([
    fetchInvoices(fromDate, toDate),
    getBrandTarget(brandSlug, month),
  ]);

  let actual = 0;
  for (const inv of invoices) {
    for (const line of inv.line_items || []) {
      const matchesBrand = brand.zohoItemGroupId
        // If we have a Zoho item group ID, match on that
        ? line.item_id === brand.zohoItemGroupId
        // Otherwise match SKU prefix (TODO: confirm 'sku' field name on line items)
        : brand.skuPrefixes.some((prefix) =>
            (line.sku || line.item_name || '').toUpperCase().startsWith(prefix)
          );

      if (matchesBrand) {
        actual += Number(line.item_total || 0);
      }
    }
  }

  return {
    actual,
    target,
    percentage: target > 0 ? Math.round((actual / target) * 100) : null,
  };
}

// ── getStoreLastOrderDate ─────────────────────────────────────────────────────

/**
 * Most recent invoice or sales order date for a given Zoho contact.
 *
 * Searches the last 5 years. Uses Zoho's customer_id filter to minimise
 * data fetched.
 *
 * TODO: Confirm 'customer_id' is the correct Zoho Books query param for
 *       filtering invoices by contact. Some API versions use 'contact_id'.
 *
 * @param {string} zohoContactId
 * @returns {Promise<string|null>} 'YYYY-MM-DD' or null
 */
async function getStoreLastOrderDate(zohoContactId) {
  const toDate = new Date().toISOString().slice(0, 10);
  const fromDate = `${new Date().getFullYear() - 5}-01-01`;

  const extraParams = { customer_id: zohoContactId };

  const [invoices, salesOrders] = await Promise.all([
    fetchInvoices(fromDate, toDate, extraParams),
    fetchSalesOrders(fromDate, toDate, extraParams),
  ]);

  const dates = [...invoices, ...salesOrders]
    .map((doc) => doc.date)
    .filter(Boolean)
    .map((d) => new Date(d));

  if (dates.length === 0) return null;
  dates.sort((a, b) => b - a);
  return dates[0].toISOString().slice(0, 10);
}

// ── isNewDoor ─────────────────────────────────────────────────────────────────

/**
 * Returns true if the contact had no invoice or sales order in the
 * 24 months prior to checkDate.
 *
 * @param {string} zohoContactId
 * @param {string} checkDate – 'YYYY-MM-DD' (the date of their first order in the period)
 * @returns {Promise<boolean>}
 */
async function isNewDoor(zohoContactId, checkDate) {
  const check = new Date(checkDate);

  const windowEnd = new Date(check.getTime() - 86_400_000); // day before checkDate
  const windowStart = new Date(check);
  windowStart.setMonth(windowStart.getMonth() - 24);

  const fromDate = windowStart.toISOString().slice(0, 10);
  const toDate = windowEnd.toISOString().slice(0, 10);

  // If window end is before window start (shouldn't happen, but guard it)
  if (toDate < fromDate) return true;

  const extraParams = { customer_id: zohoContactId };

  const [invoices, salesOrders] = await Promise.all([
    fetchInvoices(fromDate, toDate, extraParams),
    fetchSalesOrders(fromDate, toDate, extraParams),
  ]);

  return invoices.length === 0 && salesOrders.length === 0;
}

// ── getNewDoors ───────────────────────────────────────────────────────────────

/**
 * Customers whose first-ever order (or first in 24+ months) occurred in
 * the given period and whose assigned rep is repId.
 *
 * @param {number} repId
 * @param {string} fromDate – 'YYYY-MM-DD'
 * @param {string} toDate   – 'YYYY-MM-DD'
 * @returns {Promise<Array<{ zoho_contact_id, store_name, store_id, first_order_date }>>}
 */
async function getNewDoors(repId, fromDate, toDate) {
  const spNames = await getRepSalespersonNames(repId);
  if (!spNames.length) return [];

  const [periodInvoices, periodOrders] = await Promise.all([
    fetchInvoices(fromDate, toDate),
    fetchSalesOrders(fromDate, toDate),
  ]);

  // Documents belonging to this rep in the period
  const repDocs = [...periodInvoices, ...periodOrders].filter(
    (doc) => spNames.includes(doc.salesperson_name)
  );

  // Unique customer IDs touched by this rep in the period
  const customerIds = [
    ...new Set(repDocs.map((d) => String(d.customer_id)).filter(Boolean)),
  ];

  const newDoors = [];

  for (const customerId of customerIds) {
    // Earliest order date in the period for this customer
    const docsForCustomer = repDocs
      .filter((d) => String(d.customer_id) === customerId)
      .filter((d) => d.date)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const firstOrderDate = docsForCustomer[0]?.date;
    if (!firstOrderDate) continue;

    const isNew = await isNewDoor(customerId, firstOrderDate);
    if (!isNew) continue;

    // Look up local store record
    const { rows } = await db.query(
      `SELECT id, name FROM stores WHERE zoho_contact_id = $1`,
      [customerId]
    );

    newDoors.push({
      zoho_contact_id: customerId,
      store_name: rows[0]?.name || null,
      store_id: rows[0]?.id || null,
      first_order_date: firstOrderDate,
    });
  }

  return newDoors;
}

module.exports = {
  getRepRevenue,
  getBrandRevenue,
  getStoreLastOrderDate,
  isNewDoor,
  getNewDoors,
};
