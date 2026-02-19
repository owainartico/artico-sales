const express  = require('express');
const bcrypt   = require('bcryptjs');
const pool     = require('../db/index');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND active = TRUE',
      [email.toLowerCase().trim()]
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Account has no password yet — first login
    if (!user.password_hash) {
      return res.status(200).json({
        first_login: true,
        user_id: user.id,
        message: 'Please set your password to continue',
      });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    req.session.userId = user.id;
    req.session.role   = user.role;
    req.session.name   = user.name;

    res.json({
      id:                   user.id,
      email:                user.email,
      name:                 user.name,
      role:                 user.role,
      must_change_password: user.must_change_password,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, name, role, must_change_password FROM users WHERE id = $1 AND active = TRUE',
      [req.session.userId]
    );
    const user = result.rows[0];
    if (!user) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (err) {
    console.error('Get me error:', err);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// ── POST /auth/change-password ────────────────────────────────────────────────
// Works for both:
//   • First-login flow (no session yet): body must include user_id
//   • Authenticated users changing their own password: body includes current_password
router.post('/change-password', async (req, res) => {
  const { user_id, password, current_password } = req.body;

  const targetId = req.session?.userId || user_id;
  if (!targetId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE id = $1 AND active = TRUE',
      [targetId]
    );
    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // If user already has a password and it's not a forced-change, verify current password
    if (user.password_hash && !user.must_change_password) {
      if (!current_password) {
        return res.status(400).json({ error: 'Current password is required' });
      }
      const valid = await bcrypt.compare(current_password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
    }

    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      'UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2',
      [hash, targetId]
    );

    // Establish session for first-login flow
    req.session.userId = user.id;
    req.session.role   = user.role;
    req.session.name   = user.name;

    res.json({ id: user.id, name: user.name, role: user.role, must_change_password: false });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;
