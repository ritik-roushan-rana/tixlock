'use strict';

const {
  api, query, truncateAll, closePool, createUser, auth, createBookableShow,
} = require('./helpers');

let ctx;
let otherOrganiser;
let admin;
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
  admin = ctx.admin;
  otherOrganiser = await createUser({ role: 'organiser' });
  customerA = await createUser({ role: 'customer', name: 'Cust A' });
  customerB = await createUser({ role: 'customer', name: 'Cust B' });
});

afterAll(closePool);

const premium = () => ctx.seats.filter((s) => s.category === 'Premium');
const standard = () => ctx.seats.filter((s) => s.category === 'Standard');

const hold = (customer, seatIds) =>
  api().post(`/api/shows/${ctx.show.id}/hold`).set(auth(customer)).send({ seat_ids: seatIds });

async function book(customer, seatIds) {
  await hold(customer, seatIds);
  const res = await api()
    .post('/api/bookings')
    .set(auth(customer))
    .send({ show_id: ctx.show.id, seat_ids: seatIds });
  expect(res.status).toBe(201);
  return res.body.booking;
}

describe('GET /api/dashboard/summary', () => {
  it('reports zeroes for an event with no sales', async () => {
    const res = await api().get('/api/dashboard/summary').set(auth(ctx.organiser));

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      title: 'Test Event',
      show_count: 1,
      total_seats: 6,
      booked_seats: 0,
      available_seats: 6,
      bookings_confirmed: 0,
      revenue: '0.00',
    });
    expect(res.body.totals).toMatchObject({ events: 1, shows: 1, seats_sold: 0, revenue: '0.00' });
  });

  it('counts seats sold and revenue from confirmed bookings', async () => {
    await book(customerA, [premium()[0].id, premium()[1].id]); // 1000
    await book(customerB, [standard()[0].id]); // 200

    const res = await api().get('/api/dashboard/summary').set(auth(ctx.organiser));
    expect(res.body.events[0]).toMatchObject({
      booked_seats: 3,
      available_seats: 3,
      bookings_confirmed: 2,
      revenue: '1200.00',
    });
    expect(res.body.totals).toMatchObject({ seats_sold: 3, bookings: 2, revenue: '1200.00' });
  });

  it('excludes cancelled bookings from revenue', async () => {
    const keep = await book(customerA, [premium()[0].id]); // 500
    const drop = await book(customerB, [standard()[0].id]); // 200

    await api().post(`/api/bookings/${drop.id}/cancel`).set(auth(customerB)).expect(200);

    const res = await api().get('/api/dashboard/summary').set(auth(ctx.organiser));
    expect(res.body.events[0]).toMatchObject({
      revenue: '500.00',
      cancelled_value: '200.00',
      bookings_confirmed: 1,
      bookings_cancelled: 1,
      booked_seats: 1,
    });
    expect(res.body.totals.revenue).toBe('500.00');
    // Keep the surviving booking referenced so the intent is obvious.
    expect(keep.total_amount).toBe('500.00');
  });

  it('does not inflate counts when a booking covers several seats', async () => {
    // A naive join of bookings against show_seats would multiply rows here.
    await book(customerA, premium().map((s) => s.id)); // 3 seats, one booking

    const res = await api().get('/api/dashboard/summary').set(auth(ctx.organiser));
    expect(res.body.events[0]).toMatchObject({
      bookings_confirmed: 1,
      booked_seats: 3,
      total_seats: 6,
      revenue: '1500.00',
    });
  });

  it('counts live holds separately from available seats', async () => {
    await hold(customerA, [premium()[0].id]);

    const res = await api().get('/api/dashboard/summary').set(auth(ctx.organiser));
    expect(res.body.events[0]).toMatchObject({
      pending_seats: 1,
      available_seats: 5,
      booked_seats: 0,
    });
  });

  it('treats an expired hold as available, not pending', async () => {
    await hold(customerA, [premium()[0].id]);
    await query(
      "UPDATE show_seats SET hold_expires_at = now() - interval '1 min' WHERE status = 'held'"
    );

    const res = await api().get('/api/dashboard/summary').set(auth(ctx.organiser));
    expect(res.body.events[0]).toMatchObject({ pending_seats: 0, available_seats: 6 });
  });

  it('shows only the calling organiser’s events', async () => {
    const res = await api().get('/api/dashboard/summary').set(auth(otherOrganiser));
    expect(res.body.events).toEqual([]);
    expect(res.body.totals.events).toBe(0);
  });

  it('shows every event to an admin', async () => {
    const res = await api().get('/api/dashboard/summary').set(auth(admin));
    expect(res.body.events).toHaveLength(1);
  });

  it('rejects a customer with 403', async () => {
    const res = await api().get('/api/dashboard/summary').set(auth(customerA));
    expect(res.status).toBe(403);
  });

  it('rejects an anonymous request with 401', async () => {
    const res = await api().get('/api/dashboard/summary');
    expect(res.status).toBe(401);
  });

  it('includes waitlist depth', async () => {
    // Sell out Premium then queue someone.
    await book(customerA, premium().map((s) => s.id));
    await api()
      .post('/api/waitlist')
      .set(auth(customerB))
      .send({ show_id: ctx.show.id, category: 'Premium' })
      .expect(201);

    const res = await api().get('/api/dashboard/summary').set(auth(ctx.organiser));
    expect(res.body.events[0].waitlist_waiting).toBe(1);
  });
});

