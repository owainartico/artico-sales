'use strict';

/**
 * Call Planner routes.
 *
 * GET  /api/planner/week?week=YYYY-MM-DD[&rep_id=N]  – get plan for a week
 * POST /api/planner/generate                          – auto-generate plan
 * GET  /api/planner/overdue-stores?q=&rep_id=         – store search for manual add
 * POST /api/planner/items                             – add store manually
 * PATCH /api/planner/items/:id                        – update item (day/position/status/time)
 * DELETE /api/planner/items/:id                       – remove item
 * POST /api/planner/submit                            – submit week (sets weekly_plans flag)
 * GET  /api/planner/team?week=YYYY-MM-DD              – manager: all reps summary
 */

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const db = require('../db');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the ISO Monday of the week containing the given date string YYYY-MM-DD */
function isoMonday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function currentWeek() {
  return isoMonday(new Date().toISOString().slice(0, 10));
}

// ── GET /api/planner/week ─────────────────────────────────────────────────────

router.get('/week', requireAuth, async (req, res) => {
  try {
    const isManager = ['manager', 'executive'].includes(req.session.role);
    const week = req.query.week ? isoMonday(req.query.week) : currentWeek();
    const repId = isManager && req.query.rep_id
      ? parseInt(req.query.rep_id)
      : req.session.userId;

    const { rows: items } = await db.query(`
      SELECT
        cpi.id, cpi.store_id, cpi.day_of_week, cpi.position,
        cpi.status, cpi.confirmed_time, cpi.notes,
        s.name AS store_name, s.grade, s.is_prospect, s.state, s.postcode, s.channel_type,
        (SELECT MAX(v.visited_at) FROM visits v WHERE v.store_id = cpi.store_id) AS last_visit,
        GREATEST(0,
          EXTRACT(DAY FROM (NOW() - COALESCE(
            (SELECT MAX(v2.visited_at) FROM visits v2 WHERE v2.store_id = cpi.store_id),
            NOW() - INTERVAL '1 year'
          )))
        )::INTEGER AS days_since_visit
      FROM call_plan_items cpi
      JOIN stores s ON s.id = cpi.store_id
      WHERE cpi.rep_id = $1 AND cpi.planned_week = $2
      ORDER BY cpi.day_of_week, cpi.position
    `, [repId, week]);

    const { rows: [planRow] } = await db.query(
      `SELECT 1 FROM weekly_plans WHERE rep_id = $1 AND week_start = $2`,
      [repId, week]
    );

    const days = { 1: [], 2: [], 3: [], 4: [], 5: [] };
    for (const item of items) {
      (days[item.day_of_week] = days[item.day_of_week] || []).push(item);
    }

    res.json({ week, rep_id: repId, submitted: !!planRow, days });
  } catch (err) {
    console.error('[planner] week error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/planner/generate ────────────────────────────────────────────────

router.post('/generate', requireAuth, async (req, res) => {
  try {
    const isManager = ['manager', 'executive'].includes(req.session.role);
    const week  = req.body.week ? isoMonday(req.body.week) : currentWeek();
    const repId = isManager && req.body.rep_id ? parseInt(req.body.rep_id) : req.session.userId;

    // Find overdue stores sorted by grade priority then geography (state + postcode)
    const { rows: overdue } = await db.query(`
      SELECT
        s.id AS store_id, s.name, s.grade, s.state, s.postcode,
        GREATEST(0,
          EXTRACT(DAY FROM (NOW() - COALESCE(
            (SELECT MAX(v.visited_at) FROM visits v WHERE v.store_id = s.id),
            NOW() - INTERVAL '1 year'
          )))
        )::INTEGER AS days_since_visit
      FROM stores s
      WHERE
        s.rep_id = $1
        AND s.active = TRUE
        AND s.is_prospect = FALSE
        AND s.grade IN ('A', 'B', 'C')
        AND (
          (s.grade = 'A' AND COALESCE(
            (SELECT MAX(v2.visited_at) FROM visits v2 WHERE v2.store_id = s.id),
            NOW() - INTERVAL '100 years'
          ) < NOW() - INTERVAL '6 weeks')
          OR
          (s.grade IN ('B', 'C') AND COALESCE(
            (SELECT MAX(v3.visited_at) FROM visits v3 WHERE v3.store_id = s.id),
            NOW() - INTERVAL '100 years'
          ) < NOW() - INTERVAL '12 weeks')
        )
      ORDER BY
        CASE s.grade WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END,
        s.state NULLS LAST,
        s.postcode NULLS LAST,
        days_since_visit DESC NULLS LAST
    `, [repId]);

    // Delete existing SUGGESTED items for this rep/week (keep confirmed/completed/skipped)
    await db.query(
      `DELETE FROM call_plan_items WHERE rep_id = $1 AND planned_week = $2 AND status = 'suggested'`,
      [repId, week]
    );

    if (overdue.length === 0) {
      return res.json({ ok: true, generated: 0, overdue_total: 0, message: 'No overdue stores found' });
    }

    // Find stores already in the plan (confirmed/completed/skipped) so we don't re-add them
    const { rows: existing } = await db.query(
      `SELECT store_id FROM call_plan_items WHERE rep_id = $1 AND planned_week = $2`,
      [repId, week]
    );
    const existingStoreIds = new Set(existing.map(r => r.store_id));

    const newItems = overdue.filter(s => !existingStoreIds.has(s.store_id));
    const MAX_PER_DAY = 8;
    const itemsToInsert = newItems.slice(0, MAX_PER_DAY * 5);

    if (itemsToInsert.length === 0) {
      return res.json({ ok: true, generated: 0, overdue_total: overdue.length, message: 'All overdue stores already in plan' });
    }

    // Spread evenly across 5 days (Mon–Fri)
    const perDay = Math.ceil(itemsToInsert.length / 5);
    for (let i = 0; i < itemsToInsert.length; i++) {
      const dayOfWeek = Math.min(5, Math.floor(i / perDay) + 1);
      const position  = (i % perDay) + 1;
      const item = itemsToInsert[i];
      await db.query(`
        INSERT INTO call_plan_items (rep_id, store_id, planned_week, day_of_week, position, status)
        VALUES ($1, $2, $3, $4, $5, 'suggested')
        ON CONFLICT (rep_id, store_id, planned_week) DO NOTHING
      `, [repId, item.store_id, week, dayOfWeek, position]);
    }

    res.json({ ok: true, generated: itemsToInsert.length, overdue_total: overdue.length });
  } catch (err) {
    console.error('[planner] generate error:', err.message);
    res.status(500).json({ error: 'Failed to generate plan' });
  }
});

// ── GET /api/planner/overdue-stores ──────────────────────────────────────────
// Store search for manual add

router.get('/overdue-stores', requireAuth, async (req, res) => {
  try {
    const isManager = ['manager', 'executive'].includes(req.session.role);
    const repId = isManager && req.query.rep_id ? parseInt(req.query.rep_id) : req.session.userId;
    const q = (req.query.q || '').toLowerCase().trim();

    const { rows } = await db.query(`
      SELECT
        s.id, s.name, s.grade, s.state, s.postcode,
        GREATEST(0,
          EXTRACT(DAY FROM (NOW() - COALESCE(
            (SELECT MAX(v.visited_at) FROM visits v WHERE v.store_id = s.id),
            NOW() - INTERVAL '1 year'
          )))
        )::INTEGER AS days_since_visit
      FROM stores s
      WHERE s.rep_id = $1 AND s.active = TRUE AND s.is_prospect = FALSE
        AND ($2 = '' OR LOWER(s.name) LIKE '%' || $2 || '%')
      ORDER BY s.grade, s.name
      LIMIT 50
    `, [repId, q]);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to search stores' });
  }
});

// ── POST /api/planner/items ───────────────────────────────────────────────────

router.post('/items', requireAuth, async (req, res) => {
  try {
    const isManager = ['manager', 'executive'].includes(req.session.role);
    const { store_id, day_of_week, notes } = req.body;
    const repId = isManager && req.body.rep_id ? parseInt(req.body.rep_id) : req.session.userId;
    const week  = req.body.planned_week ? isoMonday(req.body.planned_week) : currentWeek();

    if (!store_id || !day_of_week) {
      return res.status(400).json({ error: 'store_id and day_of_week are required' });
    }

    // Non-managers can only add stores from their own territory
    if (!isManager) {
      const { rows } = await db.query(
        `SELECT 1 FROM stores WHERE id = $1 AND rep_id = $2`,
        [store_id, repId]
      );
      if (!rows.length) return res.status(403).json({ error: 'Store not in your territory' });
    }

    const { rows: [posRow] } = await db.query(`
      SELECT COALESCE(MAX(position), 0) + 1 AS next_pos
      FROM call_plan_items
      WHERE rep_id = $1 AND planned_week = $2 AND day_of_week = $3
    `, [repId, week, day_of_week]);

    const { rows: [item] } = await db.query(`
      INSERT INTO call_plan_items (rep_id, store_id, planned_week, day_of_week, position, status, notes)
      VALUES ($1, $2, $3, $4, $5, 'suggested', $6)
      ON CONFLICT (rep_id, store_id, planned_week) DO UPDATE SET
        day_of_week = EXCLUDED.day_of_week,
        position    = EXCLUDED.position,
        notes       = EXCLUDED.notes
      RETURNING id
    `, [repId, store_id, week, day_of_week, posRow.next_pos, notes || null]);

    res.json({ ok: true, id: item.id });
  } catch (err) {
    console.error('[planner] add item error:', err.message);
    res.status(500).json({ error: 'Failed to add store to plan' });
  }
});

// ── PATCH /api/planner/items/:id ─────────────────────────────────────────────

router.patch('/items/:id', requireAuth, async (req, res) => {
  try {
    const itemId = parseInt(req.params.id);
    const isManager = ['manager', 'executive'].includes(req.session.role);

    const { rows: [item] } = await db.query(
      `SELECT * FROM call_plan_items WHERE id = $1`, [itemId]
    );
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (!isManager && item.rep_id !== req.session.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { day_of_week, position, status, confirmed_time, notes } = req.body;

    // If moving to a different day, auto-assign to end of that day
    let newPosition = position ?? null;
    if (day_of_week !== undefined && day_of_week !== item.day_of_week && position === undefined) {
      const { rows: [posRow] } = await db.query(`
        SELECT COALESCE(MAX(position), 0) + 1 AS next_pos
        FROM call_plan_items
        WHERE rep_id = $1 AND planned_week = $2 AND day_of_week = $3 AND id != $4
      `, [item.rep_id, item.planned_week, day_of_week, itemId]);
      newPosition = posRow.next_pos;
    }

    const { rows: [updated] } = await db.query(`
      UPDATE call_plan_items SET
        day_of_week    = COALESCE($2, day_of_week),
        position       = COALESCE($3, position),
        status         = COALESCE($4, status),
        confirmed_time = CASE WHEN $5::TEXT IS NOT NULL THEN $5 ELSE confirmed_time END,
        notes          = CASE WHEN $6::TEXT IS NOT NULL THEN $6 ELSE notes END
      WHERE id = $1
      RETURNING *
    `, [itemId, day_of_week ?? null, newPosition, status ?? null,
        confirmed_time !== undefined ? (confirmed_time || null) : null,
        notes !== undefined ? (notes || null) : null]);

    res.json({ ok: true, item: updated });
  } catch (err) {
    console.error('[planner] update item error:', err.message);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// ── DELETE /api/planner/items/:id ─────────────────────────────────────────────

router.delete('/items/:id', requireAuth, async (req, res) => {
  try {
    const itemId = parseInt(req.params.id);
    const isManager = ['manager', 'executive'].includes(req.session.role);

    const { rows: [item] } = await db.query(
      `SELECT rep_id FROM call_plan_items WHERE id = $1`, [itemId]
    );
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (!isManager && item.rep_id !== req.session.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await db.query(`DELETE FROM call_plan_items WHERE id = $1`, [itemId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[planner] delete item error:', err.message);
    res.status(500).json({ error: 'Failed to remove item' });
  }
});

// ── POST /api/planner/submit ──────────────────────────────────────────────────

router.post('/submit', requireAuth, async (req, res) => {
  try {
    const isManager = ['manager', 'executive'].includes(req.session.role);
    const week  = req.body.week ? isoMonday(req.body.week) : currentWeek();
    const repId = isManager && req.body.rep_id ? parseInt(req.body.rep_id) : req.session.userId;

    await db.query(`
      INSERT INTO weekly_plans (rep_id, week_start)
      VALUES ($1, $2)
      ON CONFLICT (rep_id, week_start) DO NOTHING
    `, [repId, week]);

    res.json({ ok: true, week, submitted: true });
  } catch (err) {
    console.error('[planner] submit error:', err.message);
    res.status(500).json({ error: 'Failed to submit plan' });
  }
});

// ── GET /api/planner/team ─────────────────────────────────────────────────────

router.get('/team', requireAuth, requireRole('manager', 'executive'), async (req, res) => {
  try {
    const week = req.query.week ? isoMonday(req.query.week) : currentWeek();

    const { rows: reps } = await db.query(`
      SELECT id, name FROM users
      WHERE active = TRUE AND role = 'rep'
      ORDER BY name
    `);

    const result = await Promise.all(reps.map(async (rep) => {
      const [{ rows: [summary] }, { rows: [planRow] }] = await Promise.all([
        db.query(`
          SELECT
            COUNT(*)::INTEGER AS total,
            COUNT(*) FILTER (WHERE status = 'confirmed')::INTEGER  AS confirmed,
            COUNT(*) FILTER (WHERE status = 'completed')::INTEGER  AS completed,
            COUNT(*) FILTER (WHERE status = 'suggested')::INTEGER  AS suggested,
            COUNT(*) FILTER (WHERE status = 'skipped')::INTEGER    AS skipped
          FROM call_plan_items
          WHERE rep_id = $1 AND planned_week = $2
        `, [rep.id, week]),
        db.query(
          `SELECT 1 FROM weekly_plans WHERE rep_id = $1 AND week_start = $2`,
          [rep.id, week]
        ),
      ]);

      return {
        rep_id:    rep.id,
        rep_name:  rep.name,
        submitted: !!planRow,
        total:     summary?.total || 0,
        confirmed: summary?.confirmed || 0,
        completed: summary?.completed || 0,
        suggested: summary?.suggested || 0,
        skipped:   summary?.skipped || 0,
      };
    }));

    res.json({ week, reps: result });
  } catch (err) {
    console.error('[planner] team error:', err.message);
    res.status(500).json({ error: 'Failed to load team plans' });
  }
});

module.exports = router;
