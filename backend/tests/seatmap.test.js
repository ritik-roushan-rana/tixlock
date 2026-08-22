'use strict';

const { api, query, truncateAll, closePool, createUser, auth, createBookableShow } = require('./helpers');

let ctx;
let customerA;
let customerB;

beforeEach(async () => {
  await truncateAll();
  ctx = await createBookableShow({
    layout: [
      { row_label: 'A', seats: 3, category: 'Premium' },
      { row_label: 'B', seats: 3, category: 'Standard' },
    ],
    pricing: { Premium: 500, Standard: 200 },
  });
  customerA = await createUser({ role: 'customer' });
  customerB = await createUser({ role: 'customer' });
});

afterAll(closePool);

/** Set a seat's hold state directly, bypassing the API and the sweeper. */
function forceHold(seatId, userId, interval) {
  return query(
    `UPDATE show_seats
        SET status = 'held', held_by = $2, hold_expires_at = now() + $3::interval
      WHERE id = $1`,
    [seatId, userId, interval]
  );
}

describe('GET /api/shows/:id/seats', () => {
  it('returns every seat grouped into rows, with prices', async () => {
    const res = await api().get(`/api/shows/${ctx.show.id}/seats`);

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0].row_label).toBe('A');
    expect(res.body.rows[0].seats).toHaveLength(3);
    expect(res.body.rows[0].seats[0]).toMatchObject({
      row_label: 'A',
      seat_number: 1,
      category: 'Premium',
      status: 'available',
      price: '500.00',
    });
    expect(res.body.summary).toMatchObject({ total: 6, available: 6, held: 0, booked: 0 });
  });

  it('is readable anonymously', async () => {
    const res = await api().get(`/api/shows/${ctx.show.id}/seats`);
    expect(res.status).toBe(200);
    // With no viewer, nothing can be "mine".
    expect(res.body.rows[0].seats.every((s) => s.held_by_me === false)).toBe(true);
  });

  it('includes show, venue and pricing context', async () => {
    const res = await api().get(`/api/shows/${ctx.show.id}/seats`);
    expect(res.body.show.event.title).toBe('Test Event');
    expect(res.body.show.venue.name).toBe('Test Venue');
    expect(res.body.pricing).toEqual([
      { category: 'Premium', price: '500.00' },
      { category: 'Standard', price: '200.00' },
    ]);
    expect(res.body.server_time).toEqual(expect.any(String));
  });

  it('distinguishes held-by-you from held-by-others without leaking identity', async () => {
    const mine = ctx.seats[0];
    const theirs = ctx.seats[1];
    await forceHold(mine.id, customerA.id, '10 minutes');
    await forceHold(theirs.id, customerB.id, '10 minutes');

    const res = await api().get(`/api/shows/${ctx.show.id}/seats`).set(auth(customerA));
    const seats = res.body.rows.flatMap((r) => r.seats);
    const mineSeat = seats.find((s) => s.id === mine.id);
    const theirSeat = seats.find((s) => s.id === theirs.id);

    expect(mineSeat).toMatchObject({ status: 'held', held_by_me: true });
    expect(theirSeat).toMatchObject({ status: 'held', held_by_me: false });

    // The other holder's user id must not appear anywhere in the payload.
    expect(JSON.stringify(res.body)).not.toContain(`"held_by"`);
    expect(theirSeat.my_hold_expires_at).toBeNull();
  });

  it('reports an expired hold as available even though the row still says held', async () => {
    const seat = ctx.seats[0];
    await forceHold(seat.id, customerA.id, '-1 minute');

    // The stored row is still 'held' — the sweeper has not run.
    const { rows } = await query('SELECT status FROM show_seats WHERE id = $1', [seat.id]);
    expect(rows[0].status).toBe('held');

    const res = await api().get(`/api/shows/${ctx.show.id}/seats`).set(auth(customerB));
    const found = res.body.rows.flatMap((r) => r.seats).find((s) => s.id === seat.id);

    expect(found.status).toBe('available');
    expect(found.held_by_me).toBe(false);
    expect(res.body.summary.available).toBe(6);
  });

  it('does not treat an expired hold as still mine', async () => {
    const seat = ctx.seats[0];
    await forceHold(seat.id, customerA.id, '-1 minute');

    const res = await api().get(`/api/shows/${ctx.show.id}/seats`).set(auth(customerA));
    const found = res.body.rows.flatMap((r) => r.seats).find((s) => s.id === seat.id);

    expect(found.status).toBe('available');
    expect(found.held_by_me).toBe(false);
  });

  it('reports booked seats as booked', async () => {
    const seat = ctx.seats[0];
    await query("UPDATE show_seats SET status = 'booked' WHERE id = $1", [seat.id]);

    const res = await api().get(`/api/shows/${ctx.show.id}/seats`);
    const found = res.body.rows.flatMap((r) => r.seats).find((s) => s.id === seat.id);
    expect(found.status).toBe('booked');
    expect(res.body.summary).toMatchObject({ booked: 1, available: 5 });
  });

  it('returns 404 for an unknown show', async () => {
    const res = await api().get('/api/shows/999999/seats');
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-numeric show id', async () => {
    const res = await api().get('/api/shows/abc/seats');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/shows/:id/availability', () => {
  it('reports per-category counts', async () => {
    const res = await api().get(`/api/shows/${ctx.show.id}/availability`);
    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual([
      { category: 'Premium', price: '500.00', total: 3, available: 3, booked: 0, sold_out: false },
      { category: 'Standard', price: '200.00', total: 3, available: 3, booked: 0, sold_out: false },
    ]);
  });

  it('flags a category as sold out when every seat is booked', async () => {
    await query("UPDATE show_seats SET status='booked' WHERE show_id=$1 AND category='Premium'", [
      ctx.show.id,
    ]);

    const res = await api().get(`/api/shows/${ctx.show.id}/availability`);
    const premium = res.body.categories.find((c) => c.category === 'Premium');
    expect(premium).toMatchObject({ available: 0, booked: 3, sold_out: true });
  });

  it('does not count an expired hold against availability', async () => {
    await query(
      `UPDATE show_seats SET status='held', held_by=$1, hold_expires_at = now() - interval '5 minutes'
        WHERE show_id=$2 AND category='Premium'`,
      [customerA.id, ctx.show.id]
    );

    const res = await api().get(`/api/shows/${ctx.show.id}/availability`);
    const premium = res.body.categories.find((c) => c.category === 'Premium');
    expect(premium).toMatchObject({ available: 3, sold_out: false });
  });
});
