'use strict';

const {
  api,
  query,
  truncateAll,
  closePool,
  createUser,
  auth,
  createVenueWithLayout,
} = require('./helpers');

let admin;
let organiser;
let otherOrganiser;
let customer;
let venue;

const LAYOUT = [
  { row_label: 'A', seats: 5, category: 'Premium' },
  { row_label: 'B', seats: 5, category: 'Standard' },
];
const PRICING = { Premium: 500, Standard: 200 };

beforeEach(async () => {
  await truncateAll();
  admin = await createUser({ role: 'admin' });
  organiser = await createUser({ role: 'organiser' });
  otherOrganiser = await createUser({ role: 'organiser' });
  customer = await createUser({ role: 'customer' });
  venue = await createVenueWithLayout({ adminId: admin.id, layout: LAYOUT });
});

afterAll(closePool);

const newEvent = (as = organiser, body = {}) =>
  api()
    .post('/api/events')
    .set(auth(as))
    .send({ title: 'Interstellar', type: 'movie', venue_id: venue.id, ...body });

describe('POST /api/events', () => {
  it('lets an organiser create an event', async () => {
    const res = await newEvent();
    expect(res.status).toBe(201);
    expect(res.body.event).toMatchObject({
      title: 'Interstellar',
      type: 'movie',
      venue_id: venue.id,
      organiser_id: organiser.id,
    });
  });

  it('rejects event creation by a customer with 403', async () => {
    const res = await newEvent(customer);
    expect(res.status).toBe(403);
  });

  it('rejects an invalid event type', async () => {
    const res = await newEvent(organiser, { type: 'theatre' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/movie, concert/);
  });

  it('rejects an unknown venue with 404', async () => {
    const res = await newEvent(organiser, { venue_id: 999999 });
    expect(res.status).toBe(404);
  });

  it('refuses a venue that has no seat layout', async () => {
    const bare = (
      await query('INSERT INTO venues (name, address, created_by) VALUES ($1,$2,$3) RETURNING id', [
        'Empty Hall',
        'x',
        admin.id,
      ])
    ).rows[0];

    const res = await newEvent(organiser, { venue_id: bare.id });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/no seat layout/i);
  });
});

