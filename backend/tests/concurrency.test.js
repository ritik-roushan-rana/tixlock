'use strict';

/**
 * Concurrency tests — the primary evaluation focus.
 *
 * These fire genuinely parallel HTTP requests with Promise.all against a real
 * PostgreSQL database. There are no mocks anywhere in this file, deliberately: the
 * property under test is that PostgreSQL's row locking serialises two overlapping
 * transactions, and a mocked client would report success while the real race
 * remained open.
 *
 * Every test asserts on the database state afterwards as well as on the HTTP
 * responses, because "exactly one 201" is only half the claim — the seat must also
 * end up held by exactly the customer who got that 201.
 */

const {
  api, query, truncateAll, closePool, createUser, auth, createBookableShow, getSeat,
} = require('./helpers');

let ctx;
let customers;

beforeEach(async () => {
  await truncateAll();
  ctx = await createBookableShow({
    layout: [
      { row_label: 'A', seats: 5, category: 'Premium' },
      { row_label: 'B', seats: 5, category: 'Standard' },
    ],
    pricing: { Premium: 500, Standard: 200 },
  });
  // Ten distinct customers so a ten-way race has ten different identities.
  customers = [];
  for (let i = 0; i < 10; i += 1) customers.push(await createUser({ role: 'customer' }));
});

afterAll(closePool);

const hold = (customer, seatIds) =>
  api().post(`/api/shows/${ctx.show.id}/hold`).set(auth(customer)).send({ seat_ids: seatIds });

const summarise = (results) => ({
  created: results.filter((r) => r.status === 201).length,
  conflicts: results.filter((r) => r.status === 409).length,
  other: results.filter((r) => r.status !== 201 && r.status !== 409).map((r) => r.status),
});

