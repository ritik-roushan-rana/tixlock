#!/usr/bin/env node
'use strict';

/**
 * Seed script.
 *
 * Creates the admin account (which the API deliberately refuses to create) plus
 * a small demo dataset so the UI has something to show immediately after a fresh
 * migrate. Idempotent: re-running updates rather than duplicating.
 */

const config = require('../config/env');
const { query, withTransaction, close } = require('../config/db');
const authService = require('../services/authService');

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

  await upsertUser({
    name: 'Demo Organiser',
    email: 'organiser@ticketbooking.local',
    password: 'organiser123',
    role: 'organiser',
  });
  await upsertUser({
    name: 'Demo Customer',
    email: 'customer@ticketbooking.local',
    password: 'customer123',
    role: 'customer',
  });
  await upsertUser({
    name: 'Second Customer',
    email: 'customer2@ticketbooking.local',
    password: 'customer123',
    role: 'customer',
  });
  console.log('[seed] demo organiser + 2 customers ready');

  // Demo venue with a small layout: enough rows to look like a real seat map,
  // small enough that a category can be sold out by hand to exercise the waitlist.
  const venueName = 'Grand Auditorium';
  let venue = (await query('SELECT id FROM venues WHERE name = $1', [venueName])).rows[0];

  if (!venue) {
    venue = await withTransaction(async (client) => {
      const { rows } = await client.query(
        'INSERT INTO venues (name, address, created_by) VALUES ($1, $2, $3) RETURNING id',
        [venueName, '1 Marine Drive, Mumbai', admin.id]
      );
      const venueId = rows[0].id;

      const layout = [
        { row_label: 'A', seats: 8, category: 'Premium' },
        { row_label: 'B', seats: 8, category: 'Premium' },
        { row_label: 'C', seats: 10, category: 'Standard' },
        { row_label: 'D', seats: 10, category: 'Standard' },
        { row_label: 'E', seats: 10, category: 'Standard' },
      ];
      for (const row of layout) {
        for (let n = 1; n <= row.seats; n += 1) {
          await client.query(
            'INSERT INTO venue_seats (venue_id, row_label, seat_number, category) VALUES ($1, $2, $3, $4)',
            [venueId, row.row_label, n, row.category]
          );
        }
      }
      return { id: venueId };
    });
    console.log(`[seed] created venue "${venueName}" with 46 seats`);
  } else {
    console.log(`[seed] venue "${venueName}" already exists`);
  }

  console.log('');
  console.log('[seed] done. Sign in with:');
  console.log(`  admin      ${config.adminSeed.email} / ${config.adminSeed.password}`);
  console.log('  organiser  organiser@ticketbooking.local / organiser123');
  console.log('  customer   customer@ticketbooking.local / customer123');
  console.log('  customer2  customer2@ticketbooking.local / customer123');
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
