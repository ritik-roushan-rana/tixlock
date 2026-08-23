'use strict';

/**
 * Events, shows, pricing, and show_seats generation.
 *
 * The important function here is createShow: it materialises sellable inventory
 * from the venue's seat template and must be all-or-nothing.
 */

const { query, withTransaction } = require('../config/db');
const { notFound, forbidden, conflict, badRequest } = require('../lib/errors');

const EVENT_TYPES = ['movie', 'concert'];

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

async function createEvent({ title, type, description, venueId, organiserId }) {
  // Confirm the venue exists and has seats. An event at a venue with no layout
  // would produce shows with zero seats, which looks like a platform bug to a
  // customer; better to refuse at the point the mistake is made.
  const { rows: venueRows } = await query(
    `SELECT v.id, count(vs.id)::int AS seat_count
       FROM venues v
       LEFT JOIN venue_seats vs ON vs.venue_id = v.id
      WHERE v.id = $1
      GROUP BY v.id`,
    [venueId]
  );
  const venue = venueRows[0];
  if (!venue) throw notFound(`Venue ${venueId} not found`);
  if (venue.seat_count === 0) {
    throw conflict(
      'That venue has no seat layout yet. Ask an admin to define its seat layout before creating events there.'
    );
  }

  const { rows } = await query(
    `INSERT INTO events (title, type, organiser_id, venue_id, description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [title, type, organiserId, venueId, description]
  );
  return rows[0];
}

/**
 * Browse events with optional filters.
 *
 * Filters are applied as dynamic-but-parameterised SQL. Values always travel as
 * bound parameters ($1, $2, ...) — never interpolated into the string — so this
 * stays injection-proof despite the clause list being built at runtime.
 */
async function listEvents({
  type,
  dateFrom,
  dateTo,
  venueId,
  organiserId,
  search,
  upcomingOnly,
  /**
   * Require at least one show for the event to be listed. True for the public browse,
   * because an event with no showing cannot be booked and would be a dead link.
   *
   * The organiser's own list must pass false. It shared this default, which made a
   * freshly created event invisible to its own creator: it appeared on the dashboard
   * (fed by a different query) but was missing from the "New showing" event picker,
   * which reads this list — so there was no way to give it the very showing it needed
   * to become visible. Created, listed, and impossible to finish.
   */
  requireShow = true,
} = {}) {
  const where = [];
  const params = [];
  const add = (clause, value) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };

  if (type) add('e.type = ?', type);
  if (venueId) add('e.venue_id = ?', venueId);
  if (organiserId) add('e.organiser_id = ?', organiserId);

  // One search term across title, venue and description. It used to match the title
  // alone, which quietly contradicted the UI: the box has always been labelled
  // "Search events, venues…", so a venue name returned nothing.
  //
  // Written out rather than passed through `add()` because that helper substitutes a
  // single placeholder per call, and this needs one bound value referenced three
  // times. Still parameterised — the value never enters the string.
  if (search) {
    params.push(`%${search}%`);
    const term = `$${params.length}`;
    where.push(`(e.title ILIKE ${term} OR v.name ILIKE ${term} OR e.description ILIKE ${term})`);
  }

  // Date filters constrain which *shows* count, and an event only appears if it
  // still has a matching show. EXISTS rather than a JOIN so an event with 20
  // shows is not returned 20 times.
  const showConds = ['s.event_id = e.id'];
  if (dateFrom) {
    params.push(dateFrom);
    showConds.push(`s.date >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    showConds.push(`s.date <= $${params.length}`);
  }
  if (upcomingOnly) showConds.push('(s.date + s.time) >= now()');

  // A date filter is a statement about showings, so it still implies the event must
  // have one that matches — even for the organiser's own list, where asking for
  // "events in September" cannot sensibly return an event with no dates at all.
  const hasDateFilter = Boolean(dateFrom || dateTo || upcomingOnly);
  if (requireShow || hasDateFilter) {
    where.push(`EXISTS (SELECT 1 FROM shows s WHERE ${showConds.join(' AND ')})`);
  }

  const sql = `
    SELECT e.*,
           v.name AS venue_name,
           v.address AS venue_address,
           u.name AS organiser_name,
           (SELECT count(*)::int FROM shows s2 WHERE s2.event_id = e.id) AS show_count,
           (SELECT min(s3.date) FROM shows s3 WHERE s3.event_id = e.id) AS next_show_date,
           (SELECT min(sp.price) FROM show_pricing sp
              JOIN shows s4 ON s4.id = sp.show_id
             WHERE s4.event_id = e.id) AS from_price
      FROM events e
      JOIN venues v ON v.id = e.venue_id
      JOIN users u  ON u.id = e.organiser_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY next_show_date NULLS LAST, e.title
  `;

  const { rows } = await query(sql, params);
  return rows;
}