describe('two simultaneous holds on the same seat', () => {
  it('lets exactly one succeed and rejects the other with 409', async () => {
    const seat = ctx.seats[0];

    const [a, b] = await Promise.all([hold(customers[0], [seat.id]), hold(customers[1], [seat.id])]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    // Whoever won must actually own the seat in the database.
    const winner = a.status === 201 ? customers[0] : customers[1];
    const row = await getSeat(seat.id);
    expect(row.status).toBe('held');
    expect(row.held_by).toBe(winner.id);
    expect(row.hold_expires_at).not.toBeNull();
  });

  it('tells the loser which seat it lost', async () => {
    const seat = ctx.seats[0];
    const results = await Promise.all([hold(customers[0], [seat.id]), hold(customers[1], [seat.id])]);
    const loser = results.find((r) => r.status === 409);

    expect(loser.body.error.code).toBe('SEATS_UNAVAILABLE');
    expect(loser.body.error.details.unavailableSeatIds).toEqual([seat.id]);
  });
});

describe('N-way races', () => {
  it.each([2, 5, 10])('with %i parallel requests for one seat, exactly one wins', async (n) => {
    const seat = ctx.seats[0];

    const results = await Promise.all(customers.slice(0, n).map((c) => hold(c, [seat.id])));
    const summary = summarise(results);

    expect(summary).toEqual({ created: 1, conflicts: n - 1, other: [] });

    const { rows } = await query(
      "SELECT count(*)::int AS n FROM show_seats WHERE id = $1 AND status = 'held'",
      [seat.id]
    );
    expect(rows[0].n).toBe(1);
  });

  it('is repeatable — 10 consecutive 5-way races each produce exactly one winner', async () => {
    for (let round = 0; round < 10; round += 1) {
      // Fresh seat each round so rounds cannot influence each other.
      const seat = ctx.seats[round % ctx.seats.length];
      await query(
        "UPDATE show_seats SET status='available', held_by=NULL, hold_expires_at=NULL WHERE id=$1",
        [seat.id]
      );

      const results = await Promise.all(customers.slice(0, 5).map((c) => hold(c, [seat.id])));
      expect(summarise(results)).toEqual({ created: 1, conflicts: 4, other: [] });
    }
  });

  it('never oversells: 10 customers racing for 10 distinct seats all succeed', async () => {
    // Disjoint requests must not block each other — row locks are per row, so
    // there is no contention and no false conflict.
    const results = await Promise.all(customers.map((c, i) => hold(c, [ctx.seats[i].id])));

    expect(summarise(results)).toEqual({ created: 10, conflicts: 0, other: [] });

    const { rows } = await query(
      "SELECT count(*)::int AS held, count(DISTINCT held_by)::int AS holders FROM show_seats WHERE show_id=$1 AND status='held'",
      [ctx.show.id]
    );
    expect(rows[0]).toEqual({ held: 10, holders: 10 });
  });

  it('10 customers racing for the same 3 seats: one wins all 3, nine get nothing', async () => {
    const seatIds = ctx.seats.slice(0, 3).map((s) => s.id);

    const results = await Promise.all(customers.map((c) => hold(c, seatIds)));
    expect(summarise(results)).toEqual({ created: 1, conflicts: 9, other: [] });

    // All three seats must belong to the single winner — not split between racers.
    const { rows } = await query(
      `SELECT count(*)::int AS held, count(DISTINCT held_by)::int AS holders
         FROM show_seats WHERE id = ANY($1::int[]) AND status = 'held'`,
      [seatIds]
    );
    expect(rows[0]).toEqual({ held: 3, holders: 1 });
  });
});

describe('all-or-nothing across a multi-seat request', () => {
  it('holds nothing when one seat in the set is already taken', async () => {
    const [s1, s2, s3] = ctx.seats;

    // customers[0] takes the middle seat first.
    expect((await hold(customers[0], [s2.id])).status).toBe(201);

    const res = await hold(customers[1], [s1.id, s2.id, s3.id]);
    expect(res.status).toBe(409);
    expect(res.body.error.details.unavailableSeatIds).toEqual([s2.id]);

    // The two seats that *were* available must be untouched, not partially held.
    expect((await getSeat(s1.id)).status).toBe('available');
    expect((await getSeat(s1.id)).held_by).toBeNull();
    expect((await getSeat(s3.id)).status).toBe('available');
    expect((await getSeat(s3.id)).held_by).toBeNull();
  });

  it('holds nothing when a seat is already booked', async () => {
    const [s1, s2] = ctx.seats;
    await query("UPDATE show_seats SET status='booked' WHERE id=$1", [s2.id]);

    const res = await hold(customers[0], [s1.id, s2.id]);
    expect(res.status).toBe(409);
    expect((await getSeat(s1.id)).status).toBe('available');
  });

  it('rolls back cleanly under partial overlap between two parallel requests', async () => {
    const [s1, s2, s3, s4] = ctx.seats;

    // Overlapping on s2/s3. Exactly one must win; the other must hold nothing.
    const [a, b] = await Promise.all([
      hold(customers[0], [s1.id, s2.id, s3.id]),
      hold(customers[1], [s2.id, s3.id, s4.id]),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);

    const { rows } = await query(
      `SELECT count(*)::int AS held, count(DISTINCT held_by)::int AS holders
         FROM show_seats WHERE show_id = $1 AND status = 'held'`,
      [ctx.show.id]
    );
    // Exactly one winner holding exactly its own 3 seats.
    expect(rows[0]).toEqual({ held: 3, holders: 1 });
  });

  it('does not deadlock when two requests ask for the same seats in opposite order', async () => {
    // holdService sorts seat ids before locking, so both transactions walk the
    // rows in the same sequence and the second queues rather than deadlocking.
    const ids = ctx.seats.slice(0, 5).map((s) => s.id);
    const forwards = [...ids];
    const backwards = [...ids].reverse();

    const results = await Promise.all([
      hold(customers[0], forwards),
      hold(customers[1], backwards),
      hold(customers[2], forwards),
      hold(customers[3], backwards),
    ]);

    // A deadlock would surface as a 409 from the deadlock mapping or a 500 —
    // assert specifically that nothing failed unexpectedly.
    expect(summarise(results)).toEqual({ created: 1, conflicts: 3, other: [] });
  });

  it('treats a duplicated seat id in one request as a single seat', async () => {
    const seat = ctx.seats[0];
    const res = await hold(customers[0], [seat.id, seat.id, seat.id]);

    // Without de-duplication the row-count check would compare 1 locked row
    // against 3 requested and wrongly return 409.
    expect(res.status).toBe(201);
    expect(res.body.seat_ids).toEqual([seat.id]);
  });
});

describe('hold expiry is enforced by the database, not by the sweeper', () => {
  it('allows another customer to claim a seat whose hold has lapsed, before any sweep', async () => {
    const seat = ctx.seats[0];
    expect((await hold(customers[0], [seat.id])).status).toBe(201);

    // Push the deadline into the past. The row still reads 'held'.
    await query("UPDATE show_seats SET hold_expires_at = now() - interval '1 second' WHERE id=$1", [
      seat.id,
    ]);
    expect((await getSeat(seat.id)).status).toBe('held');

    // No sweep has run, yet the seat must be claimable.
    const res = await hold(customers[1], [seat.id]);
    expect(res.status).toBe(201);

    const row = await getSeat(seat.id);
    expect(row.held_by).toBe(customers[1].id);
  });

  it('still rejects a seat whose hold is live', async () => {
    const seat = ctx.seats[0];
    await hold(customers[0], [seat.id]);
    const res = await hold(customers[1], [seat.id]);
    expect(res.status).toBe(409);
  });

  it('lets two customers race for an expired seat with exactly one winner', async () => {
    const seat = ctx.seats[0];
    await hold(customers[0], [seat.id]);
    await query("UPDATE show_seats SET hold_expires_at = now() - interval '1 second' WHERE id=$1", [
      seat.id,
    ]);

    const results = await Promise.all([hold(customers[1], [seat.id]), hold(customers[2], [seat.id])]);
    expect(summarise(results)).toEqual({ created: 1, conflicts: 1, other: [] });
  });
});

describe('hold response and scoping', () => {
  it('returns the server-computed deadline and TTL', async () => {
    const before = Date.now();
    const res = await hold(customers[0], [ctx.seats[0].id]);

    expect(res.status).toBe(201);
    expect(res.body.hold_ttl_minutes).toBe(10);

    const expiry = new Date(res.body.hold_expires_at).getTime();
    // Roughly now + 10 minutes, allowing generous slack for test timing.
    expect(expiry).toBeGreaterThan(before + 9 * 60 * 1000);
    expect(expiry).toBeLessThan(before + 11 * 60 * 1000);
  });

  it('refuses a seat belonging to a different show', async () => {
    const other = await createBookableShow({
      layout: [{ row_label: 'Z', seats: 2, category: 'Premium' }],
      pricing: { Premium: 100 },
      date: '2027-01-01',
    });

    const res = await hold(customers[0], [other.seats[0].id]);
    expect(res.status).toBe(409);
    expect((await getSeat(other.seats[0].id)).status).toBe('available');
  });

  it('rejects an anonymous hold with 401', async () => {
    const res = await api()
      .post(`/api/shows/${ctx.show.id}/hold`)
      .send({ seat_ids: [ctx.seats[0].id] });
    expect(res.status).toBe(401);
  });

  it('rejects a hold by an organiser with 403', async () => {
    const res = await hold(ctx.organiser, [ctx.seats[0].id]);
    expect(res.status).toBe(403);
  });

  it('ignores a client-supplied customer_id and uses the token identity', async () => {
    const seat = ctx.seats[0];
    const res = await api()
      .post(`/api/shows/${ctx.show.id}/hold`)
      .set(auth(customers[0]))
      .send({ seat_ids: [seat.id], customer_id: customers[5].id });

    expect(res.status).toBe(201);
    expect((await getSeat(seat.id)).held_by).toBe(customers[0].id);
  });

  it('returns 404 for an unknown show', async () => {
    const res = await api()
      .post('/api/shows/999999/hold')
      .set(auth(customers[0]))
      .send({ seat_ids: [1] });
    expect(res.status).toBe(404);
  });

  it.each([
    ['empty array', []],
    ['not an array', 'nope'],
    ['non-numeric id', ['abc']],
    ['zero id', [0]],
    ['too many seats', Array.from({ length: 11 }, (_, i) => i + 1)],
  ])('rejects invalid seat_ids: %s', async (_label, seatIds) => {
    const res = await hold(customers[0], seatIds);
    expect(res.status).toBe(400);
  });
});

describe('releasing a hold', () => {
  it('releases the caller’s own hold and frees the seat', async () => {
    const seat = ctx.seats[0];
    await hold(customers[0], [seat.id]);

    const res = await api()
      .delete(`/api/shows/${ctx.show.id}/hold`)
      .set(auth(customers[0]))
      .send({ seat_ids: [seat.id] });

    expect(res.status).toBe(200);
    expect(res.body.released).toBe(1);

    const row = await getSeat(seat.id);
    expect(row.status).toBe('available');
    expect(row.held_by).toBeNull();
    expect(row.hold_expires_at).toBeNull();
  });

  it('cannot release someone else’s hold', async () => {
    const seat = ctx.seats[0];
    await hold(customers[0], [seat.id]);

    const res = await api()
      .delete(`/api/shows/${ctx.show.id}/hold`)
      .set(auth(customers[1]))
      .send({ seat_ids: [seat.id] });

    expect(res.status).toBe(200);
    expect(res.body.released).toBe(0);

    // Still held by the original owner.
    expect((await getSeat(seat.id)).held_by).toBe(customers[0].id);
  });

  it('releases all of the caller’s holds when no seat_ids are given', async () => {
    const ids = ctx.seats.slice(0, 3).map((s) => s.id);
    await hold(customers[0], ids);

    const res = await api().delete(`/api/shows/${ctx.show.id}/hold`).set(auth(customers[0])).send({});
    expect(res.body.released).toBe(3);

    const { rows } = await query(
      "SELECT count(*)::int AS n FROM show_seats WHERE show_id=$1 AND status='held'",
      [ctx.show.id]
    );
    expect(rows[0].n).toBe(0);
  });

  it('frees a seat for another customer immediately after release', async () => {
    const seat = ctx.seats[0];
    await hold(customers[0], [seat.id]);
    await api().delete(`/api/shows/${ctx.show.id}/hold`).set(auth(customers[0])).send({});

    expect((await hold(customers[1], [seat.id])).status).toBe(201);
  });
});

describe('GET my-holds', () => {
  it('returns the caller’s live holds with the server deadline', async () => {
    const ids = ctx.seats.slice(0, 2).map((s) => s.id);
    await hold(customers[0], ids);

    const res = await api().get(`/api/shows/${ctx.show.id}/my-holds`).set(auth(customers[0]));
    expect(res.status).toBe(200);
    expect(res.body.seats.map((s) => s.id).sort((a, b) => a - b)).toEqual(ids);
    expect(res.body.hold_expires_at).toEqual(expect.any(String));
  });

  it('excludes expired holds', async () => {
    await hold(customers[0], [ctx.seats[0].id]);
    // Scoped to held rows only: show_seats_hold_fields_consistent forbids an
    // 'available' seat from carrying a hold deadline, so an unscoped update here
    // is rejected by the database — correctly.
    await query(
      "UPDATE show_seats SET hold_expires_at = now() - interval '1 minute' WHERE show_id=$1 AND status='held'",
      [ctx.show.id]
    );

    const res = await api().get(`/api/shows/${ctx.show.id}/my-holds`).set(auth(customers[0]));
    expect(res.body.seats).toEqual([]);
  });

  it('does not return another customer’s holds', async () => {
    await hold(customers[0], [ctx.seats[0].id]);
    const res = await api().get(`/api/shows/${ctx.show.id}/my-holds`).set(auth(customers[1]));
    expect(res.body.seats).toEqual([]);
  });
});
