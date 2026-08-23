'use strict';

/**
 * Waitlist and cancellation tests.
 *
 * The scenario that matters most is the cascade: A and B both waiting, a seat is
 * released, A is offered it, A does nothing, and the seat must pass to B rather than
 * going back on general sale. That is asserted end to end below.
 */

const {
  api, query, truncateAll, closePool, createUser, auth, createBookableShow, getSeat,
} = require('./helpers');
const sweeper = require('../src/jobs/sweeper');
const mailer = require('../src/services/mailer');

let ctx;
let owner;   // books the seats that later get cancelled
let alice;   // first in the queue
let bob;     // second in the queue
let carol;   // third

/** A tiny show so a category can be sold out by hand. */
beforeEach(async () => {
  await truncateAll();
  mailer.clearOutbox();
  ctx = await createBookableShow({
    layout: [
      { row_label: 'A', seats: 2, category: 'Premium' },
      { row_label: 'B', seats: 2, category: 'Standard' },
    ],
    pricing: { Premium: 500, Standard: 200 },
  });
  owner = await createUser({ role: 'customer', name: 'Owner' });
  alice = await createUser({ role: 'customer', name: 'Alice' });
  bob = await createUser({ role: 'customer', name: 'Bob' });
  carol = await createUser({ role: 'customer', name: 'Carol' });
});

afterAll(closePool);

const premium = () => ctx.seats.filter((s) => s.category === 'Premium');
const standard = () => ctx.seats.filter((s) => s.category === 'Standard');

const hold = (customer, seatIds) =>
  api().post(`/api/shows/${ctx.show.id}/hold`).set(auth(customer)).send({ seat_ids: seatIds });

const book = (customer, seatIds) =>
  api().post('/api/bookings').set(auth(customer)).send({ show_id: ctx.show.id, seat_ids: seatIds });

const join = (customer, category = 'Premium') =>
  api().post('/api/waitlist').set(auth(customer)).send({ show_id: ctx.show.id, category });

const cancel = (customer, bookingId) =>
  api().post(`/api/bookings/${bookingId}/cancel`).set(auth(customer));

const flush = () => new Promise((r) => setTimeout(r, 80));

/** Book every Premium seat as `owner`, returning the booking id. */
async function sellOutPremium() {
  const ids = premium().map((s) => s.id);
  await hold(owner, ids);
  const res = await book(owner, ids);
  expect(res.status).toBe(201);
  return res.body.booking.id;
}

/** Push all live offers past their deadline without running the sweeper. */
const expireOffers = () =>
  query(
    "UPDATE show_seats SET hold_expires_at = now() - interval '1 second' WHERE status = 'offered'"
  );

describe('joining the waitlist', () => {
  it('accepts a join once the category is sold out', async () => {
    await sellOutPremium();

    const res = await join(alice);
    expect(res.status).toBe(201);
    expect(res.body.waitlist).toMatchObject({
      show_id: ctx.show.id,
      category: 'Premium',
      status: 'waiting',
      position: 1,
    });
  });

  it('refuses a join while seats are still available', async () => {
    const res = await join(alice);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/still has 2 seat\(s\) available/i);
  });

  it('reports increasing queue positions in join order', async () => {
    await sellOutPremium();

    expect((await join(alice)).body.waitlist.position).toBe(1);
    expect((await join(bob)).body.waitlist.position).toBe(2);
    expect((await join(carol)).body.waitlist.position).toBe(3);
  });

  it('rejects a duplicate active entry for the same customer', async () => {
    await sellOutPremium();
    expect((await join(alice)).status).toBe(201);

    const second = await join(alice);
    expect(second.status).toBe(409);
    expect(second.body.error.message).toMatch(/already on the waitlist/i);
  });

  it('rejects a category the show does not have', async () => {
    await sellOutPremium();
    const res = await join(alice, 'SkyBox');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/no "SkyBox" seats/i);
  });

  it('rejects an unknown show', async () => {
    const res = await api()
      .post('/api/waitlist')
      .set(auth(alice))
      .send({ show_id: 999999, category: 'Premium' });
    expect(res.status).toBe(404);
  });

  it('rejects an organiser joining a waitlist', async () => {
    await sellOutPremium();
    const res = await api()
      .post('/api/waitlist')
      .set(auth(ctx.organiser))
      .send({ show_id: ctx.show.id, category: 'Premium' });
    expect(res.status).toBe(403);
  });

  it('treats a category as sold out even if a hold has expired but not been swept', async () => {
    // Both Premium seats held, then expired. Effective availability is 2, so the
    // join must still be refused.
    await hold(owner, premium().map((s) => s.id));
    await query(
      "UPDATE show_seats SET hold_expires_at = now() - interval '1 min' WHERE status = 'held'"
    );

    const res = await join(alice);
    expect(res.status).toBe(409);
  });

  it('lets a customer leave the queue', async () => {
    await sellOutPremium();
    const entry = (await join(alice)).body.waitlist;

    const res = await api().delete(`/api/waitlist/${entry.id}`).set(auth(alice));
    expect(res.status).toBe(200);
    expect((await query('SELECT count(*)::int AS n FROM waitlist')).rows[0].n).toBe(0);
  });

  it('cannot leave someone else’s queue entry', async () => {
    await sellOutPremium();
    const entry = (await join(alice)).body.waitlist;

    const res = await api().delete(`/api/waitlist/${entry.id}`).set(auth(bob));
    expect(res.status).toBe(409);
    expect((await query('SELECT count(*)::int AS n FROM waitlist')).rows[0].n).toBe(1);
  });
});

