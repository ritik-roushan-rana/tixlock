'use strict';

const {
  api, query, truncateAll, closePool, createUser, auth, createBookableShow, getSeat,
} = require('./helpers');
const mailer = require('../src/services/mailer');

let ctx;
let customerA;
let customerB;

beforeEach(async () => {
  await truncateAll();
  mailer.clearOutbox();
  ctx = await createBookableShow({
    layout: [
      { row_label: 'A', seats: 4, category: 'Premium' },
      { row_label: 'B', seats: 4, category: 'Standard' },
    ],
    pricing: { Premium: 500, Standard: 200 },
  });
  customerA = await createUser({ role: 'customer', name: 'Asha Rao' });
  customerB = await createUser({ role: 'customer', name: 'Bala Iyer' });
});

afterAll(closePool);

const hold = (customer, seatIds) =>
  api().post(`/api/shows/${ctx.show.id}/hold`).set(auth(customer)).send({ seat_ids: seatIds });

const book = (customer, seatIds, body = {}) =>
  api()
    .post('/api/bookings')
    .set(auth(customer))
    .send({ show_id: ctx.show.id, seat_ids: seatIds, ...body });

/** Wait for setImmediate-scheduled email work to run. */
const flushSideEffects = () => new Promise((r) => setTimeout(r, 60));

/** Premium seats are ids for row A; Standard for row B. */
const premium = () => ctx.seats.filter((s) => s.category === 'Premium');
const standard = () => ctx.seats.filter((s) => s.category === 'Standard');

describe('POST /api/bookings', () => {
  it('converts a hold into a confirmed booking', async () => {
    const seat = premium()[0];
    await hold(customerA, [seat.id]);

    const res = await book(customerA, [seat.id]);

    expect(res.status).toBe(201);
    expect(res.body.booking).toMatchObject({
      status: 'confirmed',
      customer_id: customerA.id,
      show_id: ctx.show.id,
      total_amount: '500.00',
    });
    expect(res.body.booking.booking_ref).toMatch(/^TB-[A-Z2-9]{8}$/);

    const row = await getSeat(seat.id);
    expect(row.status).toBe('booked');
    // The consistency constraint requires these cleared for a settled status.
    expect(row.held_by).toBeNull();
    expect(row.hold_expires_at).toBeNull();
  });

  it('computes the total server-side across mixed categories', async () => {
    const ids = [premium()[0].id, premium()[1].id, standard()[0].id];
    await hold(customerA, ids);

    const res = await book(customerA, ids);
    // 500 + 500 + 200
    expect(res.body.booking.total_amount).toBe('1200.00');
  });

  it('ignores a client-supplied total_amount', async () => {
    const seat = premium()[0];
    await hold(customerA, [seat.id]);

    const res = await book(customerA, [seat.id], { total_amount: 1 });

    expect(res.status).toBe(201);
    expect(res.body.booking.total_amount).toBe('500.00');

    const { rows } = await query('SELECT total_amount FROM bookings WHERE id = $1', [
      res.body.booking.id,
    ]);
    expect(rows[0].total_amount).toBe('500.00');
  });

  it('records the price paid per seat', async () => {
    const ids = [premium()[0].id, standard()[0].id];
    await hold(customerA, ids);
    const res = await book(customerA, ids);

    const { rows } = await query(
      'SELECT price FROM booking_seats WHERE booking_id = $1 ORDER BY price DESC',
      [res.body.booking.id]
    );
    expect(rows.map((r) => r.price)).toEqual(['500.00', '200.00']);
  });

  it('creates one booking_seats row per seat', async () => {
    const ids = premium().slice(0, 3).map((s) => s.id);
    await hold(customerA, ids);
    const res = await book(customerA, ids);

    const { rows } = await query(
      'SELECT count(*)::int AS n FROM booking_seats WHERE booking_id = $1',
      [res.body.booking.id]
    );
    expect(rows[0].n).toBe(3);
  });

  it('returns the seats and show detail with the booking', async () => {
    const seat = premium()[0];
    await hold(customerA, [seat.id]);
    const res = await book(customerA, [seat.id]);

    expect(res.body.booking.seats).toEqual([
      { id: seat.id, row_label: 'A', seat_number: 1, category: 'Premium', price: '500.00' },
    ]);
    expect(res.body.booking.show).toMatchObject({
      event_title: 'Test Event',
      venue_name: 'Test Venue',
    });
  });
});

