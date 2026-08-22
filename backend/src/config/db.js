'use strict';

/**
 * Single pooled pg.Pool for the whole process.
 *
 * Deliberately NOT a client per request: creating a connection per request adds
 * a TCP + TLS + auth round trip to every call and will exhaust the connection
 * limit on a free-tier managed Postgres almost immediately.
 */

const { Pool, types } = require('pg');
const config = require('./env');

/**
 * Return DATE columns as plain 'YYYY-MM-DD' strings.
 *
 * By default pg parses a DATE into a JavaScript Date at local midnight. Once that
 * is serialised to JSON it becomes a UTC instant, which shifts the calendar day
 * backwards for any timezone east of UTC: a show stored as 2026-09-15 came back
 * over the API as "2026-09-14T18:30:00.000Z" in IST, and the frontend then
 * displayed the 14th.
 *
 * A DATE has no time and no zone, so converting it to an instant is meaningless
 * in the first place. Handing the string through unchanged keeps the value the
 * organiser typed identical to the value the customer sees.
 */
types.setTypeParser(types.builtins.DATE, (value) => value);

/**
 * Return NUMERIC as a string (this is pg's default; asserted here deliberately).
 *
 * Money lives in NUMERIC(10,2). Parsing it to a JS number would route every
 * price and total through a float, reintroducing the rounding errors the NUMERIC
 * column exists to avoid. Totals are computed in SQL, so the app only ever needs
 * to pass these values through.
 */
types.setTypeParser(types.builtins.NUMERIC, (value) => value);

const pool = new Pool({
  connectionString: config.db.connectionString,
  ssl: config.db.ssl,
  max: config.db.max,
  idleTimeoutMillis: config.db.idleTimeoutMillis,
  connectionTimeoutMillis: config.db.connectionTimeoutMillis,
  // Applied per connection by pg as a startup parameter.
  statement_timeout: config.db.statementTimeoutMillis,
});

/**
 * Free-tier managed Postgres (Render, Railway, Neon) drops idle connections
 * without warning. pg surfaces that as an 'error' event on the *idle client*,
 * which is emitted on the Pool. If nothing is listening, Node treats it as an
 * unhandled 'error' event and kills the process.
 *
 * Handling it here is what makes reconnection graceful: pg has already removed
 * the dead client from the pool by the time this fires, so the next checkout
 * transparently dials a fresh connection. We only need to not crash.
 */
pool.on('error', (err) => {
  console.error('[db] idle client error (connection will be replaced):', err.message);
});

pool.on('connect', (client) => {
  // Fail fast rather than hang forever if a statement misbehaves. Set per
  // connection because pool-level options don't survive a reconnect.
  client.query(`SET statement_timeout = ${config.db.statementTimeoutMillis}`).catch((err) => {
    console.error('[db] failed to set statement_timeout:', err.message);
  });
});

/** Run a single query on a pooled connection. */
function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run `fn` inside a transaction on a single dedicated client.
 *
 * This is the only sanctioned way to mutate seat state. Every caller that does
 * a check-then-set on show_seats goes through here so that the SELECT ... FOR
 * UPDATE and the subsequent UPDATE are guaranteed to run on the same
 * connection — row locks belong to a transaction, and a transaction belongs to
 * a connection. Issuing them via pool.query() would be a correctness bug: each
 * statement could land on a different client, so the lock taken by the SELECT
 * would not cover the UPDATE.
 *
 * Rolls back on any thrown error and always returns the client to the pool.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // A failed rollback means the connection is unusable. Log and move on;
      // release() below with an error marks it for destruction.
      console.error('[db] rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Verify the database is reachable. Used at boot and by /health. */
async function healthcheck() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0].ok === 1;
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, withTransaction, healthcheck, close };
