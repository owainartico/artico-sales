'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const db = require('../db');
const { runAutoGrading, runQuarterlyGrading, classifyProspects, promoteActiveProspects, downgradeInactiveToProspect } = require('../services/grading');

const router = express.Router();

// ── GET /api/grades/history ───────────────────────────────────────────────────
// Query params: store_id, rep_id, from, to, limit (default 100, max 500)

router.get('/history', requireAuth, requireRole('manager', 'executive'), async (req, res) => {
  try {
    const { store_id, rep_id, from, to, limit = 100 } = req.query;
    const conditions = [];
    const params     = [];
    let p = 1;

    if (store_id) { conditions.push(`gh.store_id = $${p++}`); params.push(parseInt(store_id)); }
    if (rep_id)   { conditions.push(`s.rep_id    = $${p++}`); params.push(parseInt(rep_id)); }
    if (from)     { conditions.push(`gh.changed_at >= $${p++}`); params.push(from); }
    if (to)       { conditions.push(`gh.changed_at <= $${p++}`); params.push(to); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await db.query(`
      SELECT
        gh.id, gh.store_id, gh.old_grade, gh.new_grade,
        gh.reason, gh.changed_at, gh.changed_by, gh.locked,
        s.name AS store_name, s.state,
        s.rep_id, u.name AS rep_name
      FROM grade_history gh
      JOIN   stores s ON s.id = gh.store_id
      LEFT JOIN users u ON u.id = s.rep_id
      ${where}
      ORDER BY gh.changed_at DESC
      LIMIT $${p}
    `, [...params, Math.min(parseInt(limit) || 100, 500)]);

    res.json(rows);
  } catch (err) {
    console.error('Grade history error:', err.message);
    res.status(500).json({ error: 'Failed to load grade history' });
  }
});

// ── GET /api/grades/report ────────────────────────────────────────────────────
// Quarterly summary: upgrades, downgrades, stable by rep + grade distribution

router.get('/report', requireAuth, requireRole('manager', 'executive'), async (req, res) => {
  try {
    // Current quarter start date
    const now    = new Date();
    const qMonth = Math.floor(now.getMonth() / 3) * 3; // 0, 3, 6, or 9
    const qStart = `${now.getFullYear()}-${String(qMonth + 1).padStart(2, '0')}-01`;

    const [{ rows: changes }, { rows: distribution }] = await Promise.all([
      // Grade changes this quarter, summarised by rep
      db.query(`
        SELECT
          u.id   AS rep_id,
          u.name AS rep_name,
          SUM(CASE WHEN
            (gh.old_grade = 'C' AND gh.new_grade IN ('A','B')) OR
            (gh.old_grade = 'B' AND gh.new_grade = 'A')
            THEN 1 ELSE 0 END)::INTEGER AS upgrades,
          SUM(CASE WHEN
            (gh.old_grade = 'A' AND gh.new_grade IN ('B','C')) OR
            (gh.old_grade = 'B' AND gh.new_grade = 'C') OR
            (gh.old_grade IN ('A','B','C') AND gh.new_grade IS NULL)
            THEN 1 ELSE 0 END)::INTEGER AS downgrades,
          COUNT(*)::INTEGER AS total_changes
        FROM grade_history gh
        JOIN   stores s ON s.id = gh.store_id
        LEFT JOIN users u ON u.id = s.rep_id
        WHERE gh.changed_at >= $1
        GROUP BY u.id, u.name
        ORDER BY u.name
      `, [qStart]),

      // Current grade distribution by rep
      db.query(`
        SELECT s.rep_id, u.name AS rep_name, s.grade, COUNT(*)::INTEGER AS count
        FROM stores s
        LEFT JOIN users u ON u.id = s.rep_id
        WHERE s.active = TRUE AND s.rep_id IS NOT NULL
        GROUP BY s.rep_id, u.name, s.grade
        ORDER BY u.name, s.grade
      `),
    ]);

    // Build rep map: rep_id → { rep_name, A, B, C, ungraded, upgrades, downgrades, total_changes }
    const byRep = {};

    for (const r of distribution) {
      if (!byRep[r.rep_id]) {
        byRep[r.rep_id] = { rep_id: r.rep_id, rep_name: r.rep_name, A: 0, B: 0, C: 0, ungraded: 0, upgrades: 0, downgrades: 0, total_changes: 0 };
      }
      byRep[r.rep_id][r.grade || 'ungraded'] = r.count;
    }

    for (const r of changes) {
      if (!byRep[r.rep_id]) {
        byRep[r.rep_id] = { rep_id: r.rep_id, rep_name: r.rep_name, A: 0, B: 0, C: 0, ungraded: 0, upgrades: 0, downgrades: 0, total_changes: 0 };
      }
      byRep[r.rep_id].upgrades      = r.upgrades;
      byRep[r.rep_id].downgrades    = r.downgrades;
      byRep[r.rep_id].total_changes = r.total_changes;
    }

    const rows = Object.values(byRep).sort((a, b) => (a.rep_name || '').localeCompare(b.rep_name || ''));

    const company_totals = {
      upgrades:      rows.reduce((s, r) => s + r.upgrades, 0),
      downgrades:    rows.reduce((s, r) => s + r.downgrades, 0),
      total_changes: rows.reduce((s, r) => s + r.total_changes, 0),
      A:             rows.reduce((s, r) => s + r.A, 0),
      B:             rows.reduce((s, r) => s + r.B, 0),
      C:             rows.reduce((s, r) => s + r.C, 0),
      ungraded:      rows.reduce((s, r) => s + r.ungraded, 0),
    };

    res.json({ quarter_start: qStart, by_rep: rows, company_totals });
  } catch (err) {
    console.error('Grade report error:', err.message);
    res.status(500).json({ error: 'Failed to load grade report' });
  }
});

// ── POST /api/grades/run-auto ─────────────────────────────────────────────────
// Manually trigger auto-grading for ungraded stores (executive only)

router.post('/run-auto', requireAuth, requireRole('executive'), async (req, res) => {
  try {
    const [auto, prospects, promote, lapsed] = await Promise.allSettled([
      runAutoGrading(),
      classifyProspects(),
      promoteActiveProspects(),
      downgradeInactiveToProspect(),
    ]);
    res.json({
      ok: true,
      auto_grade:    auto.value    || { error: auto.reason?.message },
      classify:      prospects.value || { error: prospects.reason?.message },
      promote:       promote.value || { error: promote.reason?.message },
      lapsed:        lapsed.value  || { error: lapsed.reason?.message },
    });
  } catch (err) {
    console.error('Run auto-grade error:', err.message);
    res.status(500).json({ error: 'Auto-grading failed' });
  }
});

// ── POST /api/grades/run-quarterly ───────────────────────────────────────────
// Manually trigger quarterly reassessment (executive only)

router.post('/run-quarterly', requireAuth, requireRole('executive'), async (req, res) => {
  try {
    const result = await runQuarterlyGrading();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Run quarterly grade error:', err.message);
    res.status(500).json({ error: 'Quarterly grading failed' });
  }
});

module.exports = router;
