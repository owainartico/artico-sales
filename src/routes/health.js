const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  let dbStatus = 'connected';
  try {
    await db.query('SELECT 1');
  } catch {
    dbStatus = 'error';
  }

  res.json({
    status: 'ok',
    db: dbStatus,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
