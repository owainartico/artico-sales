const express = require('express');
const pool    = require('../db/index');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
const isManager = requireRole('manager', 'executive');

const USER_COLS = 'id, email, name, role, zoho_salesperson_id, active, must_change_password, created_at';

// ── GET /api/users ────────────────────────────────────────────────────────────
router.get('/', isManager, async (req, res) => {
  try {
    const { role } = req.query;
    let query  = `SELECT ${USER_COLS} FROM users`;
    const args = [];

    if (role) {
      args.push(role);
      query += ` WHERE role = $${args.length}`;
    }
    query += ' ORDER BY name';

    const result = await pool.query(query, args);
    res.json(result.rows);
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// ── POST /api/users ───────────────────────────────────────────────────────────
router.post('/', isManager, async (req, res) => {
  const { email, name, role, zoho_salesperson_id } = req.body;

  if (!email || !name || !role) {
    return res.status(400).json({ error: 'email, name, and role are required' });
  }

  const validRoles = ['rep', 'manager', 'executive'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'role must be rep, manager, or executive' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO users (email, name, role, zoho_salesperson_id, must_change_password, active)
       VALUES ($1, $2, $3, $4, TRUE, TRUE)
       RETURNING ${USER_COLS}`,
      [email.toLowerCase().trim(), name.trim(), role, zoho_salesperson_id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ── PUT /api/users/:id ────────────────────────────────────────────────────────
router.put('/:id', isManager, async (req, res) => {
  const { id } = req.params;
  const { name, role, zoho_salesperson_id, active } = req.body;

  const fields = [];
  const args   = [];

  if (name !== undefined)               { args.push(name.trim());         fields.push(`name = $${args.length}`); }
  if (role !== undefined)               { args.push(role);                fields.push(`role = $${args.length}`); }
  if (zoho_salesperson_id !== undefined){ args.push(zoho_salesperson_id); fields.push(`zoho_salesperson_id = $${args.length}`); }
  if (active !== undefined)             { args.push(active);              fields.push(`active = $${args.length}`); }

  if (fields.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  args.push(id);
  const query = `UPDATE users SET ${fields.join(', ')} WHERE id = $${args.length} RETURNING ${USER_COLS}`;

  try {
    const result = await pool.query(query, args);
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ── POST /api/users/:id/reset-password ────────────────────────────────────────
// Clears password_hash so user is prompted to set a new one on next login.
router.post('/:id/reset-password', isManager, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `UPDATE users
       SET password_hash = NULL, must_change_password = TRUE
       WHERE id = $1 AND active = TRUE
       RETURNING id, email, name`,
      [id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ ok: true, user: result.rows[0], message: 'User will be prompted to set a new password on next login' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
