'use strict';

/**
 * Seat map reads.
 *
 * The projection here is the single place that decides what status a client sees,
 * and it deliberately does not report raw `show_seats.status`.
 */

const { query } = require('../config/db');
const { notFound } = require('../lib/errors');

/**
 * SQL expression producing the *effective* status of a seat.
 *
 * A row can sit in the database as 'held' long after its hold_expires_at has
 * passed, because the sweeper only runs every 15 seconds. Reporting that raw
 * status would show a seat as taken when it is genuinely free, and would let a
 * client's countdown disagree with the server about who owns what.
 *
 * Collapsing expired 'held'/'offered' to 'available' at read time means
 * correctness never depends on the cron having fired — the sweep becomes an
 * optimisation that tidies rows and pushes notifications, not the thing that
 * makes the seat map true.
 */
const EFFECTIVE_STATUS_SQL = `
  CASE
    WHEN ss.status IN ('held', 'offered') AND ss.hold_expires_at < now() THEN 'available'
    ELSE ss.status::text
  END
`;

/**
 * Full seat map for a show.
 *
 * `viewerId` is optional. When present, each seat gains `held_by_me` so the UI
 * can colour the caller's own selection differently from someone else's. The
 * other holder's identity is never included in the response — a customer has no
 * business knowing which user id is sitting on seat A4.
 */
async function getSeatMap(showId, viewerId = null) {
  const { rows: showRows } = await query(
    `SELECT s.id, s.date, s.time,
            e.id AS event_id, e.title AS event_title, e.type AS event_type,
            v.id AS venue_id, v.name AS venue_name, v.address AS venue_address
       FROM shows s
       JOIN events e ON e.id = s.event_id
       JOIN venues v ON v.id = e.venue_id
      WHERE s.id = $1`,
    [showId]
  );
  const show = showRows[0];
  if (!show) throw notFound(`Show ${showId} not found`);

  const { rows: seats } = await query(
    `SELECT ss.id,
            vs.row_label,
            vs.seat_number,
            ss.category,
            ${EFFECTIVE_STATUS_SQL} AS status,
            sp.price,
            -- Only true for the caller's own live hold. Expired holds are not
            -- "mine" any more, matching the effective status above.
            ($2::int IS NOT NULL
              AND ss.held_by = $2::int
              AND ss.status IN ('held','offered')
              AND ss.hold_expires_at > now())          AS held_by_me,
            -- Exposed only for the caller's own holds so the checkout countdown
            -- can be driven from the server's clock, not the browser's.
            CASE WHEN $2::int IS NOT NULL AND ss.held_by = $2::int
                 THEN ss.hold_expires_at END           AS my_hold_expires_at
       FROM show_seats ss
       JOIN venue_seats vs ON vs.id = ss.venue_seat_id
       LEFT JOIN show_pricing sp
              ON sp.show_id = ss.show_id AND sp.category = ss.category
      WHERE ss.show_id = $1
      ORDER BY vs.row_label, vs.seat_number`,
    [showId, viewerId]
  );

  const { rows: pricing } = await query(
    'SELECT category, price FROM show_pricing WHERE show_id = $1 ORDER BY category',
    [showId]
  );

  return {
    show: {
      id: show.id,
      date: show.date,
      time: show.time,
      event: { id: show.event_id, title: show.event_title, type: show.event_type },
      venue: { id: show.venue_id, name: show.venue_name, address: show.venue_address },
    },
    pricing,
    rows: groupIntoRows(seats),
    summary: summarise(seats),
    // Server time so the client can correct for clock skew when rendering the
    // hold countdown rather than trusting Date.now() locally.
    server_time: new Date().toISOString(),
  };
}

/**
 * Fetch specific seats in the same shape the seat map uses.
 * Used for Socket.io deltas, so clients can patch rather than refetch everything.
 */
async function getSeatsByIds(seatIds, viewerId = null) {
  if (seatIds.length === 0) return [];
  const { rows } = await query(
    `SELECT ss.id, ss.show_id, vs.row_label, vs.seat_number, ss.category,
            ${EFFECTIVE_STATUS_SQL} AS status,
            sp.price,
            ($2::int IS NOT NULL AND ss.held_by = $2::int
              AND ss.status IN ('held','offered') AND ss.hold_expires_at > now()) AS held_by_me
       FROM show_seats ss
       JOIN venue_seats vs ON vs.id = ss.venue_seat_id
       LEFT JOIN show_pricing sp
              ON sp.show_id = ss.show_id AND sp.category = ss.category
      WHERE ss.id = ANY($1::int[])
      ORDER BY vs.row_label, vs.seat_number`,
    [seatIds, viewerId]
  );
  return rows;
}

/** Per-category availability, used to decide whether to offer the waitlist. */
async function getCategoryAvailability(showId) {
  const { rows } = await query(
    `SELECT ss.category,
            sp.price,
            count(*)::int AS total,
            count(*) FILTER (WHERE ${EFFECTIVE_STATUS_SQL} = 'available')::int AS available,
            count(*) FILTER (WHERE ss.status = 'booked')::int AS booked
       FROM show_seats ss
       LEFT JOIN show_pricing sp
              ON sp.show_id = ss.show_id AND sp.category = ss.category
      WHERE ss.show_id = $1
      GROUP BY ss.category, sp.price
      ORDER BY ss.category`,
    [showId]
  );
  return rows.map((r) => ({ ...r, sold_out: r.available === 0 }));
}

function groupIntoRows(seats) {
  const map = new Map();
  for (const seat of seats) {
    if (!map.has(seat.row_label)) {
      map.set(seat.row_label, { row_label: seat.row_label, seats: [] });
    }
    map.get(seat.row_label).seats.push(seat);
  }
  return [...map.values()];
}

function summarise(seats) {
  const summary = { total: seats.length, available: 0, held: 0, booked: 0, offered: 0 };
  for (const s of seats) {
    if (summary[s.status] !== undefined) summary[s.status] += 1;
  }
  return summary;
}

module.exports = {
  getSeatMap,
  getSeatsByIds,
  getCategoryAvailability,
  EFFECTIVE_STATUS_SQL,
};