describe('GET /api/dashboard/events/:id', () => {
  it('breaks results down per show', async () => {
    await book(customerA, [premium()[0].id]);

    const res = await api().get(`/api/dashboard/events/${ctx.event.id}`).set(auth(ctx.organiser));
    expect(res.status).toBe(200);
    expect(res.body.shows).toHaveLength(1);
    expect(res.body.shows[0]).toMatchObject({
      total_seats: 6,
      booked_seats: 1,
      available_seats: 5,
      bookings_confirmed: 1,
      revenue: '500.00',
    });
  });

  it('computes occupancy percentage', async () => {
    await book(customerA, [premium()[0].id, premium()[1].id, premium()[2].id]);

    const res = await api().get(`/api/dashboard/events/${ctx.event.id}`).set(auth(ctx.organiser));
    // 3 of 6 seats
    expect(Number(res.body.shows[0].occupancy_pct)).toBe(50.0);
  });

  it('breaks revenue down by category using the price actually paid', async () => {
    await book(customerA, [premium()[0].id]); // 500
    await book(customerB, [standard()[0].id, standard()[1].id]); // 400

    const res = await api().get(`/api/dashboard/events/${ctx.event.id}`).set(auth(ctx.organiser));
    expect(res.body.categories).toEqual([
      { category: 'Premium', total_seats: 3, booked_seats: 1, revenue: '500.00' },
      { category: 'Standard', total_seats: 3, booked_seats: 2, revenue: '400.00' },
    ]);
  });

  /**
   * The reason reports read booking_seats.price rather than joining show_pricing:
   * historical revenue must not move when an organiser re-prices a show.
   */
  it('does not rewrite past revenue when the price later changes', async () => {
    await book(customerA, [premium()[0].id]); // paid 500

    const before = await api()
      .get(`/api/dashboard/events/${ctx.event.id}`)
      .set(auth(ctx.organiser));
    expect(before.body.categories[0].revenue).toBe('500.00');

    // Organiser doubles the Premium price afterwards.
    await query("UPDATE show_pricing SET price = 1000 WHERE show_id = $1 AND category = 'Premium'", [
      ctx.show.id,
    ]);

    const after = await api().get(`/api/dashboard/events/${ctx.event.id}`).set(auth(ctx.organiser));
    expect(after.body.categories[0].revenue).toBe('500.00');
    expect(after.body.totals.revenue).toBe('500.00');
  });

  /**
   * Regression guard for row multiplication.
   *
   * A seat resold after cancellation has several booking_seats rows. Aggregating
   * seat counts across a join to that table counted the same seat once per sale,
   * so a 3-seat category reported 9 seats.
   */
  it('does not multiply seat counts when a seat has been resold', async () => {
    const seat = premium()[0];

    // Sell, cancel, resell, cancel, resell — three booking_seats rows for one seat.
    for (let i = 0; i < 2; i += 1) {
      const b = await book(customerA, [seat.id]);
      await api().post(`/api/bookings/${b.id}/cancel`).set(auth(customerA)).expect(200);
    }
    await book(customerB, [seat.id]);

    const { rows } = await query(
      'SELECT count(*)::int AS n FROM booking_seats WHERE show_seat_id = $1',
      [seat.id]
    );
    expect(rows[0].n).toBe(3); // the condition that used to break the count

    const res = await api().get(`/api/dashboard/events/${ctx.event.id}`).set(auth(ctx.organiser));
    const premiumCat = res.body.categories.find((c) => c.category === 'Premium');

    // Three Premium seats exist in the layout, exactly one is currently booked.
    expect(premiumCat.total_seats).toBe(3);
    expect(premiumCat.booked_seats).toBe(1);
    // Revenue counts only the surviving confirmed sale.
    expect(premiumCat.revenue).toBe('500.00');
  });

  it('reports waitlist status counts per category', async () => {
    await book(customerA, premium().map((s) => s.id));
    await api()
      .post('/api/waitlist')
      .set(auth(customerB))
      .send({ show_id: ctx.show.id, category: 'Premium' })
      .expect(201);

    const res = await api().get(`/api/dashboard/events/${ctx.event.id}`).set(auth(ctx.organiser));
    expect(res.body.waitlist).toEqual([
      { category: 'Premium', waiting: 1, offered: 0, fulfilled: 0, expired: 0 },
    ]);
  });

  it("forbids reading another organiser's event", async () => {
    const res = await api()
      .get(`/api/dashboard/events/${ctx.event.id}`)
      .set(auth(otherOrganiser));
    expect(res.status).toBe(403);
  });

  it('lets an admin read any event', async () => {
    const res = await api().get(`/api/dashboard/events/${ctx.event.id}`).set(auth(admin));
    expect(res.status).toBe(200);
  });

  it('returns 404 for an unknown event', async () => {
    const res = await api().get('/api/dashboard/events/999999').set(auth(ctx.organiser));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/dashboard/events/:id/bookings', () => {
  it('lists bookings with customer and seat detail', async () => {
    await book(customerA, [premium()[0].id, premium()[1].id]);

    const res = await api()
      .get(`/api/dashboard/events/${ctx.event.id}/bookings`)
      .set(auth(ctx.organiser));

    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
    expect(res.body.bookings[0]).toMatchObject({
      customer_name: 'Cust A',
      customer_email: customerA.email,
      status: 'confirmed',
      seat_count: 2,
      seats: 'A1, A2',
      total_amount: '1000.00',
    });
  });

  it('includes cancelled bookings, flagged as such', async () => {
    const booking = await book(customerA, [premium()[0].id]);
    await api().post(`/api/bookings/${booking.id}/cancel`).set(auth(customerA)).expect(200);

    const res = await api()
      .get(`/api/dashboard/events/${ctx.event.id}/bookings`)
      .set(auth(ctx.organiser));

    expect(res.body.bookings[0].status).toBe('cancelled');
    expect(res.body.bookings[0].cancelled_at).not.toBeNull();
  });

  it('orders newest first', async () => {
    await book(customerA, [premium()[0].id]);
    await book(customerB, [standard()[0].id]);

    const res = await api()
      .get(`/api/dashboard/events/${ctx.event.id}/bookings`)
      .set(auth(ctx.organiser));

    expect(res.body.bookings).toHaveLength(2);
    expect(new Date(res.body.bookings[0].created_at).getTime()).toBeGreaterThanOrEqual(
      new Date(res.body.bookings[1].created_at).getTime()
    );
  });

  it('respects the limit parameter', async () => {
    await book(customerA, [premium()[0].id]);
    await book(customerB, [standard()[0].id]);

    const res = await api()
      .get(`/api/dashboard/events/${ctx.event.id}/bookings?limit=1`)
      .set(auth(ctx.organiser));
    expect(res.body.bookings).toHaveLength(1);
  });

  it('rejects an invalid limit', async () => {
    const res = await api()
      .get(`/api/dashboard/events/${ctx.event.id}/bookings?limit=9999`)
      .set(auth(ctx.organiser));
    expect(res.status).toBe(400);
  });

  it("forbids another organiser's attendee list", async () => {
    const res = await api()
      .get(`/api/dashboard/events/${ctx.event.id}/bookings`)
      .set(auth(otherOrganiser));
    expect(res.status).toBe(403);
  });
});
