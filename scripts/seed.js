#!/usr/bin/env node
/**
 * Seed script — creates the default admin account.
 * Run once after migrations: node scripts/seed.js
 *
 * The admin account is created with NO password so the first person
 * to visit the login screen is prompted to set one.
 */
require('dotenv').config();
const db = require('../src/db/index');

async function seed() {
  const email = 'admin@artico.com.au';
  const name  = 'Admin';
  const role  = 'executive';

  // Check if user already exists
  const existing = await db.query(
    'SELECT id FROM users WHERE email = $1',
    [email]
  );

  if (existing.rows.length > 0) {
    console.log(`✓ Admin user already exists (id=${existing.rows[0].id})`);
    console.log('  To reset: UPDATE users SET password_hash=NULL, must_change_password=TRUE WHERE email=\'admin@artico.com.au\';');
    await db.pool.end();
    return;
  }

  const result = await db.query(
    `INSERT INTO users (email, name, role, must_change_password, active)
     VALUES ($1, $2, $3, TRUE, TRUE)
     RETURNING id`,
    [email, name, role]
  );

  console.log('');
  console.log('✓ Admin account created');
  console.log(`  Email:    ${email}`);
  console.log(`  Role:     ${role}`);
  console.log(`  Password: (not set — first visitor will be prompted to set one)`);
  console.log(`  User ID:  ${result.rows[0].id}`);
  console.log('');

  await db.pool.end();
}

seed().catch(err => {
  if (err.errors) {
    console.error('Seed failed:', err.errors.map(e => e.message || String(e)).join('; '));
  } else {
    console.error('Seed failed:', err.message || err);
  }
  process.exit(1);
});
