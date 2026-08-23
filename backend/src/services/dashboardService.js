'use strict';

/**
 * Organiser reporting: booking summaries and revenue.
 *
 * Two rules run through every query here.
 *
 * RULE 1 — Revenue counts confirmed bookings only.
 *
 * A cancelled booking is not income. Every money aggregate filters on
 * `b.status = 'confirmed'`, and because the filter has to be applied consistently
 * across several aggregates in the same scan, it is expressed with
 * `FILTER (WHERE ...)` rather than a WHERE clause — that way one pass over the rows
 * can produce both gross and cancelled figures without a self-join.
 *
 * RULE 2 — Money comes from booking_seats.price, not from show_pricing.
 *
 * booking_seats.price is what the customer actually paid, captured at the moment of
 * sale. show_pricing is what the seat costs *today*. Joining live pricing into a
 * revenue report would silently rewrite history the instant an organiser adjusted a
 * price: yesterday's takings would change. Reporting on the captured price keeps the
 * numbers stable and auditable.
 */

const { query } = require('../config/db');
const { notFound, forbidden } = require('../lib/errors');

/**
 * One row per event owned by the organiser, with totals across all its shows.
 *
 * Aggregates are computed in two independent subqueries rather than one big join.
 * Joining bookings and show_seats together would multiply rows — a booking with 3
 * seats crossed against 46 show_seats gives 138 rows — and every count would be
 * inflated. Aggregating each side separately and joining the already-collapsed
 * results keeps the numbers correct.
 */
async function getOrganiserSummary(organiserId, { includeAll = false } = {}) {
  const { rows } = await query(
    `
    WITH my_events AS (
      SELECT e.id, e.title, e.type::text AS type, e.created_at, e.venue_id,
             v.name AS venue_name
        FROM events e
        JOIN venues v ON v.id = e.venue_id
       WHERE ($2::boolean OR e.organiser_id = $1)
    ),
    seat_stats AS (
      SELECT s.event_id,
             count(DISTINCT s.id)::int AS show_count,
             count(ss.id)::int         AS total_seats,
             count(*) FILTER (WHERE ss.status = 'booked')::int AS booked_seats,
             count(*) FILTER (
               WHERE ss.status = 'available'
                  OR (ss.status IN ('held','offered') AND ss.hold_expires_at < now())
             )::int AS available_seats,
             count(*) FILTER (
               WHERE ss.status IN ('held','offered') AND ss.hold_expires_at >= now()
             )::int AS pending_seats
        FROM shows s
        LEFT JOIN show_seats ss ON ss.show_id = s.id
       GROUP BY s.event_id
    ),
    booking_stats AS (
      SELECT s.event_id,
             count(DISTINCT b.id) FILTER (WHERE b.status = 'confirmed')::int AS bookings_confirmed,
             count(DISTINCT b.id) FILTER (WHERE b.status = 'cancelled')::int AS bookings_cancelled,
             -- Revenue: confirmed only. Cancelled value tracked separately so an
             -- organiser can see what they lost without it polluting the total.
             COALESCE(sum(b.total_amount) FILTER (WHERE b.status = 'confirmed'), 0)::numeric(12,2) AS revenue,
             COALESCE(sum(b.total_amount) FILTER (WHERE b.status = 'cancelled'), 0)::numeric(12,2) AS cancelled_value
        FROM shows s
        LEFT JOIN bookings b ON b.show_id = s.id
       GROUP BY s.event_id
    ),
    waitlist_stats AS (
      SELECT s.event_id,
             count(*) FILTER (WHERE w.status = 'waiting')::int AS waitlist_waiting,
             count(*) FILTER (WHERE w.status = 'offered')::int AS waitlist_offered
        FROM shows s
        LEFT JOIN waitlist w ON w.show_id = s.id
       GROUP BY s.event_id
    )
    SELECT me.*,
           COALESCE(ss.show_count, 0)          AS show_count,
           COALESCE(ss.total_seats, 0)         AS total_seats,
           COALESCE(ss.booked_seats, 0)        AS booked_seats,
           COALESCE(ss.available_seats, 0)     AS available_seats,
           COALESCE(ss.pending_seats, 0)       AS pending_seats,
           COALESCE(bs.bookings_confirmed, 0)  AS bookings_confirmed,
           COALESCE(bs.bookings_cancelled, 0)  AS bookings_cancelled,
           COALESCE(bs.revenue, 0)             AS revenue,
           COALESCE(bs.cancelled_value, 0)     AS cancelled_value,
           COALESCE(ws.waitlist_waiting, 0)    AS waitlist_waiting,
           COALESCE(ws.waitlist_offered, 0)    AS waitlist_offered
      FROM my_events me
      LEFT JOIN seat_stats ss     ON ss.event_id = me.id
      LEFT JOIN booking_stats bs  ON bs.event_id = me.id
      LEFT JOIN waitlist_stats ws ON ws.event_id = me.id
     ORDER BY me.created_at DESC
    `,
    [organiserId, includeAll]
  );

  const totals = rows.reduce(
    (acc, r) => ({
      events: acc.events + 1,
      shows: acc.shows + r.show_count,
      seats_sold: acc.seats_sold + r.booked_seats,
      // Summed as cents to avoid reintroducing float error on the way out.
      revenue_cents: acc.revenue_cents + Math.round(Number(r.revenue) * 100),
      bookings: acc.bookings + r.bookings_confirmed,
    }),
    { events: 0, shows: 0, seats_sold: 0, revenue_cents: 0, bookings: 0 }
  );

  return {
    events: rows,
    totals: {
      events: totals.events,
      shows: totals.shows,
      seats_sold: totals.seats_sold,
      bookings: totals.bookings,
      revenue: (totals.revenue_cents / 100).toFixed(2),
    },
  };
}

