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

// Trust Render's proxy so req.secure = true and secure cookies are sent correctly
app.set('trust proxy', 1);

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
app.use('/api/grades',    require('./src/routes/grades'));
app.use('/api/kpi',       require('./src/routes/kpi'));
app.use('/api/planner',   require('./src/routes/planner'));
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

  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS zoho_salesperson_ids TEXT[];`);

    // Deanne Burrows covers both "Owain ap Rees" and "Sally ap Rees" in Zoho.
    // Match by name (case-insensitive) — more robust than email.
    // Always overwrite so this re-runs safely even if previously set wrong.
    const { rowCount } = await pool.query(`
      UPDATE users
      SET    zoho_salesperson_id  = 'Owain ap Rees',
             zoho_salesperson_ids = ARRAY['Owain ap Rees', 'Sally ap Rees'],
             role                 = 'rep'
      WHERE  name ILIKE '%deanne%'
    `);
    console.log(`[migrations] users.zoho_salesperson_ids OK — Deanne rows updated: ${rowCount}`);
  } catch (err) {
    console.error('[migrations] Failed to apply users migration:', err.message);
  }

  // ── Grade system schema ──────────────────────────────────────────────────────
  try {
    await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS grade_locked BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS grade_history (
        id          SERIAL      PRIMARY KEY,
        store_id    INTEGER     NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        old_grade   CHAR(1)     CHECK (old_grade IN ('A','B','C')),
        new_grade   CHAR(1)     CHECK (new_grade IN ('A','B','C')),
        reason      TEXT        NOT NULL DEFAULT '',
        changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        changed_by  TEXT        NOT NULL DEFAULT 'system',
        locked      BOOLEAN     NOT NULL DEFAULT FALSE
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_grade_history_store      ON grade_history(store_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_grade_history_changed_at ON grade_history(changed_at DESC);`);
    console.log('[migrations] grade_history + grade_locked OK');
  } catch (err) {
    console.error('[migrations] Failed to apply grade schema migration:', err.message);
  }

  // ── Prospect flag ─────────────────────────────────────────────────────────
  try {
    await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS is_prospect BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stores_prospect ON stores(is_prospect) WHERE is_prospect = TRUE;`);
    console.log('[migrations] stores.is_prospect OK');
  } catch (err) {
    console.error('[migrations] Failed to apply is_prospect migration:', err.message);
  }

  // ── Call Planner schema ───────────────────────────────────────────────────
  try {
    await pool.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS postcode VARCHAR(10);`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS call_plan_items (
        id             SERIAL       PRIMARY KEY,
        rep_id         INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        store_id       INTEGER      NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        planned_week   DATE         NOT NULL,
        day_of_week    SMALLINT     NOT NULL CHECK (day_of_week BETWEEN 1 AND 5),
        position       SMALLINT     NOT NULL DEFAULT 1,
        status         VARCHAR(20)  NOT NULL DEFAULT 'suggested'
                                    CHECK (status IN ('suggested','confirmed','completed','skipped')),
        confirmed_time VARCHAR(10),
        notes          TEXT,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE (rep_id, store_id, planned_week)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_call_plan_rep_week ON call_plan_items(rep_id, planned_week);`);
    console.log('[migrations] call_plan_items OK');
  } catch (err) {
    console.error('[migrations] Failed to apply call_plan_items migration:', err.message);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Artico Sales App running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

  await runMigrations();

  // Load persisted Zoho refresh token from DB (falls back to env var on first run)
  const { initZohoTokens } = require('./src/services/zoho');
  await initZohoTokens();

  // Start background Zoho sync scheduler (runs every 60 minutes)
  const { startScheduler } = require('./src/services/sync');
  startScheduler();

  // Schedule nightly alert engine + prospect classification at 02:00 AEST / AEDT
  const cron = require('node-cron');
  const { runAlertEngine } = require('./src/services/alertEngine');
  const { classifyProspects: _classifyProspects, promoteActiveProspects: _promoteActiveProspects, downgradeInactiveToProspect: _downgradeInactiveToProspect } = require('./src/services/grading');
  cron.schedule('0 2 * * *', async () => {
    console.log('[cron] Running nightly alert engine');
    try {
      await runAlertEngine();
    } catch (err) {
      console.error('[cron] Alert engine error:', err.message);
    }

    // Nightly prospect classification ensures stores that lapse out of the
    // 24-month activity window get their P badge within a day, not just quarterly.
    // Runs after the alert engine so the invoice cache is already warm.
    console.log('[cron] Running nightly prospect classification');
    try {
      await _classifyProspects();
      await _promoteActiveProspects();
      await _downgradeInactiveToProspect();
    } catch (err) {
      console.error('[cron] Nightly prospect classification error:', err.message);
    }
  }, { timezone: 'Australia/Sydney' });

  // Auto-grade ungraded stores 120 seconds after startup (after invoice cache warms)
  // Scheduler starts at 30s and pre-warms both 13m and 24m cache windows.
  // 120s gives enough time for the 24m Zoho fetch to complete before grading runs.
  const { runAutoGrading, runQuarterlyGrading, classifyProspects, promoteActiveProspects, downgradeInactiveToProspect } = require('./src/services/grading');
  setTimeout(async () => {
    try {
      await runAutoGrading();              // grade all null-grade active stores
      await classifyProspects();            // mark remaining null-grade stores as prospects
      await promoteActiveProspects();       // un-prospect any that now have activity
      await downgradeInactiveToProspect();  // downgrade lapsed graded stores → prospect
    } catch (err) {
      console.error('[startup] Auto-grading/prospect classification failed:', err.message);
    }
  }, 120_000);

  // Quarterly reassessment — last day of Mar/Jun/Sep/Dec at 03:00 AEST
  cron.schedule('0 3 28-31 3,6,9,12 *', async () => {
    const now     = new Date();
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    if (now.getDate() !== lastDay) return; // only run on the actual last day
    console.log('[cron] Running quarterly grade reassessment');
    try {
      await runQuarterlyGrading();
      await classifyProspects();
      await promoteActiveProspects();
      await downgradeInactiveToProspect();
    } catch (err) {
      console.error('[cron] Quarterly grading error:', err.message);
    }
  }, { timezone: 'Australia/Sydney' });
});
