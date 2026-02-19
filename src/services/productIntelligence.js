'use strict';

/**
 * Product Intelligence Service
 *
 * All calculations operate on the 12-month in-memory invoice cache
 * returned by fetchInvoices(). No additional DB queries are made unless
 * explicitly noted.
 *
 * Key concept — purchase history:
 *   A Map<customerId, Map<itemKey, OrderEvent[]>>
 *   where itemKey = item_id || item_name (whichever is available)
 *   and OrderEvent = { date, qty, total, itemName }
 */

const { BRANDS, getBrandForItem } = require('../config/brands');

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Normalise a line item key (prefer item_id, fall back to name).
 * Returns null if neither is available.
 */
function itemKey(line) {
  return line.item_id ? String(line.item_id) : (line.name || line.item_name || null);
}

/**
 * Build purchase history from raw invoices.
 * Returns: Map<customerId, Map<itemKey, OrderEvent[]>>
 *   OrderEvent: { date: 'YYYY-MM-DD', qty, total, itemName }
 */
function buildHistory(invoices) {
  const hist = new Map(); // customerId → Map<itemKey → events[]>

  for (const inv of invoices) {
    const cid = String(inv.customer_id);
    if (!hist.has(cid)) hist.set(cid, new Map());
    const storeMap = hist.get(cid);

    for (const line of inv.line_items || []) {
      const key = itemKey(line);
      if (!key) continue;
      if (!storeMap.has(key)) storeMap.set(key, []);
      storeMap.get(key).push({
        date:     inv.date || '',
        qty:      Number(line.quantity   || 0),
        total:    Number(line.item_total || 0),
        itemName: line.name || line.item_name || key,
      });
    }
  }

  return hist;
}

/** Median of a sorted numeric array */
function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Days between two YYYY-MM-DD strings */
function daysBetween(a, b) {
  return Math.abs((new Date(b) - new Date(a)) / 86400000);
}

// ── Exported calculations ─────────────────────────────────────────────────────

/**
 * skuReorderRate — % of stores that ordered this SKU more than once.
 * @returns { rate: number|null, orderedBy: number, repeats: number }
 */
function skuReorderRate(itemId, history) {
  let total = 0, repeats = 0;
  for (const [, storeMap] of history) {
    const events = storeMap.get(itemId);
    if (!events || events.length === 0) continue;
    total++;
    if (events.length > 1) repeats++;
  }
  return {
    rate:      total === 0 ? null : Math.round((repeats / total) * 100),
    orderedBy: total,
    repeats,
  };
}

/**
 * timeToReorder — median days between consecutive orders of a SKU.
 * Considers only stores that ordered the SKU 2+ times.
 * @returns median days (number) or null if insufficient data.
 */
function timeToReorder(itemId, history) {
  const gaps = [];
  for (const [, storeMap] of history) {
    const events = storeMap.get(itemId);
    if (!events || events.length < 2) continue;
    const dates = events.map(e => e.date).filter(Boolean).sort();
    for (let i = 1; i < dates.length; i++) {
      gaps.push(daysBetween(dates[i - 1], dates[i]));
    }
  }
  if (gaps.length === 0) return null;
  return Math.round(median(gaps.sort((a, b) => a - b)));
}

/**
 * lineSurvivalRate — % of stores that first ordered a SKU >= N months ago
 * AND ordered it again within that window.
 * @returns { s6m: number|null, s12m: number|null }
 */
function lineSurvivalRate(itemId, history) {
  const now = new Date();
  const cutoff6m  = new Date(now.getFullYear(), now.getMonth() - 6, 1).toISOString().slice(0, 10);
  const cutoff12m = new Date(now.getFullYear(), now.getMonth() - 12, 1).toISOString().slice(0, 10);

  let eligible6 = 0, survived6 = 0;
  let eligible12 = 0, survived12 = 0;

  for (const [, storeMap] of history) {
    const events = storeMap.get(itemId);
    if (!events || events.length === 0) continue;
    const dates = events.map(e => e.date).filter(Boolean).sort();
    const first = dates[0];
    const last  = dates[dates.length - 1];

    if (first <= cutoff6m) {
      eligible6++;
      if (last > cutoff6m) survived6++;
    }
    if (first <= cutoff12m) {
      eligible12++;
      if (last > cutoff12m) survived12++;
    }
  }

  return {
    s6m:  eligible6  === 0 ? null : Math.round((survived6  / eligible6)  * 100),
    s12m: eligible12 === 0 ? null : Math.round((survived12 / eligible12) * 100),
  };
}

/**
 * brandReorderRate — reorder rate aggregated across all SKUs for a brand.
 * A store "reordered" if they placed 2+ orders containing any brand SKU.
 * @returns { rate: number|null, orderedBy: number, repeats: number }
 */
