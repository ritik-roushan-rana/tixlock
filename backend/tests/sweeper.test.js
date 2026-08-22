'use strict';

/**
 * Cron sweeper tests.
 *
 * The scheduled task itself is disabled under NODE_ENV=test (config.sweepEnabled)
 * so nothing fires unpredictably mid-test. Each test invokes runOnce() directly,
 * which is the same function the cron tick calls.
 */

const {
  api, query, truncateAll, closePool, createUser, auth, createBookableShow, getSeat,
} = require('./helpers');
const sweeper = require('../src/jobs/sweeper');

let ctx;
let customerA;
let customerB;

beforeEach(async () => {
  await truncateAll();
  ctx = await createBookableShow({
    layout: [
      { row_label: 'A', seats: 4, category: 'Premium' },
      { row_label: 'B', seats: 4, category: 'Standard' },
    ],
    pricing: { Premium: 500, Standard: 200 },
  });
  customerA = await createUser({ role: 'customer' });
  customerB = await createUser({ role: 'customer' });
});

afterAll(closePool);

const hold = (customer, seatIds) =>
  api().post(`/api/shows/${ctx.show.id}/hold`).set(auth(customer)).send({ seat_ids: seatIds });

/** Force the given held seats past their deadline. */
const expireHeld = (showId) =>
  query(
    "UPDATE show_seats SET hold_expires_at = now() - interval '1 second' WHERE show_id = $1 AND status = 'held'",
    [showId]
  );

describe('expired hold sweep', () => {
  it('releases an expired hold and clears its ownership fields', async () => {
    const seat = ctx.seats[0];
    await hold(customerA, [seat.id]);
    await expireHeld(ctx.show.id);

    const summary = await sweeper.runOnce({ quiet: true });
    expect(summary.holdsReleased).toBe(1);

    const row = await getSeat(seat.id);
    expect(row.status).toBe('available');
    expect(row.held_by).toBeNull();
    expect(row.hold_expires_at).toBeNull();
  });

  it('leaves a live hold alone', async () => {
    const seat = ctx.seats[0];
    await hold(customerA, [seat.id]);

    const summary = await sweeper.runOnce({ quiet: true });
    expect(summary.holdsReleased).toBe(0);

    const row = await getSeat(seat.id);
    expect(row.status).toBe('held');
    expect(row.held_by).toBe(customerA.id);
  });

  it('releases several expired holds in one pass', async () => {
    await hold(customerA, ctx.seats.slice(0, 3).map((s) => s.id));
    await hold(customerB, [ctx.seats[4].id]);
    await expireHeld(ctx.show.id);

    const summary = await sweeper.runOnce({ quiet: true });
    expect(summary.holdsReleased).toBe(4);

    const { rows } = await query(
      "SELECT count(*)::int AS n FROM show_seats WHERE show_id=$1 AND status='available'",
      [ctx.show.id]
    );
    expect(rows[0].n).toBe(8);
  });

  it('never touches a booked seat', async () => {
    const seat = ctx.seats[0];
    await query("UPDATE show_seats SET status='booked' WHERE id=$1", [seat.id]);

    await sweeper.runOnce({ quiet: true });
    expect((await getSeat(seat.id)).status).toBe('booked');
  });

  it('is idempotent — a second pass finds nothing left to do', async () => {
    await hold(customerA, [ctx.seats[0].id]);
    await expireHeld(ctx.show.id);

    expect((await sweeper.runOnce({ quiet: true })).holdsReleased).toBe(1);
    expect((await sweeper.runOnce({ quiet: true })).holdsReleased).toBe(0);
  });

  it('does nothing when there is nothing to sweep', async () => {
    const summary = await sweeper.runOnce({ quiet: true });
    expect(summary).toMatchObject({ holdsReleased: 0, offersExpired: 0 });
  });

  it('makes a swept seat immediately holdable by another customer', async () => {
    const seat = ctx.seats[0];
    await hold(customerA, [seat.id]);
    await expireHeld(ctx.show.id);
    await sweeper.runOnce({ quiet: true });

    const res = await hold(customerB, [seat.id]);
    expect(res.status).toBe(201);
    expect((await getSeat(seat.id)).held_by).toBe(customerB.id);
  });

  it('sweeps expired holds across multiple shows in one pass', async () => {
    const other = await createBookableShow({
      layout: [{ row_label: 'Z', seats: 2, category: 'Premium' }],
      pricing: { Premium: 100 },
      date: '2027-03-03',
    });

    await hold(customerA, [ctx.seats[0].id]);
    await api()
      .post(`/api/shows/${other.show.id}/hold`)
      .set(auth(customerB))
      .send({ seat_ids: [other.seats[0].id] });

    await query(
      "UPDATE show_seats SET hold_expires_at = now() - interval '1 second' WHERE status='held'"
    );

    const summary = await sweeper.runOnce({ quiet: true });
    expect(summary.holdsReleased).toBe(2);
  });

  it('does not block on a seat locked by an in-flight transaction (SKIP LOCKED)', async () => {
    const { pool } = require('../src/config/db');
    const seat = ctx.seats[0];
    await hold(customerA, [seat.id]);
    await expireHeld(ctx.show.id);

    // Hold a row lock on that seat in a separate connection, mimicking a booking
    // transaction in progress.
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM show_seats WHERE id = $1 FOR UPDATE', [seat.id]);

      // The sweep must return promptly having skipped the locked row, rather than
      // queueing behind the lock.
      const started = Date.now();
      const summary = await sweeper.runOnce({ quiet: true });
      const elapsed = Date.now() - started;

      expect(summary.holdsReleased).toBe(0);
      expect(elapsed).toBeLessThan(3000);

      await blocker.query('ROLLBACK');
    } finally {
      blocker.release();
    }

    // Once the lock is gone the next pass collects it.
    expect((await sweeper.runOnce({ quiet: true })).holdsReleased).toBe(1);
  });
});