describe('booking rejects anything it does not own', () => {
  it('refuses seats that were never held', async () => {
    const seat = premium()[0];
    const res = await book(customerA, [seat.id]);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEATS_UNAVAILABLE');
    expect((await getSeat(seat.id)).status).toBe('available');
  });

  it('refuses seats held by a different customer', async () => {
    const seat = premium()[0];
    await hold(customerB, [seat.id]);

    const res = await book(customerA, [seat.id]);
    expect(res.status).toBe(409);

    // B's hold must be untouched.
    const row = await getSeat(seat.id);
    expect(row.status).toBe('held');
    expect(row.held_by).toBe(customerB.id);
  });

  it('refuses an already-booked seat', async () => {
    const seat = premium()[0];
    await hold(customerA, [seat.id]);
    await book(customerA, [seat.id]);

    await hold(customerB, [seat.id]); // will 409, seat is booked
    const res = await book(customerB, [seat.id]);
    expect(res.status).toBe(409);

    const { rows } = await query('SELECT count(*)::int AS n FROM bookings');
    expect(rows[0].n).toBe(1);
  });

  it('is all-or-nothing when one seat of several is not held', async () => {
    const [s1, s2] = premium();
    await hold(customerA, [s1.id]);

    const res = await book(customerA, [s1.id, s2.id]);
    expect(res.status).toBe(409);
    expect(res.body.error.details.unavailableSeatIds).toEqual([s2.id]);

    // No booking, and s1 must still be held rather than consumed.
    expect((await query('SELECT count(*)::int AS n FROM bookings')).rows[0].n).toBe(0);
    expect((await getSeat(s1.id)).status).toBe('held');
  });

  it('rejects an organiser trying to book', async () => {
    const res = await api()
      .post('/api/bookings')
      .set(auth(ctx.organiser))
      .send({ show_id: ctx.show.id, seat_ids: [premium()[0].id] });
    expect(res.status).toBe(403);
  });

  it('rejects an anonymous booking', async () => {
    const res = await api()
      .post('/api/bookings')
      .send({ show_id: ctx.show.id, seat_ids: [premium()[0].id] });
    expect(res.status).toBe(401);
  });
});

describe('booking re-validates hold expiry independently of the sweeper', () => {
  it('refuses to book a seat whose hold has lapsed, even though the row still says held', async () => {
    const seat = premium()[0];
    await hold(customerA, [seat.id]);

    await query(
      "UPDATE show_seats SET hold_expires_at = now() - interval '1 second' WHERE id = $1 AND status = 'held'",
      [seat.id]
    );
    // No sweep has run.
    expect((await getSeat(seat.id)).status).toBe('held');

    const res = await book(customerA, [seat.id]);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/hold may have expired/i);

    expect((await query('SELECT count(*)::int AS n FROM bookings')).rows[0].n).toBe(0);
  });

  it('allows booking while the hold is still live', async () => {
    const seat = premium()[0];
    await hold(customerA, [seat.id]);
    expect((await book(customerA, [seat.id])).status).toBe(201);
  });
});