/** Assert the caller may view this event's figures. */
async function assertEventVisible(eventId, viewer) {
  // venue_name is joined in so the organiser's event page can name the venue without a
  // second request — it is shown in the header and in the "add showing" context panel.
  const { rows } = await query(
    `SELECT e.id, e.title, e.type::text AS type, e.organiser_id, e.venue_id,
            v.name AS venue_name, e.description
       FROM events e
       JOIN venues v ON v.id = e.venue_id
      WHERE e.id = $1`,
    [eventId]
  );
  const event = rows[0];
  if (!event) throw notFound(`Event ${eventId} not found`);
  if (viewer.role !== 'admin' && event.organiser_id !== viewer.id) {
    throw forbidden('You can only view reports for your own events');
  }
  return event;
}

/**
 * Per-show breakdown for one event: seats sold, revenue, and category detail.
 */
async function getEventReport(eventId, viewer) {
  const event = await assertEventVisible(eventId, viewer);

  const { rows: shows } = await query(
    `
    WITH seat_stats AS (
      SELECT ss.show_id,
             count(*)::int AS total_seats,
             count(*) FILTER (WHERE ss.status = 'booked')::int AS booked_seats,
             count(*) FILTER (
               WHERE ss.status = 'available'
                  OR (ss.status IN ('held','offered') AND ss.hold_expires_at < now())
             )::int AS available_seats,
             count(*) FILTER (
               WHERE ss.status = 'held' AND ss.hold_expires_at >= now()
             )::int AS held_seats,
             count(*) FILTER (
               WHERE ss.status = 'offered' AND ss.hold_expires_at >= now()
             )::int AS offered_seats
        FROM show_seats ss
       GROUP BY ss.show_id
    ),
    booking_stats AS (
      SELECT b.show_id,
             count(*) FILTER (WHERE b.status = 'confirmed')::int AS bookings_confirmed,
             count(*) FILTER (WHERE b.status = 'cancelled')::int AS bookings_cancelled,
             COALESCE(sum(b.total_amount) FILTER (WHERE b.status = 'confirmed'), 0)::numeric(12,2) AS revenue
        FROM bookings b
       GROUP BY b.show_id
    )
    SELECT s.id, s.date, s.time,
           COALESCE(ss.total_seats, 0)        AS total_seats,
           COALESCE(ss.booked_seats, 0)       AS booked_seats,
           COALESCE(ss.available_seats, 0)    AS available_seats,
           COALESCE(ss.held_seats, 0)         AS held_seats,
           COALESCE(ss.offered_seats, 0)      AS offered_seats,
           COALESCE(bs.bookings_confirmed, 0) AS bookings_confirmed,
           COALESCE(bs.bookings_cancelled, 0) AS bookings_cancelled,
           COALESCE(bs.revenue, 0)            AS revenue,
           CASE WHEN COALESCE(ss.total_seats, 0) = 0 THEN 0
                ELSE round(100.0 * COALESCE(ss.booked_seats, 0) / ss.total_seats, 1)
           END AS occupancy_pct
      FROM shows s
      LEFT JOIN seat_stats ss    ON ss.show_id = s.id
      LEFT JOIN booking_stats bs ON bs.show_id = s.id
     WHERE s.event_id = $1
     ORDER BY s.date, s.time
    `,
    [eventId]
  );

  /**
   * Category breakdown across the event.
   *
   * Seat counts and revenue are aggregated in separate CTEs and only then joined.
   *
   * Counting them in a single scan over `show_seats LEFT JOIN booking_seats` is
   * wrong, and wrong in a way that looks fine until a seat has been sold more than
   * once. A seat that was booked, cancelled, and rebooked has several booking_seats
   * rows, so the join emits that one seat several times and both total_seats and
   * booked_seats are multiplied by its sales history. A venue with a single Premium
   * seat reported "3 of 3 Premium booked" purely because that seat had changed hands
   * twice.
   *
   * Revenue reads booking_seats.price — the price captured at the point of sale —
   * filtered to confirmed bookings. That is RULE 2 from the module header applied
   * per category.
   */
  const { rows: categories } = await query(
    `
    WITH seats AS (
      SELECT ss.category,
             count(*)::int AS total_seats,
             count(*) FILTER (WHERE ss.status = 'booked')::int AS booked_seats
        FROM show_seats ss
        JOIN shows s ON s.id = ss.show_id
       WHERE s.event_id = $1
       GROUP BY ss.category
    ),
    sales AS (
      SELECT ss.category,
             COALESCE(sum(bs.price), 0)::numeric(12,2) AS revenue,
             count(*)::int AS seats_sold_ever
        FROM booking_seats bs
        JOIN bookings b   ON b.id = bs.booking_id
        JOIN show_seats ss ON ss.id = bs.show_seat_id
        JOIN shows s      ON s.id = ss.show_id
       WHERE s.event_id = $1
         AND b.status = 'confirmed'
       GROUP BY ss.category
    )
    SELECT seats.category,
           seats.total_seats,
           seats.booked_seats,
           COALESCE(sales.revenue, 0)::numeric(12,2) AS revenue
      FROM seats
      LEFT JOIN sales ON sales.category = seats.category
     ORDER BY seats.category
    `,
    [eventId]
  );

  const { rows: waitlist } = await query(
    `SELECT w.category,
            count(*) FILTER (WHERE w.status = 'waiting')::int   AS waiting,
            count(*) FILTER (WHERE w.status = 'offered')::int   AS offered,
            count(*) FILTER (WHERE w.status = 'fulfilled')::int AS fulfilled,
            count(*) FILTER (WHERE w.status = 'expired')::int   AS expired
       FROM waitlist w
       JOIN shows s ON s.id = w.show_id
      WHERE s.event_id = $1
      GROUP BY w.category
      ORDER BY w.category`,
    [eventId]
  );

  const revenueCents = shows.reduce((sum, s) => sum + Math.round(Number(s.revenue) * 100), 0);

  return {
    event,
    shows,
    categories,
    waitlist,
    totals: {
      shows: shows.length,
      seats_sold: shows.reduce((n, s) => n + s.booked_seats, 0),
      bookings: shows.reduce((n, s) => n + s.bookings_confirmed, 0),
      revenue: (revenueCents / 100).toFixed(2),
    },
  };
}

