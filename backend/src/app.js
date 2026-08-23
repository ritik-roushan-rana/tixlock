'use strict';

/**
 * Express application factory.
 *
 * Exported without calling listen() so tests can drive it via supertest and
 * server.js can attach Socket.io to the same HTTP server.
 */

const path = require('node:path');
const express = require('express');
const cors = require('cors');

const config = require('./config/env');
const { healthcheck } = require('./config/db');
const { asyncHandler, notFoundHandler, errorHandler } = require('./middleware/error');

function createApp() {
  const app = express();

  // Behind Render/Railway's proxy, so req.ip and protocol come from headers.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(cors());
  // Cap body size — no endpoint here legitimately needs more, and an unbounded
  // limit is free memory pressure.
  app.use(express.json({ limit: '100kb' }));

  if (!config.isTest) {
    app.use((req, res, next) => {
      const start = process.hrtime.bigint();
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
      });
      next();
    });
  }

  app.get(
    '/api/health',
    asyncHandler(async (req, res) => {
      const dbOk = await healthcheck().catch(() => false);
      res.status(dbOk ? 200 : 503).json({
        status: dbOk ? 'ok' : 'degraded',
        database: dbOk ? 'connected' : 'unreachable',
        holdTtlMinutes: config.holdTtlMinutes,
        offerTtlMinutes: config.offerTtlMinutes,
        // Which delivery path is configured — the name only, never a credential.
        //
        // Worth exposing because "mail is silently not being sent" is otherwise
        // invisible from outside the process: a misconfigured deploy reports a
        // perfectly healthy service while every confirmation goes to a console
        // transport. Answering it previously meant reading boot logs, and only after
        // something had already tried to send.
        mail:
          config.mailjet.enabled ? 'mailjet' : config.smtp.enabled ? 'smtp' : 'console (not sent)',
      });
    })
  );

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/venues', require('./routes/venues'));
  app.use('/api/events', require('./routes/events'));
  // Holds mount first: both routers live under /api/shows and Express matches in
  // registration order, so the specific write paths are resolved before the
  // generic /:id reads.
  app.use('/api/shows', require('./routes/holds'));
  app.use('/api/shows', require('./routes/shows'));
  app.use('/api/bookings', require('./routes/bookings'));
  app.use('/api/waitlist', require('./routes/waitlist'));
  app.use('/api/dashboard', require('./routes/dashboard'));

  // Serve the frontend from the same origin, so a single web service on
  // Render/Railway hosts both API and UI and no CORS config is needed in prod.
  const frontendDir = path.join(__dirname, '..', '..', 'frontend');
  app.use(express.static(frontendDir, { extensions: ['html'] }));

  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