describe('POST /api/events/:id/shows — show_seats generation', () => {
  async function createEventId(as = organiser) {
    const res = await newEvent(as);
    return res.body.event.id;
  }

  it('generates one show_seat per venue_seat, all available', async () => {
    const eventId = await createEventId();

    const res = await api()
      .post(`/api/events/${eventId}/shows`)
      .set(auth(organiser))
      .send({ date: '2026-12-01', time: '19:00', pricing: PRICING });

    expect(res.status).toBe(201);
    expect(res.body.show.seats_created).toBe(10);

    const { rows } = await query(
      `SELECT status, count(*)::int AS n FROM show_seats WHERE show_id = $1 GROUP BY status`,
      [res.body.show.id]
    );
    expect(rows).toEqual([{ status: 'available', n: 10 }]);
  });

  it('copies each seat category from the venue layout', async () => {
    const eventId = await createEventId();
    const res = await api()
      .post(`/api/events/${eventId}/shows`)
      .set(auth(organiser))
      .send({ date: '2026-12-01', time: '19:00', pricing: PRICING });

    const { rows } = await query(
      `SELECT ss.category, count(*)::int AS n
         FROM show_seats ss WHERE ss.show_id = $1 GROUP BY ss.category ORDER BY ss.category`,
      [res.body.show.id]
    );
    expect(rows).toEqual([
      { category: 'Premium', n: 5 },
      { category: 'Standard', n: 5 },
    ]);
  });

  it('links each show_seat to the correct venue_seat', async () => {
    const eventId = await createEventId();
    const res = await api()
      .post(`/api/events/${eventId}/shows`)
      .set(auth(organiser))
      .send({ date: '2026-12-01', time: '19:00', pricing: PRICING });

    const { rows } = await query(
      `SELECT count(*)::int AS mismatched
         FROM show_seats ss JOIN venue_seats vs ON vs.id = ss.venue_seat_id
        WHERE ss.show_id = $1 AND (vs.venue_id <> $2 OR vs.category <> ss.category)`,
      [res.body.show.id, venue.id]
    );
    expect(rows[0].mismatched).toBe(0);
  });

  it('stores the pricing rows', async () => {
    const eventId = await createEventId();
    const res = await api()
      .post(`/api/events/${eventId}/shows`)
      .set(auth(organiser))
      .send({ date: '2026-12-01', time: '19:00', pricing: PRICING });

    const { rows } = await query(
      'SELECT category, price FROM show_pricing WHERE show_id = $1 ORDER BY category',
      [res.body.show.id]
    );
    expect(rows).toEqual([
      { category: 'Premium', price: '500.00' },
      { category: 'Standard', price: '200.00' },
    ]);
  });

  it('rejects a show whose pricing omits a venue category, and creates nothing', async () => {
    const eventId = await createEventId();

    const res = await api()
      .post(`/api/events/${eventId}/shows`)
      .set(auth(organiser))
      .send({ date: '2026-12-01', time: '19:00', pricing: { Premium: 500 } });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/missing for category/i);
    expect(res.body.error.details.missingCategories).toEqual(['Standard']);

    // The transaction must have left no trace.
    expect((await query('SELECT count(*)::int AS n FROM shows')).rows[0].n).toBe(0);
    expect((await query('SELECT count(*)::int AS n FROM show_seats')).rows[0].n).toBe(0);
    expect((await query('SELECT count(*)::int AS n FROM show_pricing')).rows[0].n).toBe(0);
  });

  it('rejects pricing for a category the venue does not have', async () => {
    const eventId = await createEventId();
    const res = await api()
      .post(`/api/events/${eventId}/shows`)
      .set(auth(organiser))
      .send({
        date: '2026-12-01',
        time: '19:00',
        pricing: { ...PRICING, VIPBalcony: 9000 },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.details.unknownCategories).toEqual(['VIPBalcony']);
  });

  it('rejects a duplicate date+time for the same event with 409 and creates no seats', async () => {
    const eventId = await createEventId();
    const body = { date: '2026-12-01', time: '19:00', pricing: PRICING };

    const first = await api().post(`/api/events/${eventId}/shows`).set(auth(organiser)).send(body);
    expect(first.status).toBe(201);

    const second = await api().post(`/api/events/${eventId}/shows`).set(auth(organiser)).send(body);
    expect(second.status).toBe(409);

    expect((await query('SELECT count(*)::int AS n FROM shows')).rows[0].n).toBe(1);
    expect((await query('SELECT count(*)::int AS n FROM show_seats')).rows[0].n).toBe(10);
  });

  it("forbids an organiser from adding a show to another organiser's event", async () => {
    const eventId = await createEventId(organiser);

    const res = await api()
      .post(`/api/events/${eventId}/shows`)
      .set(auth(otherOrganiser))
      .send({ date: '2026-12-01', time: '19:00', pricing: PRICING });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/only modify events you created/i);
  });

  it("allows an admin to add a show to any organiser's event", async () => {
    const eventId = await createEventId(organiser);
    const res = await api()
      .post(`/api/events/${eventId}/shows`)
      .set(auth(admin))
      .send({ date: '2026-12-01', time: '19:00', pricing: PRICING });
    expect(res.status).toBe(201);
  });

  it.each([
    ['bad date', { date: '01-12-2026', time: '19:00', pricing: PRICING }],
    ['impossible date', { date: '2026-02-31', time: '19:00', pricing: PRICING }],
    ['bad time', { date: '2026-12-01', time: '7pm', pricing: PRICING }],
    ['impossible time', { date: '2026-12-01', time: '25:00', pricing: PRICING }],
    ['pricing not an object', { date: '2026-12-01', time: '19:00', pricing: [500] }],
    ['negative price', { date: '2026-12-01', time: '19:00', pricing: { Premium: -1, Standard: 1 } }],
    ['empty pricing', { date: '2026-12-01', time: '19:00', pricing: {} }],
  ])('rejects invalid show input: %s', async (_label, body) => {
    const eventId = await createEventId();
    const res = await api().post(`/api/events/${eventId}/shows`).set(auth(organiser)).send(body);
    expect(res.status).toBe(400);
  });

  it('accepts HH:MM:SS as well as HH:MM', async () => {
    const eventId = await createEventId();
    const res = await api()
      .post(`/api/events/${eventId}/shows`)
      .set(auth(organiser))
      .send({ date: '2026-12-01', time: '19:30:00', pricing: PRICING });
    expect(res.status).toBe(201);
  });
});

