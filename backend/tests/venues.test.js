'use strict';

const { api, query, truncateAll, closePool, createUser, auth } = require('./helpers');

let admin;
let organiser;
let customer;

beforeEach(async () => {
  await truncateAll();
  admin = await createUser({ role: 'admin' });
  organiser = await createUser({ role: 'organiser' });
  customer = await createUser({ role: 'customer' });
});

afterAll(closePool);

const LAYOUT = [
  { row_label: 'A', seats: 10, category: 'Premium' },
  { row_label: 'B', seats: 10, category: 'Standard' },
  { row_label: 'C', seats: 10, category: 'Standard' },
];

describe('role enforcement on venue writes', () => {
  it('lets an admin create a venue', async () => {
    const res = await api()
      .post('/api/venues')
      .set(auth(admin))
      .send({ name: 'Regal Cinema', address: '5 High St' });

    expect(res.status).toBe(201);
    expect(res.body.venue).toMatchObject({ name: 'Regal Cinema', address: '5 High St' });
    expect(res.body.venue.created_by).toBe(admin.id);
  });

  it.each([
    ['organiser', () => organiser],
    ['customer', () => customer],
  ])('rejects venue creation by a %s with 403', async (_role, getUser) => {
    const res = await api().post('/api/venues').set(auth(getUser())).send({ name: 'Nope' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect((await query('SELECT count(*)::int AS n FROM venues')).rows[0].n).toBe(0);
  });

  it('rejects venue creation with no token as 401', async () => {
    const res = await api().post('/api/venues').send({ name: 'Nope' });
    expect(res.status).toBe(401);
  });

  it('lets an organiser read venues (needed to attach an event to one)', async () => {
    await api().post('/api/venues').set(auth(admin)).send({ name: 'Readable' });

    const res = await api().get('/api/venues').set(auth(organiser));
    expect(res.status).toBe(200);
    expect(res.body.venues).toHaveLength(1);
  });
});

describe('seat layout generation', () => {
  it('generates exactly rows x seats venue_seats', async () => {
    const created = await api().post('/api/venues').set(auth(admin)).send({ name: 'V' });
    const venueId = created.body.venue.id;

    const res = await api()
      .put(`/api/venues/${venueId}/layout`)
      .set(auth(admin))
      .send({ layout: LAYOUT });

    expect(res.status).toBe(200);
    expect(res.body.seats_created).toBe(30);

    const { rows } = await query('SELECT count(*)::int AS n FROM venue_seats WHERE venue_id = $1', [
      venueId,
    ]);
    expect(rows[0].n).toBe(30);
  });

  it('assigns the right category to each row and numbers seats from 1', async () => {
    const created = await api()
      .post('/api/venues')
      .set(auth(admin))
      .send({ name: 'V', layout: LAYOUT });
    const venueId = created.body.venue.id;

    const { rows } = await query(
      `SELECT row_label, category, min(seat_number)::int AS lo, max(seat_number)::int AS hi, count(*)::int AS n
         FROM venue_seats WHERE venue_id = $1 GROUP BY row_label, category ORDER BY row_label`,
      [venueId]
    );

    expect(rows).toEqual([
      { row_label: 'A', category: 'Premium', lo: 1, hi: 10, n: 10 },
      { row_label: 'B', category: 'Standard', lo: 1, hi: 10, n: 10 },
      { row_label: 'C', category: 'Standard', lo: 1, hi: 10, n: 10 },
    ]);
  });

  it('is idempotent — re-posting the same layout leaves 30 seats, not 60', async () => {
    const created = await api().post('/api/venues').set(auth(admin)).send({ name: 'V' });
    const venueId = created.body.venue.id;

    await api().put(`/api/venues/${venueId}/layout`).set(auth(admin)).send({ layout: LAYOUT });
    const second = await api()
      .put(`/api/venues/${venueId}/layout`)
      .set(auth(admin))
      .send({ layout: LAYOUT });

    expect(second.status).toBe(200);
    const { rows } = await query('SELECT count(*)::int AS n FROM venue_seats WHERE venue_id = $1', [
      venueId,
    ]);
    expect(rows[0].n).toBe(30);
  });

  it('can create a venue and its layout in one request', async () => {
    const res = await api()
      .post('/api/venues')
      .set(auth(admin))
      .send({ name: 'One Shot', address: 'x', layout: LAYOUT });

    expect(res.status).toBe(201);
    expect(res.body.venue.seat_count).toBe(30);
    expect(res.body.venue.categories).toEqual(['Premium', 'Standard']);
    expect(res.body.venue.rows).toHaveLength(3);
  });

  it('rejects duplicate row labels', async () => {
    const created = await api().post('/api/venues').set(auth(admin)).send({ name: 'V' });
    const res = await api()
      .put(`/api/venues/${created.body.venue.id}/layout`)
      .set(auth(admin))
      .send({
        layout: [
          { row_label: 'A', seats: 5, category: 'Premium' },
          { row_label: 'A', seats: 5, category: 'Standard' },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/duplicate row label/i);
  });

  it.each([
    ['empty layout', []],
    ['zero seats', [{ row_label: 'A', seats: 0, category: 'P' }]],
    ['negative seats', [{ row_label: 'A', seats: -5, category: 'P' }]],
    ['absurd seat count (DoS guard)', [{ row_label: 'A', seats: 100000000, category: 'P' }]],
    ['missing category', [{ row_label: 'A', seats: 5 }]],
    ['blank row label', [{ row_label: '   ', seats: 5, category: 'P' }]],
  ])('rejects invalid layout: %s', async (_label, layout) => {
    const created = await api().post('/api/venues').set(auth(admin)).send({ name: 'V' });
    const res = await api()
      .put(`/api/venues/${created.body.venue.id}/layout`)
      .set(auth(admin))
      .send({ layout });

    expect(res.status).toBe(400);
  });
});

describe('layout lock once shows exist', () => {
  /** Create a show directly so this suite does not depend on the shows API. */
  async function createShowAtVenue(venueId) {
    const event = (
      await query(
        `INSERT INTO events (title, type, organiser_id, venue_id)
         VALUES ('E', 'movie', $1, $2) RETURNING id`,
        [organiser.id, venueId]
      )
    ).rows[0];
    await query("INSERT INTO shows (event_id, date, time) VALUES ($1, '2026-12-01', '19:00')", [
      event.id,
    ]);
  }

  it('refuses to redefine a layout once a show exists', async () => {
    const created = await api()
      .post('/api/venues')
      .set(auth(admin))
      .send({ name: 'Locked', layout: LAYOUT });
    const venueId = created.body.venue.id;

    await createShowAtVenue(venueId);

    const res = await api()
      .put(`/api/venues/${venueId}/layout`)
      .set(auth(admin))
      .send({ layout: [{ row_label: 'Z', seats: 1, category: 'Premium' }] });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already been created/i);

    // The original layout must survive the rejected attempt.
    const { rows } = await query('SELECT count(*)::int AS n FROM venue_seats WHERE venue_id = $1', [
      venueId,
    ]);
    expect(rows[0].n).toBe(30);
  });

  it('reports locked=true in venue detail once a show exists', async () => {
    const created = await api()
      .post('/api/venues')
      .set(auth(admin))
      .send({ name: 'L', layout: LAYOUT });
    const venueId = created.body.venue.id;

    let detail = await api().get(`/api/venues/${venueId}`).set(auth(admin));
    expect(detail.body.venue.locked).toBe(false);

    await createShowAtVenue(venueId);

    detail = await api().get(`/api/venues/${venueId}`).set(auth(admin));
    expect(detail.body.venue.locked).toBe(true);
    expect(detail.body.venue.show_count).toBe(1);
  });
});

describe('venue update and lookup', () => {
  it('renames a venue', async () => {
    const created = await api().post('/api/venues').set(auth(admin)).send({ name: 'Old Name' });

    const res = await api()
      .patch(`/api/venues/${created.body.venue.id}`)
      .set(auth(admin))
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.venue.name).toBe('New Name');
  });

  it('rejects an update with no fields', async () => {
    const created = await api().post('/api/venues').set(auth(admin)).send({ name: 'V' });
    const res = await api()
      .patch(`/api/venues/${created.body.venue.id}`)
      .set(auth(admin))
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown venue', async () => {
    const res = await api().get('/api/venues/999999').set(auth(admin));
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-numeric venue id', async () => {
    const res = await api().get('/api/venues/abc').set(auth(admin));
    expect(res.status).toBe(400);
  });
});
