#!/usr/bin/env node
'use strict';

/**
 * Build the demo dataset.
 *
 *   npm run demo              wipe application data, then rebuild the scenario
 *   npm run demo -- --yes     required when NODE_ENV=production
 *   npm run demo:reset        rebuild the schema first, then the scenario
 *
 * Why this is its own command rather than a bigger `seed`: provisioning a deployment
 * and staging a demonstration are different jobs carrying different risk. `npm run
 * seed` creates the accounts a fresh install cannot function without and touches
 * nothing else, so it stays safe to run against a live database. This script deletes
 * every venue, event and booking first, because a demo that accumulates leftovers stops
 * being a scripted walkthrough — the third run would show four Interstellars and a
 * waitlist nobody can account for.
 *
 * Idempotent by destruction rather than by upsert, deliberately: reproducing a known
 * state is the whole requirement. Running it twice yields the same dataset, and an
 * evaluator who has booked, cancelled and generally made a mess can be handed a clean
 * demo again with one command.
 *
 * No mail leaves this process — see the kill-switch immediately below, which runs before
 * anything else.
 */

/**
 * Force the mailer onto its console transport for the duration of this script.
 *
 * Building the demo performs around forty bookings and a handful of cancellations, and
 * every one of those dispatches a confirmation, a cancellation notice or a waitlist
 * offer. The sign-in fixtures live at `@tixlock.com`, which is a perfectly ordinary
 * domain as far as the mailer is concerned — unlike the reserved `.local` addresses, it
 * is *not* covered by the unroutable-domain guard. Left alone, seeding would therefore
 * hand forty messages to Mailjet for mailboxes that do not exist and collect forty hard
 * bounces, which is precisely the failure documented in mailer.js: a previous run of
 * fixture addresses produced 625 bounces, exhausted the free-plan allowance, and stopped
 * genuine booking confirmations from going out.
 *
 * Deleting the credentials from this process's environment makes `getTransport()` fall
 * through to the logging transport. It is done here, above every `require`, because
 * `config/env.js` reads some of these eagerly at module load, and the mailer caches its
 * transport on first use — so by the time any other module has been imported it is
 * already too late to change the decision.
 *
 * This affects only this short-lived script. The running server is untouched and still
 * emails real customers normally.
 */
for (const key of ['MJ_APIKEY_PUBLIC', 'MJ_APIKEY_PRIVATE', 'SMTP_HOST']) {
  delete process.env[key];
}

const config = require('../config/env');
const { query, close } = require('../config/db');
const authService = require('../services/authService');
const venueService = require('../services/venueService');
const eventService = require('../services/eventService');

const { USERS, SIGN_IN_USERS, AUDIENCE_USERS, VENUES, EVENTS } = require('./demo/catalogue');
const narrative = require('./demo/narrative');

const log = (msg) => console.log(`[demo] ${msg}`);

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

/**
 * `dayOffset: 2` -> the ISO date two days from today.
 *
 * Offsets rather than literal dates, because a demo dataset outlives the day it was
 * written. Hard-coded dates age into the past, the public browse filters them out, and
 * the app then introduces itself to an evaluator as having no events at all.
 */
