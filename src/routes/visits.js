'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const db = require('../db');

const router = express.Router();

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
