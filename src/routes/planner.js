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

function currentQuarter() {
  const now = new Date();
  return { quarter: Math.ceil((now.getMonth() + 1) / 3), year: now.getFullYear() };
}

/** Returns array of ISO Monday strings for every week whose Monday falls in the given quarter */
function quarterWeeks(quarter, year) {
  const monthStart = (quarter - 1) * 3;
  const qEnd = new Date(Date.UTC(year, monthStart + 3, 0));
  let d = new Date(Date.UTC(year, monthStart, 1));
  const dow = d.getUTCDay();
  if (dow !== 1) d.setUTCDate(d.getUTCDate() + (dow === 0 ? 1 : 8 - dow));
  const weeks = [];
  while (d <= qEnd) {
    weeks.push(d.toISOString().slice(0, 10));
    d = new Date(d); d.setUTCDate(d.getUTCDate() + 7);
  }
  return weeks;
}

function fmtWeekLabel(w) {
  const mon = new Date(w + 'T00:00:00Z');
  const fri = new Date(w + 'T00:00:00Z');
  fri.setUTCDate(fri.getUTCDate() + 4);
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${mon.getUTCDate()} ${M[mon.getUTCMonth()]} – ${fri.getUTCDate()} ${M[fri.getUTCMonth()]}`;
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

// ── GET /api/planner/quarter ──────────────────────────────────────────────────
// Returns per-week summary counts for all weeks in a quarter.

router.get('/quarter', requireAuth, async (req, res) => {
  try {
    const isManager = ['manager', 'executive'].includes(req.session.role);
    const cq   = currentQuarter();
    const q    = req.query.quarter ? parseInt(req.query.quarter) : cq.quarter;
    const yr   = req.query.year    ? parseInt(req.query.year)    : cq.year;
    const repId = isManager && req.query.rep_id
      ? parseInt(req.query.rep_id)
      : req.session.userId;

    const weeks = quarterWeeks(q, yr);

    // Counts for all weeks in one query
    const { rows: counts } = await db.query(`
      SELECT
        planned_week,
        COUNT(*)::INTEGER                                          AS total,
        COUNT(*) FILTER (WHERE status = 'confirmed')::INTEGER     AS confirmed,
        COUNT(*) FILTER (WHERE status = 'suggested')::INTEGER     AS suggested,
        COUNT(*) FILTER (WHERE status = 'completed')::INTEGER     AS completed,
        COUNT(*) FILTER (WHERE status = 'skipped')::INTEGER       AS skipped
      FROM call_plan_items
      WHERE rep_id = $1 AND planned_week >= $2 AND planned_week <= $3
      GROUP BY planned_week
    `, [repId, weeks[0], weeks[weeks.length - 1]]);

    const { rows: submitted } = await db.query(`
      SELECT week_start FROM weekly_plans
      WHERE rep_id = $1 AND week_start >= $2 AND week_start <= $3
    `, [repId, weeks[0], weeks[weeks.length - 1]]);

    const submittedSet = new Set(submitted.map(r =>
      r.week_start instanceof Date ? r.week_start.toISOString().slice(0, 10) : String(r.week_start).slice(0, 10)
    ));
    const countMap = new Map(counts.map(c => [
      c.planned_week instanceof Date ? c.planned_week.toISOString().slice(0, 10) : String(c.planned_week).slice(0, 10),
      c
    ]));

    const result = weeks.map(w => {
      const c = countMap.get(w) || { total: 0, confirmed: 0, suggested: 0, completed: 0, skipped: 0 };
      return {
        week:      w,
        label:     fmtWeekLabel(w),
        submitted: submittedSet.has(w),
        total:     c.total,
        confirmed: c.confirmed,
        suggested: c.suggested,
        completed: c.completed,
        skipped:   c.skipped,
      };
    });

    res.json({ quarter: q, year: yr, rep_id: repId, weeks: result });
  } catch (err) {
    console.error('[planner] quarter error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Shared: cluster stores geographically and assign to 5 days ────────────────

function clusterIntoDays(stores) {
  const MAX_PER_DAY = 8;
  const clusterMap  = new Map();
  for (const s of stores) {
    const key = `${s.state || 'ZZZ'}::${(s.postcode || '').slice(0, 3)}`;
    if (!clusterMap.has(key)) clusterMap.set(key, []);
    clusterMap.get(key).push(s);
  }
  const sortedClusters = [...clusterMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, cs]) => {
      cs.sort((a, b) => {
        const pa = (a.postcode || ''), pb = (b.postcode || '');
        if (pa !== pb) return pa.localeCompare(pb);
        const ga = a.grade === 'A' ? 0 : a.grade === 'B' ? 1 : 2;
        const gb = b.grade === 'A' ? 0 : b.grade === 'B' ? 1 : 2;
        return ga - gb;
      });
      return cs;
    });

  const dayBuckets = [[], [], [], [], []];
  let dayIdx = 0;
  outer: for (const cluster of sortedClusters) {
    for (const s of cluster) {
      if (dayBuckets[dayIdx].length >= MAX_PER_DAY) {
        if (++dayIdx >= 5) break outer;
      }
      dayBuckets[dayIdx].push(s);
    }
  }
  // Within each day sort by full postcode ascending
  for (const bucket of dayBuckets) {
    bucket.sort((a, b) => (a.postcode || '').localeCompare(b.postcode || ''));
  }
  return dayBuckets;
}

// ── POST /api/planner/generate ────────────────────────────────────────────────

router.post('/generate', requireAuth, async (req, res) => {
  try {
    const isManager = ['manager', 'executive'].includes(req.session.role);
    const repId = isManager && req.body.rep_id ? parseInt(req.body.rep_id) : req.session.userId;
    const scope = req.body.scope || 'week';

    // ── Quarter-wide generate ────────────────────────────────────────────────
    if (scope === 'quarter') {
      const cq     = currentQuarter();
      const q      = req.body.quarter ? parseInt(req.body.quarter) : cq.quarter;
      const yr     = req.body.year    ? parseInt(req.body.year)    : cq.year;
      const weeks  = quarterWeeks(q, yr);

      const qStartMs = new Date(weeks[0] + 'T00:00:00Z').getTime();
      const qEndMs   = new Date(weeks[weeks.length - 1] + 'T23:59:59Z').getTime();

      // Delete all suggested items for this rep in these weeks
      await db.query(
        `DELETE FROM call_plan_items WHERE rep_id = $1 AND planned_week >= $2 AND planned_week <= $3 AND status = 'suggested'`,
        [repId, weeks[0], weeks[weeks.length - 1]]
      );

      // All active graded stores with last visit date
      const { rows: stores } = await db.query(`
        SELECT
          s.id AS store_id, s.name, s.grade, s.state, s.postcode,
          (SELECT MAX(v.visited_at) FROM visits v WHERE v.store_id = s.id) AS last_visit
        FROM stores s
        WHERE s.rep_id = $1 AND s.active = TRUE AND s.is_prospect = FALSE AND s.grade IN ('A','B','C')
      `, [repId]);

      if (stores.length === 0) {
        return res.json({ ok: true, generated: 0, weeks_planned: 0, message: 'No graded stores found' });
      }

      // Committed items (non-suggested) that we must not overwrite
      const { rows: committed } = await db.query(`
        SELECT store_id, planned_week FROM call_plan_items
        WHERE rep_id = $1 AND planned_week >= $2 AND planned_week <= $3 AND status != 'suggested'
      `, [repId, weeks[0], weeks[weeks.length - 1]]);
      const committedSet = new Set(committed.map(c => `${c.store_id}:${String(c.planned_week).slice(0,10)}`));

      const INTERVAL_A  = 42 * 86400000; // 6 weeks ms
      const INTERVAL_BC = 84 * 86400000; // 12 weeks ms

      // Build week buckets
      const weekBuckets = new Map();
      for (const w of weeks) weekBuckets.set(w, []);

      for (const store of stores) {
        const interval  = store.grade === 'A' ? INTERVAL_A : INTERVAL_BC;
        const lastVisitMs = store.last_visit ? new Date(store.last_visit).getTime() : null;

        // First visit: next due date clamped to quarter start
        const firstDueMs = lastVisitMs
          ? Math.max(qStartMs, lastVisitMs + interval)
          : qStartMs;

        const visitDueDates = [];
        if (firstDueMs <= qEndMs) visitDueDates.push(firstDueMs);

        // A stores get a second visit 6 weeks after the first
        if (store.grade === 'A' && visitDueDates.length > 0) {
          const secondDueMs = visitDueDates[0] + INTERVAL_A;
          if (secondDueMs <= qEndMs) visitDueDates.push(secondDueMs);
        }

        for (const dueMs of visitDueDates) {
          // Find first quarter week on or after the due date
          let targetWeek = null;
          for (const w of weeks) {
            if (new Date(w + 'T00:00:00Z').getTime() >= dueMs) { targetWeek = w; break; }
          }
          if (!targetWeek) continue;
          if (committedSet.has(`${store.store_id}:${targetWeek}`)) continue;
          const bucket = weekBuckets.get(targetWeek);
          if (bucket.some(s => s.store_id === store.store_id)) continue;
          bucket.push({ ...store });
        }
      }

      // Insert each week's stores with geographic clustering
      let totalInserted = 0, weeksPlanned = 0;
      for (const [week, wStores] of weekBuckets) {
        if (wStores.length === 0) continue;
        const dayBuckets = clusterIntoDays(wStores);
        for (let d = 0; d < 5; d++) {
          for (let pos = 0; pos < dayBuckets[d].length; pos++) {
            await db.query(`
              INSERT INTO call_plan_items (rep_id, store_id, planned_week, day_of_week, position, status)
              VALUES ($1, $2, $3, $4, $5, 'suggested')
              ON CONFLICT (rep_id, store_id, planned_week) DO NOTHING
            `, [repId, dayBuckets[d][pos].store_id, week, d + 1, pos + 1]);
            totalInserted++;
          }
        }
        if (dayBuckets.some(b => b.length > 0)) weeksPlanned++;
      }

      return res.json({ ok: true, generated: totalInserted, weeks_planned: weeksPlanned });
    }

    // ── Single-week generate (default) ──────────────────────────────────────
    const week  = req.body.week ? isoMonday(req.body.week) : currentWeek();

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
        s.rep_id = $1 AND s.active = TRUE AND s.is_prospect = FALSE AND s.grade IN ('A','B','C')
        AND (
          (s.grade = 'A' AND COALESCE(
            (SELECT MAX(v2.visited_at) FROM visits v2 WHERE v2.store_id = s.id),
            NOW() - INTERVAL '100 years'
          ) < NOW() - INTERVAL '6 weeks')
          OR
          (s.grade IN ('B','C') AND COALESCE(
            (SELECT MAX(v3.visited_at) FROM visits v3 WHERE v3.store_id = s.id),
            NOW() - INTERVAL '100 years'
          ) < NOW() - INTERVAL '12 weeks')
        )
    `, [repId]);

    await db.query(
      `DELETE FROM call_plan_items WHERE rep_id = $1 AND planned_week = $2 AND status = 'suggested'`,
      [repId, week]
    );

    if (overdue.length === 0) {
      return res.json({ ok: true, generated: 0, overdue_total: 0, message: 'No overdue stores found' });
    }

    const { rows: existing } = await db.query(
      `SELECT store_id FROM call_plan_items WHERE rep_id = $1 AND planned_week = $2`,
      [repId, week]
    );
    const existingIds = new Set(existing.map(r => r.store_id));
    const itemsToInsert = overdue.filter(s => !existingIds.has(s.store_id)).slice(0, 40);

    if (itemsToInsert.length === 0) {
      return res.json({ ok: true, generated: 0, overdue_total: overdue.length, message: 'All overdue stores already in plan' });
    }

    const dayBuckets = clusterIntoDays(itemsToInsert);
    let inserted = 0;
    for (let d = 0; d < 5; d++) {
      for (let pos = 0; pos < dayBuckets[d].length; pos++) {
        await db.query(`
          INSERT INTO call_plan_items (rep_id, store_id, planned_week, day_of_week, position, status)
          VALUES ($1, $2, $3, $4, $5, 'suggested')
          ON CONFLICT (rep_id, store_id, planned_week) DO NOTHING
        `, [repId, dayBuckets[d][pos].store_id, week, d + 1, pos + 1]);
        inserted++;
      }
    }

    res.json({ ok: true, generated: inserted, overdue_total: overdue.length });
  } catch (err) {
    console.error('[planner] generate error:', err.message);
    res.status(500).json({ error: err.message });
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

    const { day_of_week, planned_week, position, status, confirmed_time, notes } = req.body;
    const targetWeek = planned_week ? isoMonday(planned_week) : null;

    // If moving to a different week, check for conflict (UNIQUE rep+store+week)
    if (targetWeek && targetWeek !== String(item.planned_week).slice(0, 10)) {
      const { rows: conflict } = await db.query(
        `SELECT id FROM call_plan_items WHERE rep_id = $1 AND store_id = $2 AND planned_week = $3 AND id != $4`,
        [item.rep_id, item.store_id, targetWeek, itemId]
      );
      if (conflict.length > 0) {
        return res.status(409).json({ error: 'Store is already planned for that week' });
      }
    }

    // Auto-assign position when moving to a different day or week
    const effectiveWeek = targetWeek ?? String(item.planned_week).slice(0, 10);
    const effectiveDay  = day_of_week ?? item.day_of_week;
    let newPosition = position ?? null;
    if (position === undefined && (effectiveDay !== item.day_of_week || effectiveWeek !== String(item.planned_week).slice(0, 10))) {
      const { rows: [posRow] } = await db.query(`
        SELECT COALESCE(MAX(position), 0) + 1 AS next_pos
        FROM call_plan_items
        WHERE rep_id = $1 AND planned_week = $2 AND day_of_week = $3 AND id != $4
      `, [item.rep_id, effectiveWeek, effectiveDay, itemId]);
      newPosition = posRow.next_pos;
    }

    const { rows: [updated] } = await db.query(`
      UPDATE call_plan_items SET
        planned_week   = COALESCE($2, planned_week),
        day_of_week    = COALESCE($3, day_of_week),
        position       = COALESCE($4, position),
        status         = COALESCE($5, status),
        confirmed_time = CASE WHEN $6::TEXT IS NOT NULL THEN $6 ELSE confirmed_time END,
        notes          = CASE WHEN $7::TEXT IS NOT NULL THEN $7 ELSE notes END
      WHERE id = $1
      RETURNING *
    `, [itemId, targetWeek, day_of_week ?? null, newPosition, status ?? null,
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

// ── POST /api/planner/move-day ────────────────────────────────────────────────
// Moves ALL items from (from_week, from_day) to (to_week, to_day).
// Items that would conflict (store already in to_week) are skipped.

router.post('/move-day', requireAuth, async (req, res) => {
  try {
    const isManager = ['manager', 'executive'].includes(req.session.role);
    const { from_week, from_day, to_week, to_day } = req.body;
    const repId = isManager && req.body.rep_id ? parseInt(req.body.rep_id) : req.session.userId;

    if (!from_week || !from_day || !to_week || !to_day) {
      return res.status(400).json({ error: 'from_week, from_day, to_week, to_day required' });
    }

    const fromWeek = isoMonday(from_week);
    const toWeek   = isoMonday(to_week);
    const fromDay  = parseInt(from_day);
    const toDay    = parseInt(to_day);

    if (fromWeek === toWeek && fromDay === toDay) {
      return res.json({ ok: true, moved: 0, skipped: 0, message: 'Same day — nothing to do' });
    }

    const { rows: items } = await db.query(`
      SELECT * FROM call_plan_items
      WHERE rep_id = $1 AND planned_week = $2 AND day_of_week = $3
      ORDER BY position
    `, [repId, fromWeek, fromDay]);

    if (items.length === 0) {
      return res.json({ ok: true, moved: 0, skipped: 0, message: 'No items in source day' });
    }

    const { rows: [posRow] } = await db.query(`
      SELECT COALESCE(MAX(position), 0) AS max_pos FROM call_plan_items
      WHERE rep_id = $1 AND planned_week = $2 AND day_of_week = $3
    `, [repId, toWeek, toDay]);

    let nextPos = posRow.max_pos + 1;
    let moved = 0, skipped = 0;

    for (const item of items) {
      // When moving to a different week check UNIQUE (rep, store, week) constraint
      if (toWeek !== fromWeek) {
        const { rows: conflict } = await db.query(
          `SELECT id FROM call_plan_items WHERE rep_id = $1 AND store_id = $2 AND planned_week = $3 AND id != $4`,
          [repId, item.store_id, toWeek, item.id]
        );
        if (conflict.length > 0) { skipped++; continue; }
      }
      await db.query(
        `UPDATE call_plan_items SET planned_week = $1, day_of_week = $2, position = $3 WHERE id = $4`,
        [toWeek, toDay, nextPos++, item.id]
      );
      moved++;
    }

    res.json({ ok: true, moved, skipped });
  } catch (err) {
    console.error('[planner] move-day error:', err.message);
    res.status(500).json({ error: err.message });
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
