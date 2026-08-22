#!/usr/bin/env node
'use strict';

/**
 * Process entry point: HTTP server + Socket.io + the cron sweeper.
 *
 * app.js builds the Express app but does not listen, so this file owns the
 * lifecycle — which matters because Socket.io must attach to the same HTTP
 * server the API is served from.
 */

const http = require('node:http');

const config = require('./config/env');
const { createApp } = require('./app');
const { healthcheck, close: closeDb } = require('./config/db');
const realtime = require('./realtime/io');
const sweeper = require('./jobs/sweeper');

async function main() {
  const app = createApp();
  const server = http.createServer(app);

  // Socket.io shares the HTTP server so the API, the static frontend and the
  // websocket all live on one origin and one port — which is what makes this
  // deployable as a single Render/Railway web service.
  realtime.attach(server);

  // Verify the database before accepting traffic. Failing fast with a clear
  // message beats serving 500s from every endpoint.
  try {
    await healthcheck();
    console.log('[boot] database connection ok');
  } catch (err) {
    console.error('[boot] cannot reach the database:', err.message);
    console.error('[boot] check DATABASE_URL and that migrations have been run (npm run migrate)');
    process.exit(1);
  }

  server.listen(config.port, () => {
    console.log(`[boot] listening on http://localhost:${config.port} (${config.nodeEnv})`);
    console.log(`[boot] hold TTL ${config.holdTtlMinutes}m · offer TTL ${config.offerTtlMinutes}m`);
  });

  // Start the expiry sweeper. Single instance by design — see the trade-offs
  // section of SYSTEM_DESIGN.md for why this does not scale past one process.
  sweeper.start();

  /** Drain in-flight requests, stop the sweeper, then release the pool. */
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal} received, closing…`);

    // Order matters: stop scheduling new work, close the socket layer, stop
    // accepting connections, and only then end the pool. Ending the pool first
    // would make any in-flight request fail with a connection error.
    sweeper.stop();
    await realtime.close().catch(() => {});
    server.close();
    await closeDb().catch(() => {});
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A rejected promise nobody handled is a bug; log it loudly rather than
  // letting Node's default behaviour terminate the process silently.
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandled promise rejection:', reason);
  });

  return server;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[boot] failed to start:', err);
    process.exit(1);
  });
}

module.exports = { main };
