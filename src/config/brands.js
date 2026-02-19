'use strict';

/**
 * Artico brand configuration.
 *
 * skuPrefixes / nameKeywords are used to map Zoho invoice line items
 * to a brand slug for product intelligence calculations.
 *
 * TODO: Confirm actual Zoho item IDs / SKU prefixes with Owain and populate
 *       skuPrefixes for each brand. Until then, matching falls back to
 *       nameKeywords (case-insensitive substring match on item_name).
 */

const BRANDS = [
  {
    slug:           'name-a-star',
    name:           'Name a Star',
    nameKeywords:   ['name a star', 'nastar', 'nas-'],
    skuPrefixes:    [],           // TODO: populate from Zoho item list
    zohoItemGroupId: null,        // TODO: populate
  },
  {
    slug:           'shall-we-bloom',
    name:           'Shall We Bloom',
    nameKeywords:   ['shall we bloom', 'swbloom', 'swb-'],
    skuPrefixes:    [],
    zohoItemGroupId: null,
  },
  {
    slug:           'salt-and-wattle',
    name:           'Salt & Wattle',
    nameKeywords:   ['salt & wattle', 'salt and wattle', 'saltwattle', 'saw-'],
    skuPrefixes:    [],
    zohoItemGroupId: null,
  },
  {
    slug:           'better-read-than-dead',
    name:           'Better Read Than Dead',
    nameKeywords:   ['better read than dead', 'brtd-'],
    skuPrefixes:    [],
    zohoItemGroupId: null,
  },
  {
    slug:           'australian-made',
    name:           'Australian Made Range',
    nameKeywords:   ['australian made', 'aus made', 'aum-'],
    skuPrefixes:    [],
    zohoItemGroupId: null,
  },
];

const BRANDS_BY_SLUG = Object.fromEntries(BRANDS.map(b => [b.slug, b]));

/**
 * Attempt to resolve a brand for a line item.
 * Returns the brand object or null if unresolvable.
 *
 * @param {string|null} itemId   – Zoho item_id
 * @param {string|null} itemName – Zoho item name
 */
function getBrandForItem(itemId, itemName) {
  const id   = (itemId   || '').toLowerCase();
  const name = (itemName || '').toLowerCase();

  for (const brand of BRANDS) {
    // Exact prefix match on SKU/item_id
    for (const pfx of brand.skuPrefixes) {
      if (id.startsWith(pfx.toLowerCase())) return brand;
    }
    // Keyword match on item name
    for (const kw of brand.nameKeywords) {
      if (name.includes(kw) || id.startsWith(kw)) return brand;
    }
  }
  return null;
}

module.exports = { BRANDS, BRANDS_BY_SLUG, getBrandForItem };
