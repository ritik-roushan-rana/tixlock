'use strict';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const config = require('../config/env');
const { query } = require('../config/db');
const { conflict, unauthorized, badRequest } = require('../lib/errors');

/** Roles a user may pick when registering themselves. */
const SELF_REGISTERABLE_ROLES = ['customer', 'organiser'];
const ALL_ROLES = ['customer', 'organiser', 'admin'];

/** Public shape of a user. password_hash must never appear in a response. */
const PUBLIC_COLUMNS = 'id, name, email, role, created_at';

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret);
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw unauthorized('Session expired, please log in again');
    throw unauthorized('Invalid authentication token');
  }
}

/**
 * Create a user.
 *
 * `role` is validated against SELF_REGISTERABLE_ROLES so a caller cannot mint an
 * admin by posting {"role":"admin"} — privilege escalation via request body is
 * the obvious attack on an open registration endpoint. Admin accounts come from
 * the seed script only, which passes allowPrivileged.
 */
async function register({ name, email, password, role = 'customer' }, { allowPrivileged = false } = {}) {
  const permitted = allowPrivileged ? ALL_ROLES : SELF_REGISTERABLE_ROLES;
  if (!permitted.includes(role)) {
    throw badRequest(
      `role must be one of: ${permitted.join(', ')}` +
        (role === 'admin' ? ' (admin accounts are provisioned by the platform, not self-registered)' : '')
    );
  }

  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);

  try {
    const { rows } = await query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING ${PUBLIC_COLUMNS}`,
      [name, email, passwordHash, role]
    );
    return rows[0];
  } catch (err) {
    // 23505 = unique_violation on users.email / users_email_lower_key
    if (err.code === '23505') throw conflict('An account with that email already exists');
    throw err;
  }
}

/**
 * Verify credentials.
 *
 * Returns the same generic error for "no such user" and "wrong password" so the
 * endpoint cannot be used to enumerate which emails have accounts. The dummy
 * bcrypt compare on the miss path keeps response time roughly constant either
 * way, closing the timing side channel that would otherwise leak the same thing.
 */
async function login({ email, password }) {
  const { rows } = await query(
    'SELECT id, name, email, role, password_hash, created_at FROM users WHERE lower(email) = lower($1)',
    [email]
  );
  const user = rows[0];

  if (!user) {
    await bcrypt.compare(password, '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    throw unauthorized('Incorrect email or password');
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw unauthorized('Incorrect email or password');

  delete user.password_hash;
  return { user, token: signToken(user) };
}

async function findById(id) {
  const { rows } = await query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

module.exports = {
  register,
  login,
  findById,
  signToken,
  verifyToken,
  SELF_REGISTERABLE_ROLES,
  ALL_ROLES,
  PUBLIC_COLUMNS,
};
