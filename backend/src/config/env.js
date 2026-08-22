'use strict';

/**
 * Central configuration. Everything is read from the environment exactly once,
 * validated here, and consumed as a frozen object elsewhere.
 *
 * The database is configured from a single DATABASE_URL connection string
 * rather than discrete host/port/user/password vars, because that is what
 * Render and Railway inject when you attach their managed Postgres add-on.
 */

const path = require('node:path');
const dotenv = require('dotenv');

// Load .env from the backend root. In production the platform supplies real
// env vars and the file simply won't exist, which dotenv treats as a no-op.
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const NODE_ENV = process.env.NODE_ENV || 'development';
const isTest = NODE_ENV === 'test';
const isProduction = NODE_ENV === 'production';

function required(name, fallback) {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  if (fallback !== undefined && !isProduction) return fallback;
  throw new Error(
    `Missing required environment variable ${name}. ` +
      'Copy .env.example to .env and fill it in.'
  );
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

// In test mode prefer TEST_DATABASE_URL so a test run can never truncate the
// development database by accident.
const databaseUrl = isTest
  ? process.env.TEST_DATABASE_URL ||
    required('DATABASE_URL', 'postgresql://localhost:5432/ticket_booking_test')
  : required('DATABASE_URL', 'postgresql://localhost:5432/ticket_booking');

/**
 * Managed Postgres on Render/Railway/Neon/Supabase requires TLS but presents a
 * certificate that isn't in Node's default trust store, so verification has to
 * be relaxed for those hosts. Local Postgres generally has TLS off entirely.
 * Detect rather than making the operator set another flag, but allow an
 * explicit override via PGSSL.
 */
function resolveSsl(url) {
  const override = process.env.PGSSL;
  if (override === 'true' || override === 'require') return { rejectUnauthorized: false };
  if (override === 'false' || override === 'disable') return false;

  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const isLocal =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '' ||
    host.endsWith('.local');

  if (isLocal) return false;
  if (/sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

const config = Object.freeze({
  nodeEnv: NODE_ENV,
  isTest,
  isProduction,
  port: int('PORT', 3000),

  db: Object.freeze({
    connectionString: databaseUrl,
    ssl: resolveSsl(databaseUrl),
    max: int('PG_POOL_MAX', 10),
    idleTimeoutMillis: int('PG_IDLE_TIMEOUT_MS', 30_000),
    connectionTimeoutMillis: int('PG_CONNECT_TIMEOUT_MS', 10_000),
    // Guard against a pathological query pinning a pool connection forever.
    statementTimeoutMillis: int('PG_STATEMENT_TIMEOUT_MS', 15_000),
  }),

  jwt: Object.freeze({
    // A weak default is tolerable in dev/test but must never ship to prod,
    // hence required() with no fallback when NODE_ENV=production.
    secret: required('JWT_SECRET', 'dev-only-insecure-secret-change-me'),
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  }),

  // Seat lifecycle windows. Both are enforced by Postgres via now() + interval,
  // so the app server clock is never authoritative.
  holdTtlMinutes: int('HOLD_TTL_MINUTES', 10),
  offerTtlMinutes: int('OFFER_TTL_MINUTES', 30),
  sweepCron: process.env.SWEEP_CRON || '*/15 * * * * *', // every 15 seconds
  sweepEnabled: process.env.SWEEP_ENABLED !== 'false' && !isTest,

  bcryptRounds: int('BCRYPT_ROUNDS', isTest ? 4 : 10),

  smtp: Object.freeze({
    host: process.env.SMTP_HOST || '',
    port: int('SMTP_PORT', 2525),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'TixLock <no-reply@ticketbooking.local>',
    // When unset, the mailer falls back to a logging transport so dev works
    // with no Mailtrap account.
    get enabled() {
      return Boolean(process.env.SMTP_HOST);
    },
  }),

  // Used to build the absolute waitlist-offer link that goes into emails.
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${int('PORT', 3000)}`).replace(/\/$/, ''),

  adminSeed: Object.freeze({
    email: process.env.ADMIN_EMAIL || 'admin@ticketbooking.local',
    password: process.env.ADMIN_PASSWORD || 'admin12345',
    name: process.env.ADMIN_NAME || 'Platform Admin',
  }),
});

module.exports = config;
