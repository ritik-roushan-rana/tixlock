'use strict';

/**
 * Small hand-rolled validation helpers.
 *
 * Deliberately not a schema library: the input surface here is narrow and the
 * value of a dependency-free, obvious-at-a-glance validator outweighs the
 * ergonomics of zod/joi for this many fields. Every helper throws a 400 AppError
 * on failure so handlers can validate inline without try/catch.
 */

const { badRequest } = require('./errors');

function str(value, field, { min = 1, max = 500, trim = true } = {}) {
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
  const out = trim ? value.trim() : value;
  if (out.length < min) throw badRequest(`${field} must be at least ${min} character(s)`);
  if (out.length > max) throw badRequest(`${field} must be at most ${max} characters`);
  return out;
}

function email(value, field = 'email') {
  const raw = str(value, field, { max: 254 });
  // Intentionally permissive: the authoritative check is whether mail is
  // deliverable, which no regex can establish. This only rejects obvious junk.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) throw badRequest(`${field} must be a valid email`);
  return raw.toLowerCase();
}

function password(value, field = 'password') {
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
  if (value.length < 8) throw badRequest(`${field} must be at least 8 characters`);
  // bcrypt silently truncates input beyond 72 bytes, which would make two
  // different long passwords interchangeable. Reject instead of truncating.
  if (Buffer.byteLength(value, 'utf8') > 72) {
    throw badRequest(`${field} must be at most 72 bytes`);
  }
  return value;
}

function int(value, field, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n)) throw badRequest(`${field} must be an integer`);
  if (n < min) throw badRequest(`${field} must be >= ${min}`);
  if (n > max) throw badRequest(`${field} must be <= ${max}`);
  return n;
}

function id(value, field = 'id') {
  return int(value, field, { min: 1 });
}

function money(value, field) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number`);
  if (n < 0) throw badRequest(`${field} must not be negative`);
  if (n > 99_999_999) throw badRequest(`${field} is too large`);
  // Round to 2dp to match NUMERIC(10,2) rather than letting Postgres do it
  // silently, so the caller's total and ours can never disagree.
  return Math.round(n * 100) / 100;
}

function oneOf(value, field, allowed) {
  if (!allowed.includes(value)) {
    throw badRequest(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

/** ISO date, YYYY-MM-DD. Kept as a string — DATE columns need no time zone. */
function dateStr(value, field) {
  const raw = str(value, field, { max: 10, min: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw badRequest(`${field} must be formatted YYYY-MM-DD`);
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw badRequest(`${field} is not a real date`);
  // Catches 2026-02-31, which Date would roll forward to March.
  if (d.toISOString().slice(0, 10) !== raw) throw badRequest(`${field} is not a real date`);
  return raw;
}

/** HH:MM or HH:MM:SS, normalised to HH:MM:SS for the TIME column. */
function timeStr(value, field) {
  const raw = str(value, field, { max: 8, min: 4 });
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (!m) throw badRequest(`${field} must be formatted HH:MM or HH:MM:SS`);
  const [h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
  if (h > 23 || mi > 59 || s > 59) throw badRequest(`${field} is not a real time`);
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Array of distinct positive integer ids.
 *
 * De-duplication matters for the seat-hold path specifically: a client sending
 * [5, 5, 7] would otherwise request 3 seats while the locking SELECT can only
 * ever return 2 rows, and the count comparison would reject a legitimate
 * request. Normalising here keeps that check honest.
 */
function idArray(value, field, { min = 1, max = 20 } = {}) {
  if (!Array.isArray(value)) throw badRequest(`${field} must be an array`);
  const ids = [...new Set(value.map((v, i) => id(v, `${field}[${i}]`)))];
  if (ids.length < min) throw badRequest(`${field} must contain at least ${min} id(s)`);
  if (ids.length > max) throw badRequest(`${field} must contain at most ${max} id(s)`);
  return ids;
}

function optional(value, fn) {
  if (value === undefined || value === null || value === '') return undefined;
  return fn(value);
}

module.exports = {
  str,
  email,
  password,
  int,
  id,
  money,
  oneOf,
  dateStr,
  timeStr,
  idArray,
  optional,
};
