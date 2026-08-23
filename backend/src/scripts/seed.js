#!/usr/bin/env node
'use strict';

/**
 * Seed script — accounts only.
 *
 * Creates the admin account (which the API deliberately refuses to create, so there is
 * no other way to obtain one) plus the demo logins the sign-in screen offers as
 * one-click buttons. Idempotent: existing accounts are left exactly as they are,
 * passwords included, so this is safe to re-run against a live database.
 *
 * It used to also invent a venue called "Grand Auditorium" with 46 seats and nothing
 * playing in it. That has moved out: fixture *content* now lives in `npm run demo`,
 * which builds a complete, coherent scenario and wipes before it does. Mixing the two
 * was the mistake — the command a deployment must run in order to have an admin should
 * not also decide what is on sale, and a lone venue hosting no events was neither a
 * useful demo nor a necessary bootstrap.
 *
 *   npm run seed    accounts only, safe on a live database
 *   npm run demo    the full demo scenario, destructive
 */

const config = require('../config/env');
const { query, close } = require('../config/db');
const authService = require('../services/authService');
const { USERS, SIGN_IN_USERS } = require('./demo/catalogue');

async function upsertUser({ name, email, password, role }) {
  const existing = await query('SELECT id, role FROM users WHERE lower(email) = lower($1)', [email]);
  if (existing.rows[0]) {
    return { ...existing.rows[0], email, created: false };
  }
  const user = await authService.register(
    { name, email, password, role },
    { allowPrivileged: true } // the only place an admin can be minted
  );
  return { ...user, created: true };
}

async function main() {
  console.log(`[seed] target: ${config.nodeEnv}`);

  const admin = await upsertUser({
    name: config.adminSeed.name,
    email: config.adminSeed.email,
    password: config.adminSeed.password,
    role: 'admin',
  });
  console.log(
    admin.created
      ? `[seed] created admin ${config.adminSeed.email}`
      : `[seed] admin ${config.adminSeed.email} already exists (password unchanged)`
  );

  // Shared with the demo builder so the two cannot drift into disagreeing about who
  // exists or what their password is.
  let created = 0;
  for (const spec of USERS) {
    const user = await upsertUser(spec);
    if (user.created) created += 1;
  }
  console.log(
    `[seed] ${USERS.length} demo accounts ready (${created} created, ${USERS.length - created} already present)`
  );

  console.log('');
  console.log('[seed] done. Sign in with:');
  console.log(`  admin       ${config.adminSeed.email} / ${config.adminSeed.password}`);
  // Only the sign-in accounts are listed. The audience fixtures are created too, because
  // the demo narrative needs them to exist, but printing nine near-identical rows would
  // bury the four credentials anyone actually types.
  for (const spec of SIGN_IN_USERS) {
    console.log(`  ${spec.role.padEnd(10)}  ${spec.email} / ${spec.password}`);
  }
  console.log(`  (plus ${USERS.length - SIGN_IN_USERS.length} audience fixtures, not sign-in accounts)`);
  console.log('');
  console.log('[seed] no venues or events were created. Run "npm run demo" for the full');
  console.log('       demo scenario (destructive — it wipes application data first).');
}

if (require.main === module) {
  main()
    .then(() => close())
    .catch(async (err) => {
      console.error('[seed] failed:', err.message);
      process.exitCode = 1;
      await close().catch(() => {});
    });
}

module.exports = { main };
