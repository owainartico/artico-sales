require('dotenv').config();

const express    = require('express');
const path       = require('path');
const session    = require('express-session');
const PgSession  = require('connect-pg-simple')(session);
const pool       = require('./src/db/index');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new PgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: false,
  }),
  secret:            process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave:            false,
  saveUninitialized: false,
  name:              'artico.sid',
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge:   30 * 24 * 60 * 60 * 1000,  // 30 days
  },
}));

app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/health',       require('./src/routes/health'));
app.use('/auth',         require('./src/routes/auth'));
app.use('/api/users',    require('./src/routes/users'));
app.use('/api/targets',   require('./src/routes/targets'));
app.use('/api/dashboard', require('./src/routes/dashboard'));
app.use('/api/stores',    require('./src/routes/stores'));
app.use('/api/visits',    require('./src/routes/visits'));
app.use('/api/alerts',    require('./src/routes/alerts'));
app.use('/api/products',  require('./src/routes/products'));
app.use('/api/scoreboard', require('./src/routes/scoreboard'));
app.use('/api',           require('./src/routes/zoho'));

// ── SPA catch-all — serve index.html for unknown non-API paths ────────────────
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/health')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Idempotent migrations ─────────────────────────────────────────────────────
async function runMigrations() {
  try {
    await pool.query(`
      ALTER TABLE alert_log
        ADD COLUMN IF NOT EXISTS tier         SMALLINT     NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS alert_title  VARCHAR(255) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS alert_detail JSONB        NOT NULL DEFAULT '{}';
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_alert_log_tier ON alert_log(tier);`);
    console.log('[migrations] alert_log columns OK');
  } catch (err) {
    console.error('[migrations] Failed to apply alert_log migration:', err.message);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Artico Sales App running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

  await runMigrations();

  // Start background Zoho sync scheduler (runs every 60 minutes)
  const { startScheduler } = require('./src/services/sync');
  startScheduler();

  // Schedule nightly alert engine at 02:00 AEST / AEDT
  const cron = require('node-cron');
  const { runAlertEngine } = require('./src/services/alertEngine');
  cron.schedule('0 2 * * *', async () => {
    console.log('[cron] Running nightly alert engine');
    try {
      await runAlertEngine();
    } catch (err) {
      console.error('[cron] Alert engine error:', err.message);
    }
  }, { timezone: 'Australia/Sydney' });
});
