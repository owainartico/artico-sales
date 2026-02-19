'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const db = require('../db');
const { runAlertEngine } = require('../services/alertEngine');

const router = express.Router();

// ── GET /api/alerts ───────────────────────────────────────────────────────────
// Returns unacknowledged alerts.
//  - Reps: their own alerts only (where rep_id = userId)
//  - Managers/execs: all unacknowledged alerts, optionally filtered by rep_id
//
// Query params: ?rep_id=&tier=&limit= (all optional)

router.get('/', requireAuth, async (req, res) => {
  try {
    const isManager = ['manager', 'executive'].includes(req.session.role);
    const { rep_id, tier } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    let conditions = ['a.acknowledged_at IS NULL'];
    let params = [];
    let p = 1;

    if (!isManager) {
      // Reps see alerts assigned to them
      conditions.push(`a.rep_id = $${p++}`);
      params.push(req.session.userId);
    } else if (rep_id) {
      conditions.push(`a.rep_id = $${p++}`);
      params.push(parseInt(rep_id));
    }

    if (tier) {
      conditions.push(`a.tier = $${p++}`);
      params.push(parseInt(tier));
    }

    params.push(limit);

    const { rows } = await db.query(`
      SELECT
        a.id,
        a.alert_type,
        a.tier,
        a.alert_title,
        a.alert_detail,
        a.store_id,
        a.rep_id,
        a.triggered_at,
        a.revenue_at_risk,
        a.estimated_uplift,
        s.name AS store_name,
        s.grade AS store_grade,
        u.name AS rep_name
      FROM alert_log a
      LEFT JOIN stores s ON s.id = a.store_id
      LEFT JOIN users  u ON u.id = a.rep_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY a.tier ASC, a.triggered_at DESC
      LIMIT $${p}
    `, params);

    res.json(rows);
  } catch (err) {
    console.error('Alerts list error:', err.message);
    res.status(500).json({ error: 'Failed to load alerts' });
  }
});

// ── POST /api/alerts/run ──────────────────────────────────────────────────────
// Trigger an on-demand alert engine run (manager / executive only).

router.post('/run', requireRole('manager', 'executive'), async (req, res) => {
  try {
    const result = await runAlertEngine();
    res.json(result);
  } catch (err) {
    console.error('Alert engine run error:', err.message);
    res.status(500).json({ error: 'Alert engine failed', detail: err.message });
  }
});

// ── POST /api/alerts/:id/acknowledge ─────────────────────────────────────────
// Acknowledge an alert. Reps can only ack their own; managers can ack any.

router.post('/:id/acknowledge', requireAuth, async (req, res) => {
  const alertId = parseInt(req.params.id);
  if (isNaN(alertId)) return res.status(400).json({ error: 'Invalid alert id' });

  try {
    const isManager = ['manager', 'executive'].includes(req.session.role);

    // Verify the alert exists and the user has permission
    const { rows } = await db.query(
      `SELECT id, rep_id FROM alert_log WHERE id = $1 AND acknowledged_at IS NULL`,
      [alertId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Alert not found or already acknowledged' });

    const alert = rows[0];
    if (!isManager && alert.rep_id !== req.session.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await db.query(`
      UPDATE alert_log
      SET acknowledged_at = NOW(), acknowledged_by = $2
      WHERE id = $1
    `, [alertId, req.session.userId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Acknowledge alert error:', err.message);
    res.status(500).json({ error: 'Failed to acknowledge alert' });
  }
});

module.exports = router;
