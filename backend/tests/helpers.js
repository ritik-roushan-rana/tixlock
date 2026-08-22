'use strict';

/**
 * Shared test helpers: truncation between tests, and fixture builders that go
 * through the real HTTP API wherever possible so tests exercise the same code
 * path production traffic does.
 */

process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../src/app');
const { query, pool } = require('../src/config/db');
const authService = require('../src/services/authService');

const app = createApp();
const api = () => request(app);

/**
 * Wipe all data between tests.
 *
 * TRUNCATE ... RESTART IDENTITY CASCADE rather than DELETE so sequences reset
 * too, keeping ids predictable across tests. schema_migrations is excluded — the
 * schema itself must survive.
 */
async function truncateAll() {
  await query(`
    TRUNCATE booking_seats, bookings, waitlist, show_seats, show_pricing,
             shows, events, venue_seats, venues, users
    RESTART IDENTITY CASCADE
  `);
}

async function closePool() {
  await pool.end();
}

let userCounter = 0;

/** Create a user directly via the service (bypasses self-registration limits). */
async function createUser({ role = 'customer', name, email, password = 'password123' } = {}) {
  userCounter += 1;
  const finalEmail = email || `${role}${userCounter}@test.local`;
  const user = await authService.register(
    { name: name || `Test ${role} ${userCounter}`, email: finalEmail, password, role },
    { allowPrivileged: true }
  );
  return { ...user, password, token: authService.signToken(user) };
}

const auth = (user) => ({ Authorization: `Bearer ${user.token}` });

/** Insert a venue + rectangular seat layout directly, for tests that just need seats. */
async function createVenueWithLayout({ adminId, name = 'Test Venue', layout } = {}) {
  const rows = layout || [
    { row_label: 'A', seats: 3, category: 'Premium' },
    { row_label: 'B', seats: 3, category: 'Standard' },
  ];

  const venue = (
    await query('INSERT INTO venues (name, address, created_by) VALUES ($1, $2, $3) RETURNING *', [
      name,
      '1 Test Street',
      adminId,
    ])
  ).rows[0];

  for (const row of rows) {
    for (let n = 1; n <= row.seats; n += 1) {
      await query(
        'INSERT INTO venue_seats (venue_id, row_label, seat_number, category) VALUES ($1,$2,$3,$4)',
        [venue.id, row.row_label, n, row.category]
      );
    }
  }

  const seatCount = rows.reduce((sum, r) => sum + r.seats, 0);
  return { ...venue, seatCount };
}

/**
 * Build the full graph needed to test seats: admin + organiser + venue + layout
 * + event + show + priced seats.
 *
 * Goes through the service layer rather than raw SQL so show_seats generation is
 * the real code path under test everywhere downstream.
 */
async function createBookableShow({
  layout,
  pricing = { Premium: 500, Standard: 200 },
  date = '2026-12-01',
  time = '19:00',
} = {}) {
  const eventService = require('../src/services/eventService');

  const admin = await createUser({ role: 'admin' });
  const organiser = await createUser({ role: 'organiser' });
  const venue = await createVenueWithLayout({ adminId: admin.id, layout });

  const event = await eventService.createEvent({
    title: 'Test Event',
    type: 'movie',
    description: '',
    venueId: venue.id,
    organiserId: organiser.id,
  });

  const show = await eventService.createShow({ eventId: event.id, date, time, pricing });

  const { rows: seats } = await query(
    `SELECT ss.id, ss.category, ss.status, vs.row_label, vs.seat_number
       FROM show_seats ss
       JOIN venue_seats vs ON vs.id = ss.venue_seat_id
      WHERE ss.show_id = $1
      ORDER BY vs.row_label, vs.seat_number`,
    [show.id]
  );

  return { admin, organiser, venue, event, show, seats };
}

/** Read a seat's current row straight from the database. */
async function getSeat(seatId) {
  const { rows } = await query('SELECT * FROM show_seats WHERE id = $1', [seatId]);
  return rows[0];
}

module.exports = {
  app,
  api,
  query,
  truncateAll,
  closePool,
  createUser,
  auth,
  createVenueWithLayout,
  createBookableShow,
  getSeat,
};