function brandReorderRate(brandSlug, history, invoices) {
  // Build set of item keys belonging to this brand
  const brandItems = new Set();
  for (const inv of invoices) {
    for (const line of inv.line_items || []) {
      const brand = getBrandForItem(line.item_id, line.name || line.item_name);
      if (brand && brand.slug === brandSlug) {
        const key = itemKey(line);
        if (key) brandItems.add(key);
      }
    }
  }

  let total = 0, repeats = 0;
  for (const [, storeMap] of history) {
    // Collect all brand-related orders across all brand SKUs, flatten to invoice dates
    const invoiceDates = new Set();
    for (const [key, events] of storeMap) {
      if (!brandItems.has(key)) continue;
      for (const e of events) if (e.date) invoiceDates.add(e.date);
    }
    if (invoiceDates.size === 0) continue;
    total++;
    if (invoiceDates.size > 1) repeats++;
  }

  return {
    rate:      total === 0 ? null : Math.round((repeats / total) * 100),
    orderedBy: total,
    repeats,
  };
}

/**
 * repeatVsNewMix — for each store: % of order value from repeat vs new SKUs.
 * "Repeat" = SKU the store ordered before.
 * @returns Map<customerId, { repeatPct: number, newPct: number, total: number }>
 */
function repeatVsNewMix(history) {
  const result = new Map();

  for (const [cid, storeMap] of history) {
    let repeatValue = 0, newValue = 0;

    for (const [, events] of storeMap) {
      if (events.length === 0) continue;
      const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
      // First event is "new", subsequent are "repeat"
      newValue    += sorted[0].total;
      for (let i = 1; i < sorted.length; i++) repeatValue += sorted[i].total;
    }

    const total = repeatValue + newValue;
    if (total === 0) continue;

    result.set(cid, {
      repeatPct: Math.round((repeatValue / total) * 100),
      newPct:    Math.round((newValue    / total) * 100),
      total,
    });
  }

  return result;
}

/**
 * classifyStoreBehaviour — classify a store into one of 4 behaviours.
 *
 * @param {string}        zohoContactId – store's Zoho contact ID
 * @param {string}        grade         – 'A' | 'B' | 'C' | null
 * @param {Map}           history       – output of buildHistory()
 * @param {object[]}      invoices      – raw invoice array (12m)
 * @returns {object}  { classification, repeatPct, skuCount, reorderRate, orderCount, evidence }
 */
function classifyStoreBehaviour(zohoContactId, grade, history, invoices) {
  const cid      = String(zohoContactId);
  const storeMap = history.get(cid) || new Map();

  // Metrics
  const skuCount   = storeMap.size;
  let   totalValue = 0, repeatValue = 0, orderCount = 0;

  // Count total invoice dates for this store (= unique "orders")
  const orderDates = new Set(
    (invoices || [])
      .filter(inv => String(inv.customer_id) === cid && inv.date)
      .map(inv => inv.date)
  );
  orderCount = orderDates.size;

  for (const [, events] of storeMap) {
    const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
    totalValue += sorted[0].total;
    for (let i = 1; i < sorted.length; i++) {
      totalValue  += sorted[i].total;
      repeatValue += sorted[i].total;
    }
  }

  const repeatPct  = totalValue > 0 ? Math.round((repeatValue / totalValue) * 100) : 0;
  const reorderRate = skuReorderRate(null, history); // won't use this directly; calc manually below

  // % of SKUs that were re-ordered at least once
  let reorderedSkus = 0;
  for (const [, events] of storeMap) {
    if (events.length > 1) reorderedSkus++;
  }
  const skuReorderRatePct = skuCount > 0 ? Math.round((reorderedSkus / skuCount) * 100) : 0;

  // Classification logic
  let classification;
  if ((['A', 'B'].includes(grade)) && skuCount <= 2 && skuReorderRatePct < 50) {
    classification = 'Under-Optimised';
  } else if (repeatPct > 70 && skuReorderRatePct > 50) {
    classification = 'Replenisher';
  } else if (repeatPct < 40 && skuCount >= 3) {
    classification = 'Rotator';
  } else {
    classification = 'Opportunistic';
  }

  return {
    classification,
    repeatPct,
    skuCount,
    skuReorderRatePct,
    orderCount,
    evidence: [
      { label: 'Repeat SKU %',   value: `${repeatPct}%` },
      { label: 'SKU depth',      value: String(skuCount) },
      { label: 'SKU reorder %',  value: `${skuReorderRatePct}%` },
    ],
  };
}

/**
 * getTopSkus — Top N SKUs by reorder rate (filtered to those with ≥ minStores).
 * @returns array sorted descending by reorder rate
 */