function dateFromOffset(offset) {
  const d = new Date();
  d.setHours(12, 0, 0, 0); // midday, so a DST shift cannot roll the date over
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Delete all application data, leaving the schema and migration history intact.
 *
 * TRUNCATE rather than DROP SCHEMA, because this has to be runnable against a deployed
 * database where re-applying migrations is a separate and more consequential decision.
 * RESTART IDENTITY resets the sequences too, so ids are stable between runs — which
 * matters more than it looks: event ids seed the placeholder artwork, so without it the
 * same demo event would show a different photograph after every rebuild.
 *
 * CASCADE is required by the foreign keys. Every table it could reach is named
 * explicitly anyway, so nothing is truncated implicitly.
 */
async function wipe() {
  await query(`
    TRUNCATE booking_seats, bookings, waitlist, show_seats, show_pricing,
             shows, events, venue_seats, venues, users
    RESTART IDENTITY CASCADE
  `);
}

async function main() {
  const force = process.argv.includes('--yes') || process.env.DEMO_CONFIRM === 'yes';

  log(`target: ${redactUrl(config.db.connectionString)} (NODE_ENV=${config.nodeEnv})`);

  if (config.isProduction && !force) {
    console.error(
      '\n[demo] Refusing to run against a production environment without confirmation.\n' +
        '       This DELETES every user, venue, event and booking in the database.\n' +
        '       Re-run with --yes (or DEMO_CONFIRM=yes) if that is what you intend.\n'
    );
    process.exitCode = 1;
    return;
  }

  log('wiping existing data (users, venues, events, bookings, waitlist)');
  await wipe();

  /* --- Accounts --------------------------------------------------------- */

  const users = new Map();

  const admin = await authService.register(
    {
      name: config.adminSeed.name,
      email: config.adminSeed.email,
      password: config.adminSeed.password,
      role: 'admin',
    },
    // The only place an admin can be minted; the public API refuses the role outright.
    { allowPrivileged: true }
  );
  users.set('admin', { ...admin, password: config.adminSeed.password });

  for (const spec of USERS) {
    const user = await authService.register(
      { name: spec.name, email: spec.email, password: spec.password, role: spec.role },
      { allowPrivileged: true }
    );
    users.set(spec.key, { ...user, password: spec.password, note: spec.note });
  }
  const organiserCount = USERS.filter((u) => u.role === 'organiser').length;
  log(
    `created ${users.size} accounts (1 admin, ${organiserCount} organisers, ${USERS.length - organiserCount} customers)`
  );

  /* --- Venues and seat layouts ------------------------------------------
     Layout before any show, always: defineLayout refuses once shows exist,
     because show_seats rows carry a copy of the category they were sold under and
     there is no correct way to retro-fit a layout change onto sold seats. */

  const venues = new Map();
  let totalSeats = 0;
  for (const spec of VENUES) {
    const venue = await venueService.createVenue({
      name: spec.name,
      address: spec.address,
      createdBy: admin.id,
    });
    const layout = await venueService.defineLayout(venue.id, spec.layout);
    venues.set(spec.key, { ...venue, seatCount: layout.seats_created });
    totalSeats += layout.seats_created;
    log(`venue "${spec.name}" — ${layout.seats_created} seats in ${layout.rows_created} rows`);
  }

  /* --- Listings and showings -------------------------------------------- */

  const showsByEvent = new Map();

  for (const spec of EVENTS) {
    const venue = venues.get(spec.venue);
    const organiser = users.get(spec.organiser);
    const base = {
      title: spec.title,
      type: spec.type,
      description: spec.description,
      venueId: venue.id,
      organiserId: organiser.id,
    };

    const ids = [];

    if (spec.showings.length === 0) {
      // A listing with no showing is a legitimate state, so it is created through
      // the path that genuinely produces one rather than faked.
      await eventService.createEvent(base);
      showsByEvent.set(spec.key, ids);
      log(`event "${spec.title}" — no showings (draft)`);
      continue;
    }

    const [first, ...rest] = spec.showings;
    const created = await eventService.createEventWithFirstShow({
      ...base,
      firstShow: {
        date: dateFromOffset(first.dayOffset),
        time: first.time,
        pricing: first.pricing ?? spec.pricing,
      },
    });
    ids.push(created.show.id);

    for (const showing of rest) {
      const show = await eventService.createShow({
        eventId: created.event.id,
        date: dateFromOffset(showing.dayOffset),
        time: showing.time,
        pricing: showing.pricing ?? spec.pricing,
      });
      ids.push(show.id);
    }

    showsByEvent.set(spec.key, ids);
    log(`event "${spec.title}" — ${ids.length} showing(s), ${created.show.seats_created} seats each`);
  }

  /* --- The narrative ---------------------------------------------------- */

  const ctx = {
    log,
    user: (key) => {
      const user = users.get(key);
      if (!user) throw new Error(`Demo referenced unknown user "${key}"`);
      return user;
    },
    shows: (eventKey, index) => {
      const ids = showsByEvent.get(eventKey);
      if (!ids || ids[index] === undefined) {
        throw new Error(`Demo referenced missing showing ${eventKey}[${index}]`);
      }
      return ids[index];
    },
    count: { bookings: 0, cancellations: 0, waitlistJoins: 0 },
  };

  const facts = await narrative.play(ctx);

  /* --- What the evaluator gets ------------------------------------------ */

  const { rows: tally } = await query(`
    SELECT
      (SELECT count(*) FROM events)::int                                        AS events,
      (SELECT count(*) FROM shows)::int                                         AS shows,
      (SELECT count(*) FROM show_seats)::int                                    AS seats,
      (SELECT count(*) FROM bookings WHERE status = 'confirmed')::int           AS confirmed,
      (SELECT count(*) FROM bookings WHERE status = 'cancelled')::int           AS cancelled,
      (SELECT count(*) FROM show_seats WHERE status = 'booked')::int            AS booked_seats,
      (SELECT count(*) FROM show_seats WHERE status = 'held')::int              AS held_seats,
      (SELECT count(*) FROM show_seats WHERE status = 'offered')::int           AS offered_seats,
      (SELECT count(*) FROM waitlist WHERE status = 'waiting')::int             AS waiting,
      (SELECT count(*) FROM waitlist WHERE status = 'offered')::int             AS offered,
      (SELECT count(*) FROM waitlist WHERE status = 'fulfilled')::int           AS fulfilled,
      (SELECT COALESCE(sum(total_amount), 0) FROM bookings WHERE status = 'confirmed') AS revenue
  `);
  const t = tally[0];

  // Resolved to real addresses, not catalogue keys: "customer2" signs in as
  // customer2@tixlock.com, and printing the key would send an evaluator hunting for a
  // login that does not exist.
  const emailOf = (key) => users.get(key).email;

  console.log('');
  console.log('  TixLock demo data ready');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log(`  ${VENUES.length} venues · ${totalSeats} physical seats · Premium / Gold / Standard`);
  console.log(`  ${t.events} events · ${t.shows} showings · ${t.seats} sellable seats`);
  console.log(`  ${t.confirmed} confirmed bookings · ${t.cancelled} cancelled · revenue ${t.revenue}`);
  console.log(
    `  seat states now: ${t.booked_seats} booked · ${t.held_seats} held · ${t.offered_seats} offered`
  );
  console.log(
    `  waitlist: ${t.waiting} waiting · ${t.offered} live offer(s) · ${t.fulfilled} fulfilled`
  );
  console.log('');
  console.log('  Sign in');
  console.log(`    admin       ${config.adminSeed.email} / ${config.adminSeed.password}`);
  for (const spec of SIGN_IN_USERS) {
    console.log(`    ${spec.role.padEnd(10)}  ${spec.email} / ${spec.password}`);
  }
  console.log(
    `    (plus ${AUDIENCE_USERS.length} audience fixtures on @audience.tixlock.local — not sign-in accounts)`
  );
  console.log('');
  console.log('  Ready-made demo states');
  console.log(
    `    sold out             show ${facts.soldOut.showId} "Arijit Singh Live" — every seat gone, ` +
      `${facts.soldOut.queue.length} customers queued across 3 categories`
  );
  console.log(
    `    trigger auto-assign  cancel ${facts.soldOut.cancellable.ref} ` +
      `(${facts.soldOut.cancellable.seats} ${facts.soldOut.cancellable.category} seats, held by ` +
      `${emailOf(facts.soldOut.cancellable.customer)})`
  );
  console.log(
    `    live offer           ${emailOf(facts.waitlistLoop.openOffer.customer)} holds an open, ` +
      `time-limited offer (${config.offerTtlMinutes} min from now)`
  );
  console.log(
    `    completed loop       ${emailOf(facts.waitlistLoop.fulfilled.customer)} redeemed an offer -> ` +
      `${facts.waitlistLoop.fulfilled.ref}`
  );
  console.log(
    `    live hold            show ${facts.liveHold.showId} seats ${facts.liveHold.seats} held by ` +
      `${emailOf(facts.liveHold.customer)}, expires in ${facts.liveHold.ttlMinutes} min`
  );
  console.log(
    `    plain release        ${facts.plainCancellation.ref} cancelled with an empty queue — ` +
      `${facts.plainCancellation.released} seat back on sale`
  );
  console.log('');
  console.log('  Walkthrough: see DEMO.md');
  console.log('');
}

if (require.main === module) {
  main()
    // Booking and cancellation dispatch their emails on setImmediate. Nothing here can
    // reach a real inbox, but yielding a tick lets the mailer's log lines land before
    // the pool closes, rather than appearing to have been swallowed.
    .then(() => new Promise((resolve) => setTimeout(resolve, 250)))
    .then(() => close())
    .catch(async (err) => {
      console.error('[demo] failed:', err.message);
      if (process.env.DEMO_TRACE) console.error(err.stack);
      process.exitCode = 1;
      await close().catch(() => {});
    });
}

module.exports = { main, wipe, dateFromOffset };