describe('GET /api/events — browse and filter', () => {
  async function seedTwoEvents() {
    const movie = (await newEvent(organiser, { title: 'Dune', type: 'movie' })).body.event;
    const concert = (await newEvent(organiser, { title: 'Coldplay Live', type: 'concert' })).body
      .event;

    await api()
      .post(`/api/events/${movie.id}/shows`)
      .set(auth(organiser))
      .send({ date: '2026-12-01', time: '19:00', pricing: PRICING });
    await api()
      .post(`/api/events/${concert.id}/shows`)
      .set(auth(organiser))
      .send({ date: '2027-01-15', time: '20:00', pricing: PRICING });

    return { movie, concert };
  }

  it('is publicly readable with no token', async () => {
    await seedTwoEvents();
    const res = await api().get('/api/events');
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
  });

  it('hides events that have no shows yet', async () => {
    await newEvent(organiser, { title: 'Showless' });
    const res = await api().get('/api/events');
    expect(res.body.events).toHaveLength(0);
  });

  it('filters by type', async () => {
    await seedTwoEvents();
    const res = await api().get('/api/events?type=concert');
    expect(res.body.events.map((e) => e.title)).toEqual(['Coldplay Live']);
  });

  it('filters by date range', async () => {
    await seedTwoEvents();
    const res = await api().get('/api/events?date_from=2026-11-01&date_to=2026-12-31');
    expect(res.body.events.map((e) => e.title)).toEqual(['Dune']);
  });

  it('returns each event once even with several shows', async () => {
    const { movie } = await seedTwoEvents();
    await api()
      .post(`/api/events/${movie.id}/shows`)
      .set(auth(organiser))
      .send({ date: '2026-12-02', time: '19:00', pricing: PRICING });
    await api()
      .post(`/api/events/${movie.id}/shows`)
      .set(auth(organiser))
      .send({ date: '2026-12-03', time: '19:00', pricing: PRICING });

    const res = await api().get('/api/events?type=movie');
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].show_count).toBe(3);
  });

  it('includes venue name, organiser name and a from_price', async () => {
    await seedTwoEvents();
    const res = await api().get('/api/events?type=movie');
    expect(res.body.events[0]).toMatchObject({
      venue_name: venue.name,
      organiser_name: organiser.name,
      from_price: '200.00',
    });
  });

  it('rejects a reversed date range', async () => {
    const res = await api().get('/api/events?date_from=2027-01-01&date_to=2026-01-01');
    expect(res.status).toBe(400);
  });

  it('is not vulnerable to SQL injection through the search filter', async () => {
    await seedTwoEvents();
    const res = await api().get("/api/events?q=%27%3B%20DROP%20TABLE%20events%3B%20--");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(0);
    // The table must still be there.
    expect((await query('SELECT count(*)::int AS n FROM events')).rows[0].n).toBe(2);
  });

  it('scopes /mine to the calling organiser', async () => {
    await seedTwoEvents();
    const mine = await api().get('/api/events/mine').set(auth(otherOrganiser));
    expect(mine.body.events).toHaveLength(0);

    const theirs = await api().get('/api/events/mine').set(auth(organiser));
    expect(theirs.body.events).toHaveLength(2);
  });

  /**
   * Regression: a brand-new event was invisible to the organiser who had just made it.
   *
   * /mine shared the public list's "must have at least one show" filter, so a freshly
   * created event was missing from the picker used to add its first showing — while
   * still appearing on the dashboard, which reads a different query. Created, listed
   * on one screen, and impossible to finish on the other.
   */
  it('lists an organiser own event that has no showings yet', async () => {
    const created = (await newEvent(organiser, { title: 'Draft With No Shows' })).body.event;

    const mine = await api().get('/api/events/mine').set(auth(organiser));
    expect(mine.status).toBe(200);
    expect(mine.body.events.map((e) => e.id)).toContain(created.id);
    // Reported honestly as having nothing scheduled, rather than hidden.
    const row = mine.body.events.find((e) => e.id === created.id);
    expect(row.show_count).toBe(0);
    expect(row.next_show_date).toBeNull();
  });

  it('still hides a showless event from the public browse list', async () => {
    const created = (await newEvent(organiser, { title: 'Draft Not Public' })).body.event;

    const publicList = await api().get('/api/events');
    expect(publicList.status).toBe(200);
    expect(publicList.body.events.map((e) => e.id)).not.toContain(created.id);

    // Nor via search: an unbookable event must not surface anywhere customer-facing.
    const searched = await api().get('/api/events?q=Draft+Not+Public');
    expect(searched.body.events).toHaveLength(0);
  });

  /**
   * A date filter is a question about showings, so it must still exclude an event that
   * has none — even with `requireShow: false`. Asserted against the service directly:
   * GET /events/mine intentionally takes no query parameters, so the route cannot
   * exercise this combination.
   */
  it('excludes a showless event when a date filter is supplied, even without requireShow', async () => {
    const eventService = require('../src/services/eventService');
    await newEvent(organiser, { title: 'Showless For Date Filter' });

    const unfiltered = await eventService.listEvents({ requireShow: false });
    expect(unfiltered.map((e) => e.title)).toContain('Showless For Date Filter');

    const dated = await eventService.listEvents({ requireShow: false, dateFrom: '2099-01-01' });
    expect(dated.map((e) => e.title)).not.toContain('Showless For Date Filter');
  });
});

