'use strict';

const express = require('express');
const multer  = require('multer');
const { parse } = require('csv-parse/sync');
const { requireAuth, requireRole } = require('../middleware/auth');
const db = require('../db');

const router = express.Router();

// ── CSV import helpers ────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

// Column indices in the PixSell diary/calls CSV (0-based, after 5 header rows)
const COL_DATE     = 0;
const COL_START    = 1;
const COL_ACCOUNT  = 4;   // Zoho contact ID
const COL_COMMENTS = 7;
const COL_REP_CODE = 18;  // e.g. CW, EM, JA
const COL_CATEGORY = 27;  // PHONE or VISIT

/** Parse PixSell CSV buffer → array of raw row arrays, skipping first 5 header lines. */
function parseCsv(buffer) {
  return parse(buffer, {
    from_line:        6,     // skip 5 PixSell report header rows (1-indexed)
    skip_empty_lines: true,
    relax_column_count: true,
    trim:             true,
  });
}

/**
 * Convert a PixSell date ("D/M/YYYY") + time ("H:MM" or "H:MM:SS")
 * to a JS Date in AEST (UTC+10). Returns null if unparseable.
 */
function toAEST(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  try {
    let iso;
    if (dateStr.includes('/')) {
      const parts = dateStr.split('/');
      if (parts.length !== 3) return null;
      const [d, m, y] = parts;
      iso = `${y.padStart(4,'0')}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    } else {
      iso = dateStr; // already YYYY-MM-DD
    }
    const timeParts = timeStr.split(':').slice(0, 2).join(':'); // HH:MM
    const d = new Date(`${iso}T${timeParts}:00+10:00`);
    if (isNaN(d.getTime())) return null;
    return d;
  } catch {
    return null;
  }
}

/** Load lookup maps from DB for a single import pass. */
async function loadLookups() {
  const [storeRows, repRows] = await Promise.all([
    db.query('SELECT id, zoho_contact_id FROM stores WHERE active = TRUE'),
    db.query('SELECT id, rep_code FROM users WHERE active = TRUE AND rep_code IS NOT NULL'),
  ]);
  const storeByZohoId = {};
  for (const s of storeRows.rows) storeByZohoId[s.zoho_contact_id] = s.id;
  const repByCode = {};
  for (const u of repRows.rows) repByCode[u.rep_code.toUpperCase()] = u.id;
  return { storeByZohoId, repByCode };
}

/**
 * Validate and map one CSV row to an import record.
 * Returns { record } on success or { skip, reason } on failure.
 */
function mapRow(row, storeByZohoId, repByCode) {
  const account  = (row[COL_ACCOUNT]  || '').trim();
  const repCode  = (row[COL_REP_CODE] || '').trim().toUpperCase();
  const dateStr  = (row[COL_DATE]     || '').trim();
  const startStr = (row[COL_START]    || '').trim();
  const comments = (row[COL_COMMENTS] || '').trim() || null;
  const category = (row[COL_CATEGORY] || '').trim().toLowerCase();

  // Skip non-Zoho account prefixes (PP, PAC, etc.)
  if (!account.startsWith('1748')) {
    return { skip: true, reason: 'non_zoho' };
  }

  const storeId = storeByZohoId[account];
  if (!storeId) return { skip: true, reason: 'no_store_match' };

  if (!repCode) return { skip: true, reason: 'no_rep_code' };
  const repId = repByCode[repCode];
  if (!repId) return { skip: true, reason: 'no_rep_match' };

  const visitedAt = toAEST(dateStr, startStr);
  if (!visitedAt) return { skip: true, reason: 'bad_date' };

  const visitType = category === 'phone' ? 'phone' : 'visit';

  return { record: { storeId, repId, visitedAt, visitType, note: comments } };
}

// ── POST /api/visits/import/preview ──────────────────────────────────────────
// Parse the CSV and return the first 20 data rows + whole-file counts.
// No DB writes. Manager/executive only.

router.post(
  '/import/preview',
  requireRole('manager', 'executive'),
  upload.single('csv'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const { storeByZohoId, repByCode } = await loadLookups();
      const rows = parseCsv(req.file.buffer);

      let totalRows = 0, validRows = 0, nonZoho = 0, noStore = 0, noRep = 0, badDate = 0;
      const preview = [];

      for (const row of rows) {
        if (!row.length || row.every(c => !c)) continue;
        totalRows++;

        const result = mapRow(row, storeByZohoId, repByCode);
        if (result.skip) {
          if (result.reason === 'non_zoho') nonZoho++;
          else if (result.reason === 'no_store_match') noStore++;
          else if (result.reason === 'no_rep_match' || result.reason === 'no_rep_code') noRep++;
          else if (result.reason === 'bad_date') badDate++;
          continue;
        }

        validRows++;
        if (preview.length < 20) {
          const { record } = result;
          preview.push({
            date:       (row[COL_DATE]     || '').trim(),
            start:      (row[COL_START]    || '').trim(),
            account:    (row[COL_ACCOUNT]  || '').trim(),
            store_name: Object.keys(storeByZohoId).find(k => storeByZohoId[k] === record.storeId)
                          ? `(id ${record.storeId})` : '?',
            rep_code:   (row[COL_REP_CODE] || '').trim(),
            category:   (row[COL_CATEGORY] || '').trim() || 'VISIT',
            note:       (row[COL_COMMENTS] || '').trim() || '',
          });
        }
      }

      res.json({ totalRows, validRows, nonZoho, noStore, noRep, badDate, preview });
    } catch (err) {
      console.error('[import/preview]', err.message);
      res.status(500).json({ error: 'Failed to parse CSV: ' + err.message });
    }
  },
);

// ── POST /api/visits/import/run ───────────────────────────────────────────────
// Full import: parse CSV, batch-insert into visits. Manager/executive only.

router.post(
  '/import/run',
  requireRole('manager', 'executive'),
  upload.single('csv'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const { storeByZohoId, repByCode } = await loadLookups();
      const rows = parseCsv(req.file.buffer);

      const records = [];
      let skippedNonZoho = 0, skippedNoStore = 0, skippedNoRep = 0, skippedBadDate = 0;

      for (const row of rows) {
        if (!row.length || row.every(c => !c)) continue;
        const result = mapRow(row, storeByZohoId, repByCode);
        if (result.skip) {
          if (result.reason === 'non_zoho')     skippedNonZoho++;
          else if (result.reason === 'no_store_match') skippedNoStore++;
          else if (result.reason === 'no_rep_match' || result.reason === 'no_rep_code') skippedNoRep++;
          else if (result.reason === 'bad_date')  skippedBadDate++;
          continue;
        }
        records.push(result.record);
      }

      // Batch insert in chunks of 500, ON CONFLICT DO NOTHING for dedup
      const BATCH = 500;
      let imported = 0, duplicates = 0;

      for (let i = 0; i < records.length; i += BATCH) {
        const chunk = records.slice(i, i + BATCH);

        // Build multi-row VALUES clause
        const values = [];
        const params = [];
        let p = 1;
        for (const r of chunk) {
          values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
          params.push(r.repId, r.storeId, r.visitedAt.toISOString(), r.visitType, r.note);
        }

        const sql = `
          INSERT INTO visits (rep_id, store_id, visited_at, visit_type, note)
          VALUES ${values.join(', ')}
          ON CONFLICT (store_id, rep_id, visited_at) DO NOTHING`;

        const result = await db.query(sql, params);
        imported  += result.rowCount;
        duplicates += chunk.length - result.rowCount;
      }

      console.log(`[import/run] imported=${imported} dupes=${duplicates} skipped_non_zoho=${skippedNonZoho} skipped_no_store=${skippedNoStore} skipped_no_rep=${skippedNoRep}`);

      res.json({
        ok:               true,
        imported,
        duplicates,
        skipped_non_zoho: skippedNonZoho,
        skipped_no_store: skippedNoStore,
        skipped_no_rep:   skippedNoRep,
        skipped_bad_date: skippedBadDate,
      });
    } catch (err) {
      console.error('[import/run]', err.message);
      res.status(500).json({ error: 'Import failed: ' + err.message });
    }
  },
);

// ── GET /api/visits  (recent visit list) ─────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  try {
    const isManager = ['manager', 'executive'].includes(req.session.role);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    let conditions = [];
    let params = [];
    let p = 1;

    if (!isManager) {
      // Reps always see only their own visits
      conditions.push(`v.rep_id = $${p++}`);
      params.push(req.session.userId);
    } else if (req.query.rep_id) {
      conditions.push(`v.rep_id = $${p++}`);
      params.push(parseInt(req.query.rep_id));
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const { rows } = await db.query(`
      SELECT
        v.id, v.visited_at, v.note, v.rep_id, v.store_id, v.created_at,
        s.name AS store_name, s.grade,
        u.name AS rep_name
      FROM visits v
      JOIN stores s ON s.id = v.store_id
      JOIN users u ON u.id = v.rep_id
      ${where}
      ORDER BY v.visited_at DESC
      LIMIT $${p}
    `, params);

    res.json(rows);
  } catch (err) {
    console.error('Visits list error:', err.message);
    res.status(500).json({ error: 'Failed to load visits' });
  }
});

// ── GET /api/visits/analytics  (manager / executive) ─────────────────────────
// Must be declared before /:id to avoid routing conflicts.

router.get('/analytics', requireRole('manager', 'executive'), async (req, res) => {
  try {
    let conditions = ['s.active = TRUE'];
    let params = [];
    let p = 1;

    if (req.query.rep_id) {
      conditions.push(`s.rep_id = $${p++}`);
      params.push(parseInt(req.query.rep_id));
    }

    const { rows } = await db.query(`
      SELECT
        s.id,
        s.name,
        s.grade,
        s.state,
        s.channel_type,
        u.name AS rep_name,
        MAX(v.visited_at)                                         AS last_visit_at,
        EXTRACT(DAY FROM NOW() - MAX(v.visited_at))::INTEGER      AS days_since_visit,
        COUNT(v.id)::INTEGER                                      AS visit_count
      FROM stores s
      LEFT JOIN users u   ON u.id   = s.rep_id
      LEFT JOIN visits v  ON v.store_id = s.id
      WHERE ${conditions.join(' AND ')}
      GROUP BY s.id, s.name, s.grade, s.state, s.channel_type, u.name
      ORDER BY s.name ASC
    `, params);

    res.json(rows);
  } catch (err) {
    console.error('Visit analytics error:', err.message);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

// ── POST /api/visits  (log a visit) ──────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
  const { store_id, note } = req.body;
  if (!store_id) return res.status(400).json({ error: 'store_id is required' });

  try {
    const isManager = ['manager', 'executive'].includes(req.session.role);

    const { rows: storeRows } = await db.query(
      'SELECT id, name, rep_id FROM stores WHERE id = $1 AND active = TRUE',
      [store_id]
    );
    if (!storeRows[0]) return res.status(404).json({ error: 'Store not found' });

    const store = storeRows[0];
    if (!isManager && store.rep_id !== req.session.userId) {
      return res.status(403).json({ error: 'You can only log visits to your own stores' });
    }

    const { rows } = await db.query(
      `INSERT INTO visits (rep_id, store_id, visited_at, note)
       VALUES ($1, $2, NOW(), $3)
       RETURNING id, rep_id, store_id, visited_at, note, created_at`,
      [req.session.userId, store_id, note?.trim() || null]
    );

    res.json({ ...rows[0], store_name: store.name });
  } catch (err) {
    console.error('Log visit error:', err.message);
    res.status(500).json({ error: 'Failed to log visit' });
  }
});

// ── DELETE /api/visits/:id  (undo — own visits within 5 minutes) ─────────────

router.delete('/:id', requireAuth, async (req, res) => {
  const visitId = parseInt(req.params.id);
  if (isNaN(visitId)) return res.status(400).json({ error: 'Invalid visit id' });

  try {
    const { rows } = await db.query(
      'SELECT id, rep_id, created_at FROM visits WHERE id = $1',
      [visitId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Visit not found' });

    const visit = rows[0];
    if (visit.rep_id !== req.session.userId) {
      return res.status(403).json({ error: 'You can only undo your own visits' });
    }

    const ageMs = Date.now() - new Date(visit.created_at).getTime();
    if (ageMs > 5 * 60 * 1000) {
      return res.status(400).json({ error: 'Undo window has expired (5 minutes)' });
    }

    await db.query('DELETE FROM visits WHERE id = $1', [visitId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Undo visit error:', err.message);
    res.status(500).json({ error: 'Failed to undo visit' });
  }
});

module.exports = router;