describe('cancellation with an empty waitlist', () => {
  it('returns the seats to general sale', async () => {
    const bookingId = await sellOutPremium();

    const res = await cancel(owner, bookingId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'cancelled',
      seats_released: 2,
      seats_offered_to_waitlist: 0,
    });

    for (const seat of premium()) {
      const row = await getSeat(seat.id);
      expect(row.status).toBe('available');
      expect(row.held_by).toBeNull();
      expect(row.hold_expires_at).toBeNull();
    }
  });

  it('marks the booking cancelled with a timestamp', async () => {
    const bookingId = await sellOutPremium();
    await cancel(owner, bookingId);

    const { rows } = await query(
      'SELECT status::text AS status, cancelled_at FROM bookings WHERE id = $1',
      [bookingId]
    );
    expect(rows[0].status).toBe('cancelled');
    expect(rows[0].cancelled_at).not.toBeNull();
  });

  it('rejects a second cancellation', async () => {
    const bookingId = await sellOutPremium();
    await cancel(owner, bookingId);

    const res = await cancel(owner, bookingId);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already been cancelled/i);
  });

  it('creates exactly one cancellation under a double-clicked button', async () => {
    const bookingId = await sellOutPremium();

    const results = await Promise.all([cancel(owner, bookingId), cancel(owner, bookingId)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('cannot cancel another customer’s booking', async () => {
    const bookingId = await sellOutPremium();

    const res = await cancel(alice, bookingId);
    expect(res.status).toBe(404);

    const { rows } = await query('SELECT status::text AS status FROM bookings WHERE id = $1', [
      bookingId,
    ]);
    expect(rows[0].status).toBe('confirmed');
  });

  it('makes released seats immediately holdable again', async () => {
    const bookingId = await sellOutPremium();
    await cancel(owner, bookingId);

    const res = await hold(alice, [premium()[0].id]);
    expect(res.status).toBe(201);
  });
});

describe('cancellation offers to the waitlist instead of releasing', () => {
  it('offers a released seat to the single waiting customer', async () => {
    const bookingId = await sellOutPremium();
    await join(alice);

    const res = await cancel(owner, bookingId);
    expect(res.body.seats_offered_to_waitlist).toBe(1);
    expect(res.body.seats_released).toBe(1); // only one person waiting, so the other seat is freed

    // Exactly one seat is reserved for Alice.
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM show_seats
        WHERE show_id=$1 AND status='offered' AND held_by=$2`,
      [ctx.show.id, alice.id]
    );
    expect(rows[0].n).toBe(1);

    const { rows: wl } = await query(
      "SELECT status::text AS status, offer_token, offer_expires_at, offered_show_seat_id FROM waitlist WHERE customer_id=$1",
      [alice.id]
    );
    expect(wl[0].status).toBe('offered');
    expect(wl[0].offer_token).toEqual(expect.any(String));
    expect(wl[0].offer_expires_at).not.toBeNull();
    expect(wl[0].offered_show_seat_id).not.toBeNull();
  });

  it('never leaves a waitlisted seat momentarily available for a passer-by', async () => {
    const bookingId = await sellOutPremium();
    await join(alice);
    await cancel(owner, bookingId);

    // The offered seat must not be holdable by anyone else.
    const offered = (
      await query("SELECT id FROM show_seats WHERE status='offered' AND held_by=$1", [alice.id])
    ).rows[0];

    const res = await hold(bob, [offered.id]);
    expect(res.status).toBe(409);
  });

  it('uses the longer offer TTL, not the hold TTL', async () => {
    const bookingId = await sellOutPremium();
    await join(alice);
    const before = Date.now();
    await cancel(owner, bookingId);

    const { rows } = await query(
      "SELECT hold_expires_at FROM show_seats WHERE status='offered' AND held_by=$1",
      [alice.id]
    );
    const expiry = new Date(rows[0].hold_expires_at).getTime();

    // OFFER_TTL_MINUTES defaults to 30, well beyond the 10-minute hold TTL.
    expect(expiry).toBeGreaterThan(before + 25 * 60 * 1000);
    expect(expiry).toBeLessThan(before + 35 * 60 * 1000);
  });

  it('distributes several released seats to the queue in FIFO order', async () => {
    const bookingId = await sellOutPremium(); // 2 Premium seats
    await join(alice);
    await join(bob);

    const res = await cancel(owner, bookingId);
    expect(res.body.seats_offered_to_waitlist).toBe(2);
    expect(res.body.seats_released).toBe(0);

    // Both got one, nobody got two.
    const { rows } = await query(
      `SELECT held_by, count(*)::int AS n FROM show_seats
        WHERE show_id=$1 AND status='offered' GROUP BY held_by ORDER BY held_by`,
      [ctx.show.id]
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.n)).toEqual([1, 1]);
    expect(rows.map((r) => r.held_by).sort((a, b) => a - b)).toEqual(
      [alice.id, bob.id].sort((a, b) => a - b)
    );
  });

  it('respects join order when there are fewer seats than waiting customers', async () => {
    // Sell one Premium seat only, so cancelling releases exactly one.
    const [p1, p2] = premium();
    await hold(owner, [p1.id]);
    const bookingId = (await book(owner, [p1.id])).body.booking.id;
    // Take the other Premium seat out of circulation so the category is sold out.
    await query("UPDATE show_seats SET status='booked' WHERE id=$1", [p2.id]);

    await join(alice); // first
    await join(bob);   // second
    await join(carol); // third

    await cancel(owner, bookingId);

    // Alice, the earliest joiner, must be the one offered the seat.
    const { rows } = await query(
      "SELECT held_by FROM show_seats WHERE show_id=$1 AND status='offered'",
      [ctx.show.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].held_by).toBe(alice.id);

    const { rows: statuses } = await query(
      `SELECT customer_id, status::text AS status FROM waitlist WHERE show_id=$1 ORDER BY joined_at`,
      [ctx.show.id]
    );
    expect(statuses).toEqual([
      { customer_id: alice.id, status: 'offered' },
      { customer_id: bob.id, status: 'waiting' },
      { customer_id: carol.id, status: 'waiting' },
    ]);
  });

  it('only consults the waitlist for the seat’s own category', async () => {
    // Sell out Standard and queue Alice there; cancelling a Premium booking must
    // not offer a Premium seat to a Standard waiter.
    const sIds = standard().map((s) => s.id);
    await hold(owner, sIds);
    await book(owner, sIds);
    await join(alice, 'Standard');

    const premiumBooking = await sellOutPremium();
    const res = await cancel(owner, premiumBooking);

    expect(res.body.seats_offered_to_waitlist).toBe(0);
    expect(res.body.seats_released).toBe(2);

    const { rows } = await query("SELECT status::text AS status FROM waitlist WHERE customer_id=$1", [
      alice.id,
    ]);
    expect(rows[0].status).toBe('waiting');
  });

  it('emails the offer after the cancellation commits', async () => {
    const bookingId = await sellOutPremium();
    await join(alice);
    await cancel(owner, bookingId);
    await flush();

    const offerMail = mailer.getOutbox().find((m) => m.to === alice.email);
    expect(offerMail).toBeDefined();
    expect(offerMail.subject).toMatch(/Premium seat is available/i);
    expect(offerMail.text).toContain('/offer?token=');
  });

  it('still cancels successfully when the offer email fails', async () => {
    const bookingId = await sellOutPremium();
    await join(alice);

    const spy = jest
      .spyOn(mailer, 'sendWaitlistOffer')
      .mockRejectedValue(new Error('SMTP unavailable'));

    try {
      const res = await cancel(owner, bookingId);
      expect(res.status).toBe(200);
      await flush();

      // The offer must exist regardless of the failed email.
      const { rows } = await query(
        "SELECT status::text AS status FROM waitlist WHERE customer_id=$1",
        [alice.id]
      );
      expect(rows[0].status).toBe('offered');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('offer expiry cascades down the queue', () => {
  it('passes the seat to the next person rather than releasing it', async () => {
    // One Premium seat in play, Alice then Bob waiting.
    const [p1, p2] = premium();
    await hold(owner, [p1.id]);
    const bookingId = (await book(owner, [p1.id])).body.booking.id;
    await query("UPDATE show_seats SET status='booked' WHERE id=$1", [p2.id]);

    await join(alice);
    await join(bob);
    await cancel(owner, bookingId);

    // Alice holds the offer.
    expect((await getSeat(p1.id)).held_by).toBe(alice.id);
    expect((await getSeat(p1.id)).status).toBe('offered');

    // Alice does nothing and her window closes.
    await expireOffers();
    const summary = await sweeper.runOnce({ quiet: true });

    expect(summary.offersExpired).toBe(1);
    expect(summary.offersCascaded).toBe(1);
    expect(summary.seatsReleased).toBe(0);

    // The seat is now Bob's, NOT available.
    const row = await getSeat(p1.id);
    expect(row.status).toBe('offered');
    expect(row.held_by).toBe(bob.id);

    const { rows } = await query(
      `SELECT customer_id, status::text AS status FROM waitlist WHERE show_id=$1 ORDER BY joined_at`,
      [ctx.show.id]
    );
    expect(rows).toEqual([
      { customer_id: alice.id, status: 'expired' },
      { customer_id: bob.id, status: 'offered' },
    ]);
  });

  it('releases to general sale only once the queue is empty', async () => {
    const [p1, p2] = premium();
    await hold(owner, [p1.id]);
    const bookingId = (await book(owner, [p1.id])).body.booking.id;
    await query("UPDATE show_seats SET status='booked' WHERE id=$1", [p2.id]);

    await join(alice);
    await join(bob);
    await cancel(owner, bookingId);

    // Alice lapses -> Bob.
    await expireOffers();
    await sweeper.runOnce({ quiet: true });
    expect((await getSeat(p1.id)).held_by).toBe(bob.id);

    // Bob lapses -> nobody left -> available.
    await expireOffers();
    const summary = await sweeper.runOnce({ quiet: true });

    expect(summary.offersExpired).toBe(1);
    expect(summary.offersCascaded).toBe(0);
    expect(summary.seatsReleased).toBe(1);

    const row = await getSeat(p1.id);
    expect(row.status).toBe('available');
    expect(row.held_by).toBeNull();
    expect(row.hold_expires_at).toBeNull();

    const { rows } = await query(
      `SELECT status::text AS status, count(*)::int AS n FROM waitlist
        WHERE show_id=$1 GROUP BY status`,
      [ctx.show.id]
    );
    expect(rows).toEqual([{ status: 'expired', n: 2 }]);
  });

  it('does not re-offer the same seat to the customer who just let it lapse', async () => {
    const [p1, p2] = premium();
    await hold(owner, [p1.id]);
    const bookingId = (await book(owner, [p1.id])).body.booking.id;
    await query("UPDATE show_seats SET status='booked' WHERE id=$1", [p2.id]);

    await join(alice); // only Alice waiting
    await cancel(owner, bookingId);
    expect((await getSeat(p1.id)).held_by).toBe(alice.id);

    await expireOffers();
    await sweeper.runOnce({ quiet: true });

    // With only Alice in the queue and her entry expired, the seat is released
    // rather than handed straight back to her.
    const row = await getSeat(p1.id);
    expect(row.status).toBe('available');
    expect(row.held_by).toBeNull();
  });

  it('emails each cascade step', async () => {
    const [p1, p2] = premium();
    await hold(owner, [p1.id]);
    const bookingId = (await book(owner, [p1.id])).body.booking.id;
    await query("UPDATE show_seats SET status='booked' WHERE id=$1", [p2.id]);

    await join(alice);
    await join(bob);
    await cancel(owner, bookingId);
    await flush();
    expect(mailer.getOutbox().some((m) => m.to === alice.email)).toBe(true);

    mailer.clearOutbox();
    await expireOffers();
    await sweeper.runOnce({ quiet: true });
    await flush();

    const bobMail = mailer.getOutbox().find((m) => m.to === bob.email);
    expect(bobMail).toBeDefined();
    expect(bobMail.text).toContain('/offer?token=');
  });

  it('leaves a live offer untouched', async () => {
    const bookingId = await sellOutPremium();
    await join(alice);
    await cancel(owner, bookingId);

    const summary = await sweeper.runOnce({ quiet: true });
    expect(summary.offersExpired).toBe(0);

    const { rows } = await query(
      "SELECT count(*)::int AS n FROM show_seats WHERE status='offered' AND held_by=$1",
      [alice.id]
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('accepting an offer', () => {
  /** Cancel with Alice waiting, and return her offer token. */
  async function offerToAlice() {
    const bookingId = await sellOutPremium();
    await join(alice);
    await cancel(owner, bookingId);

    const { rows } = await query('SELECT offer_token, offered_show_seat_id FROM waitlist WHERE customer_id=$1', [
      alice.id,
    ]);
    return { token: rows[0].offer_token, seatId: rows[0].offered_show_seat_id };
  }

  /**
   * Regression guard: getOfferByToken originally did not select
   * offered_show_seat_id, so the route's `id: offer.offered_show_seat_id` was
   * undefined and JSON.stringify dropped the key entirely. Clients had no way to
   * learn which seat the offer was for without accepting it first.
   */
  it('includes the offered seat id so a client can identify the seat', async () => {
    const { token, seatId } = await offerToAlice();

    const res = await api().get(`/api/waitlist/offers/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.offer.seat).toHaveProperty('id');
    expect(res.body.offer.seat.id).toBe(seatId);
  });

  it('renders the offer detail without consuming the token', async () => {
    const { token } = await offerToAlice();

    const res = await api().get(`/api/waitlist/offers/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.offer).toMatchObject({ category: 'Premium', still_valid: true });
    expect(res.body.offer.seat.row_label).toBe('A');
    expect(res.body.offer.show.event_title).toBe('Test Event');

    // Still usable afterwards.
    const accept = await api().post(`/api/waitlist/offers/${token}/accept`).set(auth(alice));
    expect(accept.status).toBe(200);
  });

  it('converts the offer into a hold the customer can book', async () => {
    const { token, seatId } = await offerToAlice();

    const res = await api().post(`/api/waitlist/offers/${token}/accept`).set(auth(alice));
    expect(res.status).toBe(200);
    expect(res.body.seat_ids).toEqual([seatId]);
    expect(res.body.hold_ttl_minutes).toBe(10);

    const row = await getSeat(seatId);
    expect(row.status).toBe('held');
    expect(row.held_by).toBe(alice.id);

    // And she can complete the purchase through the normal endpoint.
    const booked = await book(alice, [seatId]);
    expect(booked.status).toBe(201);
    expect((await getSeat(seatId)).status).toBe('booked');
  });

  it('marks the waitlist entry fulfilled once booked', async () => {
    const { token, seatId } = await offerToAlice();
    await api().post(`/api/waitlist/offers/${token}/accept`).set(auth(alice));
    await book(alice, [seatId]);

    const { rows } = await query(
      "SELECT status::text AS status, offer_token FROM waitlist WHERE customer_id=$1",
      [alice.id]
    );
    expect(rows[0].status).toBe('fulfilled');
    expect(rows[0].offer_token).toBeNull();
  });

  it('is single use — a second accept fails', async () => {
    const { token } = await offerToAlice();

    const first = await api().post(`/api/waitlist/offers/${token}/accept`).set(auth(alice));
    expect(first.status).toBe(200);

    const second = await api().post(`/api/waitlist/offers/${token}/accept`).set(auth(alice));
    expect(second.status).toBe(409);
    expect(second.body.error.message).toMatch(/no longer valid|already been used/i);
  });

  it('cannot be redeemed by a different customer who got the forwarded link', async () => {
    const { token, seatId } = await offerToAlice();

    const res = await api().post(`/api/waitlist/offers/${token}/accept`).set(auth(bob));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/different customer/i);

    // Still Alice's.
    expect((await getSeat(seatId)).held_by).toBe(alice.id);
  });

  it('rejects an expired offer even before the sweeper runs', async () => {
    const { token } = await offerToAlice();
    await expireOffers();
    await query(
      "UPDATE waitlist SET offer_expires_at = now() - interval '1 second' WHERE status='offered'"
    );

    const res = await api().post(`/api/waitlist/offers/${token}/accept`).set(auth(alice));
    expect(res.status).toBe(409);
  });

  it('rejects a bogus token', async () => {
    const res = await api()
      .post('/api/waitlist/offers/deadbeefdeadbeefdeadbeefdeadbeef/accept')
      .set(auth(alice));
    expect(res.status).toBe(409);

    const read = await api().get('/api/waitlist/offers/deadbeefdeadbeef');
    expect(read.status).toBe(404);
  });

  it('requires authentication to accept', async () => {
    const { token } = await offerToAlice();
    const res = await api().post(`/api/waitlist/offers/${token}/accept`);
    expect(res.status).toBe(401);
  });

  it('two parallel accepts of one token yield exactly one success', async () => {
    const { token } = await offerToAlice();

    const results = await Promise.all([
      api().post(`/api/waitlist/offers/${token}/accept`).set(auth(alice)),
      api().post(`/api/waitlist/offers/${token}/accept`).set(auth(alice)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe('GET /api/waitlist/mine', () => {
  it('lists entries with positions and show context', async () => {
    await sellOutPremium();
    await join(alice);

    const res = await api().get('/api/waitlist/mine').set(auth(alice));
    expect(res.status).toBe(200);
    expect(res.body.waitlist).toHaveLength(1);
    expect(res.body.waitlist[0]).toMatchObject({
      category: 'Premium',
      status: 'waiting',
      position: 1,
      event_title: 'Test Event',
      venue_name: 'Test Venue',
    });
  });

  it('shows the offered seat once an offer is made', async () => {
    const bookingId = await sellOutPremium();
    await join(alice);
    await cancel(owner, bookingId);

    const res = await api().get('/api/waitlist/mine').set(auth(alice));
    expect(res.body.waitlist[0]).toMatchObject({
      status: 'offered',
      offered_row_label: 'A',
    });
    expect(res.body.waitlist[0].offer_token).toEqual(expect.any(String));
  });

  it('does not list another customer’s entries', async () => {
    await sellOutPremium();
    await join(alice);

    const res = await api().get('/api/waitlist/mine').set(auth(bob));
    expect(res.body.waitlist).toEqual([]);
  });
});

describe('concurrent seat release does not double-serve one queue entry', () => {
  it('gives two simultaneously released seats to two different customers', async () => {
    // Two separate single-seat bookings, cancelled in parallel.
    const [p1, p2] = premium();
    await hold(owner, [p1.id]);
    const b1 = (await book(owner, [p1.id])).body.booking.id;
    await hold(owner, [p2.id]);
    const b2 = (await book(owner, [p2.id])).body.booking.id;

    await join(alice);
    await join(bob);

    const results = await Promise.all([cancel(owner, b1), cancel(owner, b2)]);
    expect(results.every((r) => r.status === 200)).toBe(true);

    // Each of Alice and Bob must hold exactly one offer — SKIP LOCKED means the
    // second release skips the entry the first is claiming rather than both
    // landing on Alice.
    const { rows } = await query(
      `SELECT held_by, count(*)::int AS n FROM show_seats
        WHERE show_id=$1 AND status='offered' GROUP BY held_by`,
      [ctx.show.id]
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.n)).toEqual([1, 1]);

    const { rows: wl } = await query(
      `SELECT count(*)::int AS n FROM waitlist WHERE show_id=$1 AND status='offered'`,
      [ctx.show.id]
    );
    expect(wl[0].n).toBe(2);
  });
});

/**
 * The waitlist allocation contract, stated end to end as five explicit scenarios.
 *
 * Much of this is covered piecemeal above; this block exists so the guarantee can be
 * read and re-verified as a single specification rather than reassembled from
 * thirty separate cases. Two assertions here were genuinely missing beforehand:
 * that the seat map never reports a live OFFERED seat as available, and that a hold
 * attempt on one fails with the SEATS_UNAVAILABLE *code* rather than merely a 409.
 */
describe('waitlist allocation contract', () => {
  /** Sell out Premium down to a single seat, then book that last seat as `owner`. */
  async function bookLastPremiumSeat() {
    const [first, last] = premium();
    // Park the first seat on a different customer so only `last` is in play.
    await hold(carol, [first.id]);
    await book(carol, [first.id]);

    await hold(owner, [last.id]);
    const res = await book(owner, [last.id]);
    expect(res.status).toBe(201);
    return { bookingId: res.body.booking.id, seatId: last.id };
  }

  const seatRow = (seatId) =>
    query(
      `SELECT status::text AS status, held_by, hold_expires_at
         FROM show_seats WHERE id = $1`,
      [seatId]
    ).then((r) => r.rows[0]);

  const seatMapEntry = async (seatId) => {
    const res = await api().get(`/api/shows/${ctx.show.id}/seats`);
    return res.body.rows.flatMap((r) => r.seats).find((s) => s.id === seatId);
  };

  it('Test 1 — cancelling the last seat offers it to the oldest waiter, not the public', async () => {
    const { bookingId, seatId } = await bookLastPremiumSeat();

    // Category is sold out, so joining is permitted.
    expect((await join(bob)).status).toBe(201);

    const res = await cancel(owner, bookingId);
    expect(res.status).toBe(200);
    expect(res.body.seats_offered_to_waitlist).toBe(1);
    expect(res.body.seats_released).toBe(0);

    // BOOKED -> OFFERED, reserved for Bob, never available.
    const seat = await seatRow(seatId);
    expect(seat.status).toBe('offered');
    expect(seat.held_by).toBe(bob.id);
    expect(new Date(seat.hold_expires_at).getTime()).toBeGreaterThan(Date.now());

    // Bob's queue entry carries a single-use token and points at this seat.
    const { rows: wl } = await query(
      `SELECT status::text AS status, offer_token, offered_show_seat_id
         FROM waitlist WHERE customer_id = $1`,
      [bob.id]
    );
    expect(wl[0].status).toBe('offered');
    expect(wl[0].offer_token).toMatch(/^[0-9a-f]{64}$/);
    expect(wl[0].offered_show_seat_id).toBe(seatId);

    // Bob is emailed the offer.
    await flush();
    const mail = mailer.getOutbox().find((m) => m.to === bob.email);
    expect(mail).toBeDefined();
    expect(mail.text).toContain('/offer?token=');

    // Customer C can neither hold nor book it.
    expect((await hold(alice, [seatId])).status).toBe(409);
    expect((await book(alice, [seatId])).status).toBe(409);
  });

  it('Test 2 — an ignored offer cascades to the next waiter, still not the public', async () => {
    const { bookingId, seatId } = await bookLastPremiumSeat();
    await join(bob); // first in queue
    await join(alice); // second
    await cancel(owner, bookingId);

    expect((await seatRow(seatId)).held_by).toBe(bob.id);

    await expireOffers();
    await sweeper.runOnce();

    const seat = await seatRow(seatId);
    expect(seat.status).toBe('offered'); // not 'available'
    expect(seat.held_by).toBe(alice.id); // cascaded to the next in line

    const { rows } = await query(
      `SELECT customer_id, status::text AS status FROM waitlist WHERE show_id = $1
        ORDER BY joined_at, id`,
      [ctx.show.id]
    );
    expect(rows).toEqual([
      { customer_id: bob.id, status: 'expired' },
      { customer_id: alice.id, status: 'offered' },
    ]);
  });

  it('Test 3 — with nobody waiting, a cancellation returns the seat to AVAILABLE', async () => {
    const { bookingId, seatId } = await bookLastPremiumSeat();

    const res = await cancel(owner, bookingId);
    expect(res.status).toBe(200);
    expect(res.body.seats_released).toBe(1);
    expect(res.body.seats_offered_to_waitlist).toBe(0);

    const seat = await seatRow(seatId);
    expect(seat.status).toBe('available');
    expect(seat.held_by).toBeNull();
    expect(seat.hold_expires_at).toBeNull();

    // And it is genuinely bookable by anyone again.
    expect((await hold(alice, [seatId])).status).toBe(201);
  });

  it('Test 3b — the seat returns to AVAILABLE only once the queue is exhausted', async () => {
    const { bookingId, seatId } = await bookLastPremiumSeat();
    await join(bob);
    await cancel(owner, bookingId);

    // Bob lets it lapse and he is the only waiter, so now it may go on general sale.
    await expireOffers();
    await sweeper.runOnce();

    const seat = await seatRow(seatId);
    expect(seat.status).toBe('available');
    expect(seat.held_by).toBeNull();
  });

  it('Test 4 — two simultaneous claims of one offer: exactly one succeeds', async () => {
    const { bookingId } = await bookLastPremiumSeat();
    await join(bob);
    await cancel(owner, bookingId);

    const { rows } = await query('SELECT offer_token FROM waitlist WHERE customer_id = $1', [bob.id]);
    const token = rows[0].offer_token;

    const accept = () =>
      api().post(`/api/waitlist/offers/${token}/accept`).set(auth(bob)).send();
    const [a, b] = await Promise.all([accept(), accept()]);

    const codes = [a.status, b].map((x) => (typeof x === 'number' ? x : x.status)).sort();
    expect(codes).toEqual([200, 409]);

    // Exactly one fulfilled entry, and the token is burned.
    const { rows: after } = await query(
      `SELECT status::text AS status, offer_token FROM waitlist WHERE customer_id = $1`,
      [bob.id]
    );
    expect(after[0].status).toBe('fulfilled');
    expect(after[0].offer_token).toBeNull();
  });

  it('Test 5 — holding an OFFERED seat fails with 409 SEATS_UNAVAILABLE naming the seat', async () => {
    const { bookingId, seatId } = await bookLastPremiumSeat();
    await join(bob);
    await cancel(owner, bookingId);

    const res = await hold(alice, [seatId]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEATS_UNAVAILABLE');
    expect(res.body.error.details.unavailableSeatIds).toContain(seatId);

    // Alice holds nothing at all — the rejection is all-or-nothing.
    const { rows } = await query(
      "SELECT count(*)::int AS n FROM show_seats WHERE held_by = $1 AND status = 'held'",
      [alice.id]
    );
    expect(rows[0].n).toBe(0);
  });

  it('Test 6 — the seat map never reports a live OFFERED seat as available', async () => {
    const { bookingId, seatId } = await bookLastPremiumSeat();
    await join(bob);
    await cancel(owner, bookingId);

    // Anonymous view: the seat is not available, and the holder is not disclosed.
    const entry = await seatMapEntry(seatId);
    expect(entry.status).not.toBe('available');
    expect(entry.status).toBe('offered');
    expect(entry.held_by).toBeUndefined();

    // Availability counts must not include it.
    const avail = await api().get(`/api/shows/${ctx.show.id}/availability`);
    const premiumRow = avail.body.categories.find((a) => a.category === 'Premium');
    expect(premiumRow.available).toBe(0);
    expect(premiumRow.sold_out).toBe(true);

    // Once the offer lapses, the effective status flips to available at read time
    // even before the sweeper tidies the row — that is the documented behaviour.
    await expireOffers();
    expect((await seatMapEntry(seatId)).status).toBe('available');
  });
});

/**
 * Explicit hold release must respect the waitlist, exactly like cancellation.
 *
 * This is a regression suite for a real production bug: DELETE /api/shows/:id/hold
 * ran its own `UPDATE show_seats SET status = 'available'` instead of routing the
 * seat through placeSeat. A customer who held the last seat in a sold-out category
 * and then pressed "release" put that seat straight back on general sale, so the
 * waiting customer was never offered it, never emailed, and any passer-by could
 * take it. Cancellation was correct, which is exactly why this went unnoticed.
 */
describe('explicit hold release respects the waitlist', () => {
  const release = (customer, seatIds) =>
    api()
      .delete(`/api/shows/${ctx.show.id}/hold`)
      .set(auth(customer))
      .send(seatIds ? { seat_ids: seatIds } : {});

  const seatRow = (seatId) =>
    query(
      `SELECT status::text AS status, held_by, hold_expires_at
         FROM show_seats WHERE id = $1`,
      [seatId]
    ).then((r) => r.rows[0]);

  /** Hold every Premium seat as `owner` so the category reads as sold out. */
  async function holdOutPremium() {
    const ids = premium().map((s) => s.id);
    const res = await hold(owner, ids);
    expect(res.status).toBe(201);
    return ids;
  }

  it('offers a released held seat to the waiting customer instead of the public', async () => {
    const ids = await holdOutPremium();
    expect((await join(bob)).status).toBe(201);

    const res = await release(owner, [ids[0]]);
    expect(res.status).toBe(200);

    // The seat must be OFFERED to Bob, never AVAILABLE.
    const seat = await seatRow(ids[0]);
    expect(seat.status).toBe('offered');
    expect(seat.held_by).toBe(bob.id);
    expect(new Date(seat.hold_expires_at).getTime()).toBeGreaterThan(Date.now());

    const { rows: wl } = await query(
      `SELECT status::text AS status, offer_token, offered_show_seat_id
         FROM waitlist WHERE customer_id = $1`,
      [bob.id]
    );
    expect(wl[0].status).toBe('offered');
    expect(wl[0].offer_token).toMatch(/^[0-9a-f]{64}$/);
    expect(wl[0].offered_show_seat_id).toBe(ids[0]);
  });

  it('emails the waiting customer after the release commits', async () => {
    const ids = await holdOutPremium();
    await join(bob);
    await release(owner, [ids[0]]);
    await flush();

    const mail = mailer.getOutbox().find((m) => m.to === bob.email);
    expect(mail).toBeDefined();
    expect(mail.subject).toMatch(/premium seat is available/i);
    expect(mail.text).toContain('/offer?token=');
  });

  it('blocks a normal customer from holding the released-then-offered seat', async () => {
    const ids = await holdOutPremium();
    await join(bob);
    await release(owner, [ids[0]]);

    const res = await hold(carol, [ids[0]]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEATS_UNAVAILABLE');
    expect(res.body.error.details.unavailableSeatIds).toContain(ids[0]);
  });

  it('blocks a normal customer from booking the released-then-offered seat', async () => {
    const ids = await holdOutPremium();
    await join(bob);
    await release(owner, [ids[0]]);

    const res = await book(carol, [ids[0]]);
    expect(res.status).toBe(409);
  });

  it('still returns the seat to general sale when nobody is waiting', async () => {
    const ids = await holdOutPremium();

    const res = await release(owner, [ids[0]]);
    expect(res.status).toBe(200);

    const seat = await seatRow(ids[0]);
    expect(seat.status).toBe('available');
    expect(seat.held_by).toBeNull();
    expect(seat.hold_expires_at).toBeNull();

    // And is genuinely claimable again.
    expect((await hold(carol, [ids[0]])).status).toBe(201);
  });

  it('distributes a full release across the queue in FIFO order', async () => {
    const ids = await holdOutPremium(); // 2 Premium seats
    await join(bob);
    await join(alice);

    // Release everything at once, with no seat_ids filter.
    const res = await release(owner);
    expect(res.status).toBe(200);

    const { rows } = await query(
      `SELECT w.customer_id, w.status::text AS status
         FROM waitlist w WHERE w.show_id = $1 ORDER BY w.joined_at, w.id`,
      [ctx.show.id]
    );
    expect(rows).toEqual([
      { customer_id: bob.id, status: 'offered' },
      { customer_id: alice.id, status: 'offered' },
    ]);

    const { rows: seats } = await query(
      `SELECT count(*)::int AS n FROM show_seats
        WHERE show_id = $1 AND status = 'offered'`,
      [ctx.show.id]
    );
    expect(seats[0].n).toBe(2);
  });

  it('reports how many released seats went to the waitlist', async () => {
    const ids = await holdOutPremium();
    await join(bob);

    const res = await release(owner);
    expect(res.body.released).toBe(2);
    expect(res.body.seats_offered_to_waitlist).toBe(1);
    expect(res.body.seats_released).toBe(1);
  });

  it('never releases another customer’s hold', async () => {
    const ids = await holdOutPremium();
    await join(bob);

    // Carol tries to release the owner's hold.
    const res = await release(carol, [ids[0]]);
    expect(res.status).toBe(200);
    expect(res.body.released).toBe(0);

    // Seat is untouched: still held by owner, not offered to Bob.
    const seat = await seatRow(ids[0]);
    expect(seat.status).toBe('held');
    expect(seat.held_by).toBe(owner.id);
  });

  it('a released seat offered to B cannot be raced away by C', async () => {
    const ids = await holdOutPremium();
    await join(bob);
    await release(owner, [ids[0]]);

    const { rows } = await query('SELECT offer_token FROM waitlist WHERE customer_id = $1', [bob.id]);

    // B accepts while C simultaneously attempts a hold on the same seat.
    const [accept, steal] = await Promise.all([
      api().post(`/api/waitlist/offers/${rows[0].offer_token}/accept`).set(auth(bob)).send(),
      hold(carol, [ids[0]]),
    ]);

    expect(accept.status).toBe(200);
    expect(steal.status).toBe(409);

    const seat = await seatRow(ids[0]);
    expect(seat.status).toBe('held');
    expect(seat.held_by).toBe(bob.id);
  });
});