describe('GET /api/events/:id', () => {
  it('returns shows with pricing and availability counts', async () => {
    const event = (await newEvent()).body.event;
    await api()
      .post(`/api/events/${event.id}/shows`)
      .set(auth(organiser))
      .send({ date: '2026-12-01', time: '19:00', pricing: PRICING });

    const res = await api().get(`/api/events/${event.id}`);
    expect(res.status).toBe(200);
    expect(res.body.event.shows).toHaveLength(1);
    expect(res.body.event.shows[0]).toMatchObject({
      total_seats: 10,
      available_seats: 10,
      booked_seats: 0,
    });
    expect(res.body.event.shows[0].pricing).toEqual([
      { category: 'Premium', price: '500.00' },
      { category: 'Standard', price: '200.00' },
    ]);
  });

  it('counts a seat whose hold has expired as available', async () => {
    const event = (await newEvent()).body.event;
    const show = (
      await api()
        .post(`/api/events/${event.id}/shows`)
        .set(auth(organiser))
        .send({ date: '2026-12-01', time: '19:00', pricing: PRICING })
    ).body.show;

    // Hold a seat with a deadline already in the past, without running the sweeper.
    await query(
      `UPDATE show_seats
          SET status='held', held_by=$1, hold_expires_at = now() - interval '1 minute'
        WHERE id = (SELECT min(id) FROM show_seats WHERE show_id = $2)`,
      [customer.id, show.id]
    );

    const res = await api().get(`/api/events/${event.id}`);
    expect(res.body.event.shows[0].available_seats).toBe(10);
  });

  it('returns 404 for an unknown event', async () => {
    const res = await api().get('/api/events/999999');
    expect(res.status).toBe(404);
  });

  /**
   * Regression guard. pg's default DATE parser produces a local-midnight Date,
   * which JSON serialisation then shifts into the previous calendar day for any
   * timezone east of UTC — a show created for the 15th was served as the 14th.
   * db.js overrides the DATE parser to pass the string through untouched.
   */
  it('returns the exact calendar date it was given, with no timezone shift', async () => {
    const event = (await newEvent()).body.event;
    await api()
      .post(`/api/events/${event.id}/shows`)
      .set(auth(organiser))
      .send({ date: '2026-09-15', time: '19:30', pricing: PRICING });

    const detail = await api().get(`/api/events/${event.id}`);
    expect(detail.body.event.shows[0].date).toBe('2026-09-15');
    expect(detail.body.event.shows[0].time).toBe('19:30:00');

    const browse = await api().get('/api/events');
    expect(browse.body.events[0].next_show_date).toBe('2026-09-15');
  });

  it('returns money as an exact decimal string, never a float', async () => {
    const event = (await newEvent()).body.event;
    await api()
      .post(`/api/events/${event.id}/shows`)
      .set(auth(organiser))
      .send({ date: '2026-12-01', time: '19:00', pricing: { Premium: 999.99, Standard: 0.1 } });

    const detail = await api().get(`/api/events/${event.id}`);
    const prices = detail.body.event.shows[0].pricing;
    expect(prices).toEqual([
      { category: 'Premium', price: '999.99' },
      { category: 'Standard', price: '0.10' },
    ]);
    for (const p of prices) expect(typeof p.price).toBe('string');
  });
});

describe('DELETE show', () => {
  it('deletes an unsold show and its seats', async () => {
    const event = (await newEvent()).body.event;
    const show = (
      await api()
        .post(`/api/events/${event.id}/shows`)
        .set(auth(organiser))
        .send({ date: '2026-12-01', time: '19:00', pricing: PRICING })
    ).body.show;

    const res = await api()
      .delete(`/api/events/${event.id}/shows/${show.id}`)
      .set(auth(organiser));

    expect(res.status).toBe(204);
    expect((await query('SELECT count(*)::int AS n FROM show_seats')).rows[0].n).toBe(0);
  });
});