describe('expired holds respect a waiting queue', () => {
  /**
   * Every seat release — cancellation or hold expiry — consults the waitlist.
   * Without this, an abandoned checkout would put the seat back on general sale
   * while customers were still queued for that category, letting whoever refreshed
   * fastest take it ahead of them.
   */
  it('offers an abandoned hold to a waiting customer instead of releasing it', async () => {
    const seat = ctx.seats[0]; // Premium

    // Sell out Premium so a waitlist join is permitted, leaving `seat` in play.
    await query(
      "UPDATE show_seats SET status='booked' WHERE show_id=$1 AND category='Premium' AND id <> $2",
      [ctx.show.id, seat.id]
    );
    await hold(customerA, [seat.id]);

    await api()
      .post('/api/waitlist')
      .set(auth(customerB))
      .send({ show_id: ctx.show.id, category: 'Premium' })
      .expect(201);

    // customerA walks away.
    await expireHeld(ctx.show.id);
    const summary = await sweeper.runOnce({ quiet: true });

    expect(summary.holdsReleased).toBe(0);
    expect(summary.holdsOfferedToWaitlist).toBe(1);

    const row = await getSeat(seat.id);
    expect(row.status).toBe('offered');
    expect(row.held_by).toBe(customerB.id);
  });

  it('still releases to available when nobody is waiting', async () => {
    const seat = ctx.seats[0];
    await hold(customerA, [seat.id]);
    await expireHeld(ctx.show.id);

    const summary = await sweeper.runOnce({ quiet: true });
    expect(summary.holdsReleased).toBe(1);
    expect(summary.holdsOfferedToWaitlist).toBe(0);
    expect((await getSeat(seat.id)).status).toBe('available');
  });
});

describe('sweeper scheduling', () => {
  it('is disabled under NODE_ENV=test so tests stay deterministic', () => {
    const config = require('../src/config/env');
    expect(config.sweepEnabled).toBe(false);
    expect(sweeper.start()).toBeNull();
  });

  it('uses a 15-second schedule by default', () => {
    const config = require('../src/config/env');
    expect(config.sweepCron).toBe('*/15 * * * * *');
  });
});
