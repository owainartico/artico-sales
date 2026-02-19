const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getRepDashboard, getTeamDashboard } = require('../services/dashboard');

const router = express.Router();

function curMonth() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}

// GET /api/dashboard/rep
router.get('/rep', requireAuth, async (req, res) => {
  const month = req.query.month || curMonth();
  const force = req.query.refresh === '1';

  try {
    const data = await getRepDashboard(req.session.userId, month, { force });
    res.json(data);
  } catch (err) {
    console.error('Rep dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

// GET /api/dashboard/team
router.get('/team', requireRole('manager', 'executive'), async (req, res) => {
  const month = req.query.month || curMonth();
  const force = req.query.refresh === '1';

  try {
    const data = await getTeamDashboard(month, { force });
    res.json(data);
  } catch (err) {
    console.error('Team dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

module.exports = router;