function getTopSkus(history, invoices, { limit = 20, minStores = 3 } = {}) {
  // Collect all known item keys + names
  const itemMeta = new Map(); // itemKey → { name, brand }
  for (const inv of invoices) {
    for (const line of inv.line_items || []) {
      const key  = itemKey(line);
      if (!key) continue;
      if (!itemMeta.has(key)) {
        const brand = getBrandForItem(line.item_id, line.name || line.item_name);
        itemMeta.set(key, {
          name:  line.name || line.item_name || key,
          brand: brand?.name || 'Unknown',
          brandSlug: brand?.slug || null,
        });
      }
    }
  }

  const results = [];
  for (const [key, meta] of itemMeta) {
    const rr  = skuReorderRate(key, history);
    if (rr.orderedBy < minStores) continue;
    const ttr = timeToReorder(key, history);
    const srv = lineSurvivalRate(key, history);
    results.push({
      itemId:        key,
      name:          meta.name,
      brand:         meta.brand,
      brandSlug:     meta.brandSlug,
      reorderRate:   rr.rate,
      orderedBy:     rr.orderedBy,
      repeats:       rr.repeats,
      timeToReorder: ttr,
      survival6m:    srv.s6m,
      survival12m:   srv.s12m,
    });
  }

  return results
    .sort((a, b) => (b.reorderRate ?? -1) - (a.reorderRate ?? -1))
    .slice(0, limit);
}

/**
 * getBrandSummary — reorder rate + ordered-by count for all 5 brands.
 */
function getBrandSummary(history, invoices) {
  return BRANDS.map(brand => {
    const rr = brandReorderRate(brand.slug, history, invoices);
    return {
      slug:      brand.slug,
      name:      brand.name,
      ...rr,
    };
  });
}

/**
 * getSkuDetail — full metrics + stores stocking / dropped for one SKU.
 * @param {string}   itemId
 * @param {Map}      history
 * @param {object[]} invoices
 * @param {object[]} storeRows  – rows from DB { id, name, zoho_contact_id, grade, rep_name }
 * @returns object with all SKU metrics, stockingStores, droppedStores
 */
function getSkuDetail(itemId, history, invoices, storeRows) {
  const now    = new Date();
  const cut6m  = new Date(now.getFullYear(), now.getMonth() - 6,  1).toISOString().slice(0, 10);
  const cut12m = new Date(now.getFullYear(), now.getMonth() - 12, 1).toISOString().slice(0, 10);

  const storeByContact = {};
  for (const s of storeRows) storeByContact[String(s.zoho_contact_id)] = s;

  const rr  = skuReorderRate(itemId, history);
  const ttr = timeToReorder(itemId, history);
  const srv = lineSurvivalRate(itemId, history);

  // Find item name / brand from the first occurrence
  let itemName = itemId, brandName = 'Unknown';
  for (const inv of invoices) {
    for (const line of inv.line_items || []) {
      if (itemKey(line) === itemId) {
        itemName  = line.name || line.item_name || itemId;
        const b   = getBrandForItem(line.item_id, itemName);
        if (b) brandName = b.name;
        break;
      }
    }
    if (itemName !== itemId) break;
  }

  // Stocking: ordered in last 6m. Dropped: ordered 6-12m ago, not since.
  const stockingStores = [], droppedStores = [];

  for (const [cid, storeMap] of history) {
    const events = storeMap.get(itemId);
    if (!events || events.length === 0) continue;
    const dates = events.map(e => e.date).filter(Boolean).sort();
    const lastDate = dates[dates.length - 1];
    const store = storeByContact[cid] || { id: null, name: cid, grade: null, rep_name: null };

    if (lastDate >= cut6m) {
      stockingStores.push({ ...store, lastOrderDate: lastDate });
    } else if (lastDate >= cut12m && lastDate < cut6m) {
      droppedStores.push({ ...store, lastOrderDate: lastDate });
    }
  }

  return {
    itemId,
    name:            itemName,
    brand:           brandName,
    reorderRate:     rr.rate,
    orderedBy:       rr.orderedBy,
    repeats:         rr.repeats,
    timeToReorder:   ttr,
    survival6m:      srv.s6m,
    survival12m:     srv.s12m,
    stockingStores:  stockingStores.sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    droppedStores:   droppedStores.sort((a, b) => (a.name || '').localeCompare(b.name || '')),
  };
}

// ── Main entry points (used by API routes) ────────────────────────────────────

/**
 * computeOverview — called by GET /api/products
 */
function computeOverview(invoices) {
  const history = buildHistory(invoices);
  return {
    topSkus:      getTopSkus(history, invoices, { limit: 20, minStores: 2 }),
    brandSummary: getBrandSummary(history, invoices),
    history,   // returned so callers can reuse without rebuilding
  };
}

/**
 * computeSkuDetail — called by GET /api/products/sku/:itemId
 */
function computeSkuDetail(itemId, invoices, storeRows) {
  const history = buildHistory(invoices);
  return getSkuDetail(itemId, history, invoices, storeRows);
}

/**
 * computeStoreBehaviour — called by GET /api/products/store/:storeId/behaviour
 */
function computeStoreBehaviour(zohoContactId, grade, invoices) {
  const history = buildHistory(invoices);
  return classifyStoreBehaviour(zohoContactId, grade, history, invoices);
}

module.exports = {
  computeOverview,
  computeSkuDetail,
  computeStoreBehaviour,
  buildHistory,
  repeatVsNewMix,
};