describe('concurrent booking of the same held seat', () => {
  it('creates exactly one booking when the same customer double-submits', async () => {
    const seat = premium()[0];
    await hold(customerA, [seat.id]);

    // Double-click / duplicate submit.
    const results = await Promise.all([book(customerA, [seat.id]), book(customerA, [seat.id])]);
    const codes = results.map((r) => r.status).sort();

    expect(codes).toEqual([201, 409]);
    expect((await query('SELECT count(*)::int AS n FROM bookings')).rows[0].n).toBe(1);
    expect(
      (await query('SELECT count(*)::int AS n FROM booking_seats')).rows[0].n
    ).toBe(1);
  });

  it('never lets two customers book the same seat', async () => {
    const seat = premium()[0];

    // A wins the hold race, so only A can book.
    const holds = await Promise.all([hold(customerA, [seat.id]), hold(customerB, [seat.id])]);
    const winner = holds[0].status === 201 ? customerA : customerB;
    const loser = winner === customerA ? customerB : customerA;

    const results = await Promise.all([book(winner, [seat.id]), book(loser, [seat.id])]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);

    const { rows } = await query(
      `SELECT count(*)::int AS n FROM booking_seats bs
         JOIN bookings b ON b.id = bs.booking_id
        WHERE bs.show_seat_id = $1 AND b.status = 'confirmed'`,
      [seat.id]
    );
    expect(rows[0].n).toBe(1);
  });

  it('does not oversell under a burst of parallel bookings across many seats', async () => {
    const customers = [];
    for (let i = 0; i < 8; i += 1) customers.push(await createUser({ role: 'customer' }));

    // Each customer holds one distinct seat, then all book simultaneously.
    const allSeats = ctx.seats.slice(0, 8);
    await Promise.all(customers.map((c, i) => hold(c, [allSeats[i].id])));

    const results = await Promise.all(
      customers.map((c, i) =>
        api()
          .post('/api/bookings')
          .set(auth(c))
          .send({ show_id: ctx.show.id, seat_ids: [allSeats[i].id] })
      )
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(8);

    const { rows } = await query(
      "SELECT count(*)::int AS n FROM show_seats WHERE show_id=$1 AND status='booked'",
      [ctx.show.id]
    );
    expect(rows[0].n).toBe(8);
  });
});

describe('QR code', () => {
  it('returns a PNG data URL with the booking', async () => {
    const seat = premium()[0];
    await hold(customerA, [seat.id]);
    const res = await book(customerA, [seat.id]);

    expect(res.body.qr_data_url).toMatch(/^data:image\/png;base64,/);
  });

  /**
   * Proves the payload is exactly the reference and nothing more, without needing
   * a QR decoder: QR encoding is deterministic, so an image built from the bare
   * reference is byte-identical to the booking's QR only if the booking's QR
   * encodes precisely that string. Any extra field — name, email, seat list —
   * would change the bitmap and fail this comparison.
   */
  it('encodes exactly the booking reference and nothing else', async () => {
    const qrService = require('../src/services/qrService');
    const seat = premium()[0];
    await hold(customerA, [seat.id]);
    const res = await book(customerA, [seat.id]);
    const ref = res.body.booking.booking_ref;

    const bareRefQr = await qrService.generateBookingQr(ref);
    expect(res.body.qr_data_url).toBe(bareRefQr);

    // Sanity check that the comparison is actually discriminating.
    const withExtra = await qrService.generateBookingQr(`${ref}|${customerA.email}`);
    expect(res.body.qr_data_url).not.toBe(withExtra);
  });

  it('can be re-fetched for an existing booking', async () => {
    const seat = premium()[0];
    await hold(customerA, [seat.id]);
    const created = await book(customerA, [seat.id]);

    const res = await api().get(`/api/bookings/${created.body.booking.id}/qr`).set(auth(customerA));
    expect(res.status).toBe(200);
    expect(res.body.booking_ref).toBe(created.body.booking.booking_ref);
    expect(res.body.qr_data_url).toMatch(/^data:image\/png;base64,/);
  });
});

describe('email is a post-commit side effect', () => {
  it('sends a confirmation email after the booking commits', async () => {
    const seat = premium()[0];
    await hold(customerA, [seat.id]);
    const res = await book(customerA, [seat.id]);

    await flushSideEffects();

    const sent = mailer.getOutbox();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(customerA.email);
    expect(sent[0].subject).toContain(res.body.booking.booking_ref);
    expect(sent[0].text).toContain('A1');
  });

  it('still succeeds and persists the booking when the mailer throws', async () => {
    const seat = premium()[0];
    await hold(customerA, [seat.id]);

    // Simulate a broken SMTP setup.
    const spy = jest
      .spyOn(mailer, 'sendBookingConfirmation')
      .mockRejectedValue(new Error('ECONNREFUSED smtp.example.com:587'));

    try {
      const res = await book(customerA, [seat.id]);
      expect(res.status).toBe(201);

      await flushSideEffects();

      // The booking must exist and the seat must be booked regardless.
      const { rows } = await query("SELECT status::text AS status FROM bookings WHERE booking_ref = $1", [
        res.body.booking.booking_ref,
      ]);
      expect(rows[0].status).toBe('confirmed');
      expect((await getSeat(seat.id)).status).toBe('booked');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not block the response on the email', async () => {
    const seat = premium()[0];
    await hold(customerA, [seat.id]);

    // A slow mailer must not delay the API response, because the send is scheduled
    // after the response via setImmediate.
    const spy = jest.spyOn(mailer, 'sendBookingConfirmation').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ sent: true }), 2000))
    );

    try {
      const started = Date.now();
      const res = await book(customerA, [seat.id]);
      const elapsed = Date.now() - started;

      expect(res.status).toBe(201);
      expect(elapsed).toBeLessThan(1500);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('GET /api/bookings — history', () => {
  it('lists the caller’s bookings, newest first', async () => {
    const [s1, s2] = premium();
    await hold(customerA, [s1.id]);
    await book(customerA, [s1.id]);
    await hold(customerA, [s2.id]);
    await book(customerA, [s2.id]);

    const res = await api().get('/api/bookings').set(auth(customerA));
    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(2);
    expect(new Date(res.body.bookings[0].created_at).getTime()).toBeGreaterThanOrEqual(
      new Date(res.body.bookings[1].created_at).getTime()
    );
  });

  it('includes seats, show and venue detail', async () => {
    const ids = [premium()[0].id, premium()[1].id];
    await hold(customerA, ids);
    await book(customerA, ids);

    const res = await api().get('/api/bookings').set(auth(customerA));
    const booking = res.body.bookings[0];

    expect(booking).toMatchObject({
      event_title: 'Test Event',
      venue_name: 'Test Venue',
      date: '2026-12-01',
      time: '19:00:00',
      total_amount: '1000.00',
    });
    expect(booking.seats).toHaveLength(2);
    expect(booking.seats[0]).toMatchObject({ row_label: 'A', category: 'Premium' });
  });

  it('does not show another customer’s bookings', async () => {
    const seat = premium()[0];
    await hold(customerA, [seat.id]);
    await book(customerA, [seat.id]);

    const res = await api().get('/api/bookings').set(auth(customerB));
    expect(res.body.bookings).toEqual([]);
  });

  it('returns an empty list for a customer with no bookings', async () => {
    const res = await api().get('/api/bookings').set(auth(customerA));
    expect(res.body.bookings).toEqual([]);
  });
});

describe('GET /api/bookings/:id and /ref/:ref', () => {
  async function makeBooking() {
    const seat = premium()[0];
    await hold(customerA, [seat.id]);
    return (await book(customerA, [seat.id])).body.booking;
  }

  it('fetches the caller’s own booking by id', async () => {
    const created = await makeBooking();
    const res = await api().get(`/api/bookings/${created.id}`).set(auth(customerA));
    expect(res.status).toBe(200);
    expect(res.body.booking.booking_ref).toBe(created.booking_ref);
  });

  it('hides another customer’s booking behind a 404', async () => {
    const created = await makeBooking();
    const res = await api().get(`/api/bookings/${created.id}`).set(auth(customerB));
    expect(res.status).toBe(404);
  });

  it('resolves a booking reference (the QR payload)', async () => {
    const created = await makeBooking();
    const res = await api().get(`/api/bookings/ref/${created.booking_ref}`).set(auth(customerA));
    expect(res.status).toBe(200);
    expect(res.body.booking.id).toBe(created.id);
  });

  it('lets an organiser resolve a reference at the door', async () => {
    const created = await makeBooking();
    const res = await api().get(`/api/bookings/ref/${created.booking_ref}`).set(auth(ctx.organiser));
    expect(res.status).toBe(200);
    expect(res.body.booking.booking_ref).toBe(created.booking_ref);
  });

  it('returns 404 for an unknown reference', async () => {
    const res = await api().get('/api/bookings/ref/TB-NOTAREAL').set(auth(customerA));
    expect(res.status).toBe(404);
  });
});