/** Recent bookings for an event, for the organiser's attendee list. */
async function getEventBookings(eventId, viewer, { limit = 100 } = {}) {
  await assertEventVisible(eventId, viewer);

  const { rows } = await query(
    `SELECT b.id, b.booking_ref, b.status::text AS status, b.total_amount, b.created_at,
            b.cancelled_at,
            u.name AS customer_name, u.email AS customer_email,
            s.date, s.time,
            count(bs.id)::int AS seat_count,
            string_agg(vs.row_label || vs.seat_number, ', ' ORDER BY vs.row_label, vs.seat_number) AS seats
       FROM bookings b
       JOIN users u ON u.id = b.customer_id
       JOIN shows s ON s.id = b.show_id
       LEFT JOIN booking_seats bs ON bs.booking_id = b.id
       LEFT JOIN show_seats ss    ON ss.id = bs.show_seat_id
       LEFT JOIN venue_seats vs   ON vs.id = ss.venue_seat_id
      WHERE s.event_id = $1
      GROUP BY b.id, u.name, u.email, s.date, s.time
      ORDER BY b.created_at DESC
      LIMIT $2`,
    [eventId, limit]
  );
  return rows;
}

module.exports = {
  getOrganiserSummary,
  getEventReport,
  getEventBookings,
  assertEventVisible,
};