async function getEvent(eventId) {
  const { rows } = await query(
    `SELECT e.*, v.name AS venue_name, v.address AS venue_address, u.name AS organiser_name
       FROM events e
       JOIN venues v ON v.id = e.venue_id
       JOIN users u  ON u.id = e.organiser_id
      WHERE e.id = $1`,
    [eventId]
  );
  if (!rows[0]) throw notFound(`Event ${eventId} not found`);
  return rows[0];
}

/** Event detail plus its shows, each with pricing and live availability counts. */
async function getEventWithShows(eventId) {
  const event = await getEvent(eventId);

  const { rows: shows } = await query(
    `SELECT s.id, s.date, s.time, s.created_at,
            count(ss.id)::int AS total_seats,
            -- An expired hold is really an available seat; count it as one so the
            -- browse list never understates availability just because the sweeper
            -- has not fired in the last few seconds.
            count(*) FILTER (
              WHERE ss.status = 'available'
                 OR (ss.status IN ('held','offered') AND ss.hold_expires_at < now())
            )::int AS available_seats,
            count(*) FILTER (WHERE ss.status = 'booked')::int AS booked_seats
       FROM shows s
       LEFT JOIN show_seats ss ON ss.show_id = s.id
      WHERE s.event_id = $1
      GROUP BY s.id
      ORDER BY s.date, s.time`,
    [eventId]
  );

  const { rows: pricing } = await query(
    `SELECT sp.show_id, sp.category, sp.price
       FROM show_pricing sp
       JOIN shows s ON s.id = sp.show_id
      WHERE s.event_id = $1
      ORDER BY sp.category`,
    [eventId]
  );

  const pricingByShow = new Map();
  for (const p of pricing) {
    if (!pricingByShow.has(p.show_id)) pricingByShow.set(p.show_id, []);
    pricingByShow.get(p.show_id).push({ category: p.category, price: p.price });
  }

  return {
    ...event,
    shows: shows.map((s) => ({ ...s, pricing: pricingByShow.get(s.id) || [] })),
  };
}

/**
 * Load an event and assert the caller may modify it.
 *
 * Admins pass regardless of ownership; organisers only for their own events.
 * Returning 404 for a non-existent event but 403 for someone else's is
 * intentional — an organiser probing ids learns only that an event exists, which
 * is already public information via the browse endpoint.
 */
async function assertEventOwner(eventId, user) {
  const event = await getEvent(eventId);
  if (user.role === 'admin') return event;
  if (event.organiser_id !== user.id) {
    throw forbidden('You can only modify events you created');
  }
  return event;
}

// ---------------------------------------------------------------------------
// Shows
// ---------------------------------------------------------------------------

/**
 * Create a show and materialise its sellable seats.
 *
 * Everything happens in one transaction: the shows row, one show_seats row per
 * venue_seat, and the pricing rows. If any part fails — a duplicate slot, a
 * missing price, a constraint violation — the whole thing rolls back and no
 * partial show is left behind for customers to find.
 *
 * `pricing` is required and must cover every category present in the venue's
 * layout. A show with an unpriced category is unbookable in a way that only
 * surfaces at checkout, so it is rejected at creation instead.
 */
