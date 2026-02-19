/**
 * Artico Brand Configuration
 *
 * Maps each brand slug to its display name and Zoho item identifiers.
 *
 * TODO: All SKU prefixes / item group IDs below are PLACEHOLDERS.
 *       Before Prompt 7 (Product Intelligence), confirm the actual
 *       item naming / category conventions in Zoho Books by running:
 *
 *         GET /books/v3/items?organization_id=689159620
 *
 *       Then update skuPrefixes and zohoItemGroupId for each brand.
 */

const BRANDS = [
  {
    slug: 'shall-we-bloom',
    name: 'Shall We Bloom',
    // TODO: confirm SKU prefix(es) with Zoho item data
    skuPrefixes: ['SWB'],
    // TODO: confirm Zoho item group / category ID
    zohoItemGroupId: null,
  },
  {
    slug: 'salt-and-wattle',
    name: 'Salt & Wattle',
    // TODO: confirm SKU prefix(es) with Zoho item data
    skuPrefixes: ['SAW'],
    // TODO: confirm Zoho item group / category ID
    zohoItemGroupId: null,
  },
  {
    slug: 'name-a-star',
    name: 'Name A Star',
    // TODO: confirm SKU prefix(es) with Zoho item data
    skuPrefixes: ['NAS'],
    // TODO: confirm Zoho item group / category ID
    zohoItemGroupId: null,
  },
  {
    slug: 'chapter-and-light',
    name: 'Chapter & Light',
    // TODO: confirm SKU prefix(es) with Zoho item data
    skuPrefixes: ['CAL'],
    // TODO: confirm Zoho item group / category ID
    zohoItemGroupId: null,
  },
  {
    slug: 'australian-made',
    name: 'Australian Made',
    // TODO: confirm SKU prefix(es) with Zoho item data
    skuPrefixes: ['AUM'],
    // TODO: confirm Zoho item group / category ID
    zohoItemGroupId: null,
  },
];

// Keyed lookup by slug for O(1) access
const BRANDS_BY_SLUG = Object.fromEntries(BRANDS.map((b) => [b.slug, b]));

module.exports = { BRANDS, BRANDS_BY_SLUG };
