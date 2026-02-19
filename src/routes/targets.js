const express = require('express');
const pool    = require('../db/index');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const isManager = requireRole('manager', 'executive');

/** Validate YYYY-MM month string */
function validMonth(m) {
  return typeof m === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(m);
}

// ── GET /api/targets/rep — all rep targets (manager/exec) ─────────────────────
router.get('/rep', isManager, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT rt.id, rt.rep_id, rt.month, rt.amount,
              u.name AS rep_name, s.name AS set_by_name,
              rt.created_at, rt.updated_at
       FROM revenue_targets rt
       JOIN users u ON u.id = rt.rep_id
       LEFT JOIN users s ON s.id = rt.set_by
       ORDER BY rt.rep_id, rt.month`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List targets error:', err);
    res.status(500).json({ error: 'Failed to list targets' });
  }
});

// ── GET /api/targets/rep/:repId — targets for one rep ─────────────────────────
router.get('/rep/:repId', requireAuth, async (req, res) => {
  const { repId } = req.params;

  // Reps can only see their own targets
  if (req.session.role === 'rep' && req.session.userId !== parseInt(repId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const result = await pool.query(
      `SELECT rt.id, rt.rep_id, rt.month, rt.amount, rt.created_at, rt.updated_at
       FROM revenue_targets rt
       WHERE rt.rep_id = $1
       ORDER BY rt.month`,
      [repId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get rep targets error:', err);
    res.status(500).json({ error: 'Failed to get targets' });
  }
});

// ── POST /api/targets/rep — set a rep target ─────────────────────────────────
router.post('/rep', isManager, async (req, res) => {
  const { rep_id, month, amount } = req.body;

  if (!rep_id || !month || amount === undefined) {
    return res.status(400).json({ error: 'rep_id, month, and amount are required' });
  }
  if (!validMonth(month)) {
    return res.status(400).json({ error: 'month must be in YYYY-MM format' });
  }
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt < 0) {
    return res.status(400).json({ error: 'amount must be a non-negative number' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get current value for audit log
    const current = await client.query(
      'SELECT id, amount FROM revenue_targets WHERE rep_id = $1 AND month = $2',
      [rep_id, month]
    );
    const old = current.rows[0];

    // Upsert target
    const upsert = await client.query(
      `INSERT INTO revenue_targets (rep_id, month, amount, set_by, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (rep_id, month) DO UPDATE
         SET amount = EXCLUDED.amount,
             set_by = EXCLUDED.set_by,
             updated_at = NOW()
       RETURNING *`,
      [rep_id, month, amt, req.session.userId]
    );

    // Write audit log
    await client.query(
      `INSERT INTO target_audit_log (target_id, target_type, changed_by, old_value, new_value)
       VALUES ($1, 'rep', $2, $3, $4)`,
      [upsert.rows[0].id, req.session.userId, old?.amount ?? null, amt]
    );

    await client.query('COMMIT');
    res.json(upsert.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Set rep target error:', err);
    res.status(500).json({ error: 'Failed to set target' });
  } finally {
    client.release();
  }
});

// ── POST /api/targets/brand — set a brand target ──────────────────────────────
router.post('/brand', isManager, async (req, res) => {
  const { brand_slug, month, amount } = req.body;

  if (!brand_slug || !month || amount === undefined) {
    return res.status(400).json({ error: 'brand_slug, month, and amount are required' });
  }
  if (!validMonth(month)) {
    return res.status(400).json({ error: 'month must be in YYYY-MM format' });
  }
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt < 0) {
    return res.status(400).json({ error: 'amount must be a non-negative number' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query(
      'SELECT id, amount FROM brand_targets WHERE brand_slug = $1 AND month = $2',
      [brand_slug, month]
    );
    const old = current.rows[0];

    const upsert = await client.query(
      `INSERT INTO brand_targets (brand_slug, month, amount, set_by, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (brand_slug, month) DO UPDATE
         SET amount = EXCLUDED.amount,
             set_by = EXCLUDED.set_by,
             updated_at = NOW()
       RETURNING *`,
      [brand_slug, month, amt, req.session.userId]
    );

    await client.query(
      `INSERT INTO target_audit_log (target_id, target_type, changed_by, old_value, new_value)
       VALUES ($1, 'brand', $2, $3, $4)`,
      [upsert.rows[0].id, req.session.userId, old?.amount ?? null, amt]
    );

    await client.query('COMMIT');
    res.json(upsert.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Set brand target error:', err);
    res.status(500).json({ error: 'Failed to set brand target' });
  } finally {
    client.release();
  }
});

// ── GET /api/targets/brand — all brand targets ────────────────────────────────
router.get('/brand', isManager, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT bt.*, u.name AS set_by_name
       FROM brand_targets bt
       LEFT JOIN users u ON u.id = bt.set_by
       ORDER BY bt.brand_slug, bt.month`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List brand targets error:', err);
    res.status(500).json({ error: 'Failed to list brand targets' });
  }
});

module.exports = router;