async function createShow({ eventId, date, time, pricing }) {
  return withTransaction(async (client) => {
    // Lock the event row so a concurrent venue-layout change or duplicate show
    // creation for the same event serialises behind us.
    const { rows: eventRows } = await client.query(
      'SELECT id, venue_id FROM events WHERE id = $1 FOR UPDATE',
      [eventId]
    );
    const event = eventRows[0];
    if (!event) throw notFound(`Event ${eventId} not found`);

    // What categories does this venue actually have?
    const { rows: catRows } = await client.query(
      'SELECT DISTINCT category FROM venue_seats WHERE venue_id = $1 ORDER BY category',
      [event.venue_id]
    );
    const venueCategories = catRows.map((r) => r.category);
    if (venueCategories.length === 0) {
      throw conflict('The venue for this event has no seat layout, so a show cannot be created');
    }

    const pricedCategories = new Set(Object.keys(pricing));
    const missing = venueCategories.filter((c) => !pricedCategories.has(c));
    if (missing.length > 0) {
      throw badRequest(
        `Pricing is missing for category/categories: ${missing.join(', ')}. ` +
          `This venue has these categories: ${venueCategories.join(', ')}.`,
        { missingCategories: missing, venueCategories }
      );
    }
    const unknown = [...pricedCategories].filter((c) => !venueCategories.includes(c));
    if (unknown.length > 0) {
      throw badRequest(
        `Pricing supplied for category/categories that do not exist at this venue: ${unknown.join(', ')}`,
        { unknownCategories: unknown, venueCategories }
      );
    }

    let show;
    try {
      const { rows } = await client.query(
        'INSERT INTO shows (event_id, date, time) VALUES ($1, $2, $3) RETURNING *',
        [eventId, date, time]
      );
      show = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        throw conflict(`This event already has a show on ${date} at ${time}`);
      }
      throw err;
    }

    // Generate inventory. One INSERT ... SELECT rather than a loop: a 500-seat
    // venue becomes a single statement instead of 500 round trips, and it cannot
    // interleave with anything because it is one atomic statement.
    const { rowCount: seatsCreated } = await client.query(
      `INSERT INTO show_seats (show_id, venue_seat_id, category, status)
       SELECT $1, vs.id, vs.category, 'available'
         FROM venue_seats vs
        WHERE vs.venue_id = $2`,
      [show.id, event.venue_id]
    );

    for (const [category, price] of Object.entries(pricing)) {
      await client.query(
        'INSERT INTO show_pricing (show_id, category, price) VALUES ($1, $2, $3)',
        [show.id, category, price]
      );
    }

    return { ...show, seats_created: seatsCreated, pricing };
  });
}

async function getShow(showId) {
  const { rows } = await query(
    `SELECT s.*, e.title AS event_title, e.type AS event_type, e.organiser_id,
            e.venue_id, v.name AS venue_name, v.address AS venue_address
       FROM shows s
       JOIN events e ON e.id = s.event_id
       JOIN venues v ON v.id = e.venue_id
      WHERE s.id = $1`,
    [showId]
  );
  if (!rows[0]) throw notFound(`Show ${showId} not found`);
  return rows[0];
}

async function getShowPricing(showId) {
  const { rows } = await query(
    'SELECT category, price FROM show_pricing WHERE show_id = $1 ORDER BY category',
    [showId]
  );
  return rows;
}

async function deleteShow(showId) {
  // Refuse if anything has been sold — deleting would orphan a customer's ticket.
  const { rows } = await query(
    `SELECT count(*)::int AS n
       FROM booking_seats bs
       JOIN show_seats ss ON ss.id = bs.show_seat_id
       JOIN bookings b ON b.id = bs.booking_id
      WHERE ss.show_id = $1 AND b.status = 'confirmed'`,
    [showId]
  );
  if (rows[0].n > 0) {
    throw conflict(`Cannot delete this show: ${rows[0].n} seat(s) have been booked`);
  }
  await query('DELETE FROM shows WHERE id = $1', [showId]);
}

module.exports = {
  EVENT_TYPES,
  createEvent,
  listEvents,
  getEvent,
  getEventWithShows,
  assertEventOwner,
  createShow,
  getShow,
  getShowPricing,
  deleteShow,
};
