#!/usr/bin/env node
'use strict';

/**
 * Minimal forward-only migration runner.
 *
 * Applies every .sql file in this directory in filename order, exactly once,
 * recording what ran in a schema_migrations table. Each file runs inside its own
 * transaction, so a syntax error half way through a file leaves no partial
 * schema behind — Postgres supports transactional DDL, which is what makes this
 * approach safe enough to prefer over a heavier migration library here.
 *
 * Usage:
 *   node src/migrations/run.js up       apply pending migrations
 *   node src/migrations/run.js status   list applied/pending
 *   node src/migrations/run.js reset    drop the public schema and re-apply (dev/test only)
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('../config/env');
const { pool, close } = require('../config/db');

const MIGRATIONS_DIR = __dirname;

function discoverMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort() // zero-padded numeric prefixes make lexical order == intended order
    .map((filename) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      return {
        filename,
        sql,
        checksum: crypto.createHash('sha256').update(sql).digest('hex'),
      };
    });
}

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT        PRIMARY KEY,
      checksum   TEXT        NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrations() {
  const { rows } = await pool.query(
    'SELECT filename, checksum FROM schema_migrations ORDER BY filename'
  );
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

async function up({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...args) => console.log(...args);

  await ensureMigrationsTable();
  const applied = await appliedMigrations();
  const all = discoverMigrations();

  // A migration whose contents changed after being applied means someone edited
  // history. Refuse rather than silently diverging from what's in the database.
  for (const m of all) {
    const priorChecksum = applied.get(m.filename);
    if (priorChecksum && priorChecksum !== m.checksum) {
      throw new Error(
        `Migration ${m.filename} was modified after it was applied.\n` +
          'Forward-only migrations must not be edited. Add a new migration instead, ' +
          'or run "npm run migrate:reset" in development to rebuild from scratch.'
      );
    }
  }

  const pending = all.filter((m) => !applied.has(m.filename));

  if (pending.length === 0) {
    log('[migrate] nothing to do — schema is up to date');
    return { applied: [] };
  }

  const done = [];
  for (const migration of pending) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
        [migration.filename, migration.checksum]
      );
      await client.query('COMMIT');
      log(`[migrate] applied ${migration.filename}`);
      done.push(migration.filename);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`[migrate] FAILED on ${migration.filename}: ${err.message}`);
    } finally {
      client.release();
    }
  }

  log(`[migrate] done — ${done.length} migration(s) applied`);
  return { applied: done };
}

async function status() {
  await ensureMigrationsTable();
  const applied = await appliedMigrations();
  const all = discoverMigrations();

  console.log(`Database: ${redactUrl(config.db.connectionString)}`);
  console.log('');
  for (const m of all) {
    const mark = applied.has(m.filename) ? 'applied' : 'PENDING';
    console.log(`  [${mark}] ${m.filename}`);
  }
  const pendingCount = all.filter((m) => !applied.has(m.filename)).length;
  console.log('');
  console.log(`${all.length} migration(s), ${pendingCount} pending`);
}

async function reset() {
  if (config.isProduction) {
    throw new Error('Refusing to reset the schema with NODE_ENV=production');
  }
  console.log(`[migrate] resetting schema on ${redactUrl(config.db.connectionString)}`);
  // DROP SCHEMA takes out everything including the enum types, which a plain
  // DROP TABLE sweep would leave behind and cause "type already exists" on
  // re-apply.
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  return up();
}

/** Strip credentials before printing a connection string. */
function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<unparseable DATABASE_URL>';
  }
}

const COMMANDS = { up, status, reset };

async function main() {
  const command = process.argv[2] || 'up';
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command "${command}". Expected one of: ${Object.keys(COMMANDS).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  await handler();
}

// Only self-execute when invoked directly, so tests can import { up, reset }.
if (require.main === module) {
  main()
    .then(() => close())
    .catch(async (err) => {
      console.error(err.message);
      process.exitCode = 1;
      await close().catch(() => {});
    });
}

module.exports = { up, status, reset, discoverMigrations };
