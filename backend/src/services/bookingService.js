'use strict';

/**
 * Booking creation, history, and cancellation.
 *
 * Two rules govern this module.
 *
 * RULE 1 — The transaction owns correctness, and nothing else is inside it.
 *
 * Converting holds into a booking uses the same locking pattern as holdService:
 * SELECT ... FOR UPDATE with a predicate the database evaluates, then a row-count
 * comparison. The predicate is stricter here because a booking must additionally
 * prove the seats are held *by this caller* and *not expired*.
 *
 * RULE 2 — Side effects happen strictly after COMMIT.
 *
 * QR rendering and email are scheduled after the transaction commits and after the
 * HTTP response is sent. A slow SMTP handshake inside the transaction would hold
 * row locks on contended seats for the duration of a network round trip to a third
 * party, and an SMTP failure would roll back a booking the customer has already
 * paid for. Neither is acceptable, so the transaction contains only database work.
 */

const crypto = require('node:crypto');

const config = require('../config/env');
const { query, withTransaction } = require('../config/db');
const { seatConflict, notFound, forbidden, conflict, badRequest } = require('../lib/errors');
const realtime = require('../realtime/io');
const qrService = require('./qrService');
const mailer = require('./mailer');
const { SEAT_DETAIL_SQL } = require('./holdService');

/**
 * Generate a human-friendly booking reference.
 *
 * Format: TB-XXXXXXXX using an alphabet with no 0/O/1/I, because these get read
 * aloud and typed in by hand at a venue door. Random rather than sequential so a
 * reference cannot be used to enumerate other people's bookings or infer sales
 * volume. Uniqueness is still guaranteed by the UNIQUE constraint, not by hope —
 * see the retry loop in createBooking.
 */
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateBookingRef() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (const byte of bytes) out += REF_ALPHABET[byte % REF_ALPHABET.length];
  return `TB-${out}`;
}

/**
 * Turn the caller's live holds into a confirmed booking.
 *
 * @param {number} showId
 * @param {number[]} seatIds  seats to book; must all be held by this customer
 * @param {object} customer   { id, name, email }
 */
async function createBooking({ showId, seatIds, customer }) {
  if (seatIds.length === 0) throw badRequest('Select at least one seat');
  const orderedIds = [...seatIds].sort((a, b) => a - b);

  const booking = await withTransaction(async (client) => {
    const { rows: showRows } = await client.query(
      `SELECT s.id, s.date, s.time, e.title AS event_title, v.name AS venue_name
         FROM shows s
         JOIN events e ON e.id = s.event_id
         JOIN venues v ON v.id = e.venue_id
        WHERE s.id = $1`,
      [showId]
    );
    const show = showRows[0];
    if (!show) throw notFound(`Show ${showId} not found`);

    /**
     * The atomic claim.
     *
     * Every clause matters:
     *  - `held_by = $3` — the seats must belong to this caller. Without it, anyone
     *    could book seats another customer is holding.
     *  - `status IN ('held','offered')` — 'offered' is included so a waitlist offer
     *    can be redeemed through this same path.
     *  - `hold_expires_at > now()` — expiry is re-validated here, inside the
     *    transaction, evaluated by PostgreSQL. This is the requirement that a
     *    booking must never trust a 'held' status on its own: if the TTL has passed
     *    the row still says 'held' until the sweeper runs, and booking it would sell
     *    a seat the seat map is already showing to other customers as free.
     *  - `FOR UPDATE` — locks the rows so a concurrent booking or sweep cannot
     *    interleave between this check and the UPDATE below.
     */
    const { rows: claimable } = await client.query(
      `SELECT ss.id, ss.category
         FROM show_seats ss
        WHERE ss.id = ANY($1::int[])
          AND ss.show_id = $2
          AND ss.held_by = $3
          AND ss.status IN ('held', 'offered')
          AND ss.hold_expires_at > now()
        FOR UPDATE`,
      [orderedIds, showId, customer.id]
    );

    if (claimable.length !== orderedIds.length) {
      const ok = new Set(claimable.map((r) => r.id));
      const bad = orderedIds.filter((id) => !ok.has(id));
      throw seatConflict(
        bad,
        'Some seats are no longer held by you — the hold may have expired. Please select your seats again.'
      );
    }

    /**
     * Price server-side from show_pricing.
     *
     * The client never supplies an amount. Trusting a client-sent total is how a
     * booking system ends up selling a ₹2500 seat for ₹1, and no amount of
     * front-end validation prevents a crafted request.
     *
     * A missing price is treated as a hard error rather than defaulting to zero:
     * silently booking for free is worse than refusing.
     */
    const { rows: priced } = await client.query(
      `SELECT ss.id, ss.category, sp.price
         FROM show_seats ss
         LEFT JOIN show_pricing sp
                ON sp.show_id = ss.show_id AND sp.category = ss.category
        WHERE ss.id = ANY($1::int[])`,
      [orderedIds]
    );

    const unpriced = priced.filter((r) => r.price === null);
    if (unpriced.length > 0) {
      throw conflict(
        `No price is configured for category/categories: ${[...new Set(unpriced.map((r) => r.category))].join(', ')}. ` +
          'The organiser must set pricing before these seats can be booked.'
      );
    }

    // Summed by PostgreSQL in NUMERIC arithmetic. Adding these up in JavaScript
    // would route exact decimals through binary floating point.
    const { rows: totalRows } = await client.query(
      `SELECT COALESCE(sum(sp.price), 0)::numeric(10,2) AS total
         FROM show_seats ss
         JOIN show_pricing sp
              ON sp.show_id = ss.show_id AND sp.category = ss.category
        WHERE ss.id = ANY($1::int[])`,
      [orderedIds]
    );
    const totalAmount = totalRows[0].total;

    /**
     * Insert the booking, retrying on a reference collision.
     *
     * 8 characters from a 32-symbol alphabet is ~10^12 combinations, so a clash is
     * vanishingly unlikely — but "unlikely" is not "impossible", and the UNIQUE
     * constraint would turn one into a 500. Retrying a handful of times converts a
     * freak collision into a non-event.
     */
    let bookingRow = null;
    for (let attempt = 0; attempt < 5 && !bookingRow; attempt += 1) {
      try {
        const { rows } = await client.query(
          `INSERT INTO bookings (booking_ref, customer_id, show_id, total_amount, status)
           VALUES ($1, $2, $3, $4, 'confirmed')
           RETURNING *`,
          [generateBookingRef(), customer.id, showId, totalAmount]
        );
        bookingRow = rows[0];
      } catch (err) {
        // 23505 on bookings_booking_ref_key — try a new reference.
        if (err.code === '23505' && attempt < 4) continue;
        throw err;
      }
    }

    // Record what was paid per seat, so historical revenue survives a later price change.
    await client.query(
      `INSERT INTO booking_seats (booking_id, show_seat_id, price)
       SELECT $1, ss.id, sp.price
         FROM show_seats ss
         JOIN show_pricing sp
              ON sp.show_id = ss.show_id AND sp.category = ss.category
        WHERE ss.id = ANY($2::int[])`,
      [bookingRow.id, orderedIds]
    );

    // Seats become booked. held_by/hold_expires_at are cleared because the
    // show_seats_hold_fields_consistent constraint requires them to be NULL for a
    // settled status — the schema enforces that a booked seat cannot carry a
    // lingering hold.
    await client.query(
      `UPDATE show_seats
          SET status = 'booked', held_by = NULL, hold_expires_at = NULL
        WHERE id = ANY($1::int[])`,
      [orderedIds]
    );

    // If these seats came from a waitlist offer, close out those entries.
    await client.query(
      `UPDATE waitlist
          SET status = 'fulfilled', offer_token = NULL, offer_expires_at = NULL
        WHERE offered_show_seat_id = ANY($1::int[])
          AND status = 'offered'`,
      [orderedIds]
    );

    const { rows: seats } = await client.query(SEAT_DETAIL_SQL, [orderedIds]);

    return { booking: bookingRow, show, seats };
  });

  // ---- Committed. Everything below is a side effect. ----

  realtime.emitSeatUpdate(showId, booking.seats, { reason: 'booked', actorId: customer.id });
  realtime.emitAvailabilityChanged(showId, 'booked');

  const qrDataUrl = await qrService.generateBookingQr(booking.booking.booking_ref);

  // Fire-and-forget. setImmediate takes the send off the response path entirely, so
  // the customer sees their confirmation without waiting on an SMTP round trip.
  scheduleBookingEmail({ customer, ...booking });

  return {
    booking: {
      ...booking.booking,
      seats: booking.seats.map((s) => ({
        id: s.id,
        row_label: s.row_label,
        seat_number: s.seat_number,
        category: s.category,
        price: s.price,
      })),
      show: booking.show,
    },
    qr_data_url: qrDataUrl,
  };
}

/**
 * Send the confirmation email outside the request lifecycle.
 *
 * Errors are logged and dropped. The booking is already committed and the customer
 * already has their reference and QR code from the API response, so a failed email
 * is a degraded experience, not a failed booking.
 */
function scheduleBookingEmail({ customer, booking, show, seats }) {
  setImmediate(async () => {
    try {
      const qrBuffer = await qrService.generateBookingQrBuffer(booking.booking_ref);
      await mailer.sendBookingConfirmation({
        to: customer.email,
        name: customer.name,
        booking,
        show,
        seats,
        qrBuffer,
      });
    } catch (err) {
      console.error(`[booking] confirmation email failed for ${booking.booking_ref}:`, err.message);
    }
  });
}

/* --- Reads --------------------------------------------------------------- */

const BOOKING_SELECT = `
  SELECT b.id, b.booking_ref, b.customer_id, b.show_id, b.total_amount,
         b.status::text AS status, b.created_at, b.cancelled_at,
         s.date, s.time,
         e.id AS event_id, e.title AS event_title, e.type::text AS event_type,
         v.name AS venue_name, v.address AS venue_address,
         -- Aggregated in SQL so listing N bookings stays one query rather than
         -- N+1 round trips for seat rows.
         COALESCE(
           json_agg(
             json_build_object(
               'id', ss.id,
               'row_label', vs.row_label,
               'seat_number', vs.seat_number,
               'category', ss.category,
               'price', bs.price
             ) ORDER BY vs.row_label, vs.seat_number
           ) FILTER (WHERE ss.id IS NOT NULL),
           '[]'
         ) AS seats
    FROM bookings b
    JOIN shows s  ON s.id = b.show_id
    JOIN events e ON e.id = s.event_id
    JOIN venues v ON v.id = e.venue_id
    LEFT JOIN booking_seats bs ON bs.booking_id = b.id
    LEFT JOIN show_seats ss    ON ss.id = bs.show_seat_id
    LEFT JOIN venue_seats vs   ON vs.id = ss.venue_seat_id
`;

async function listBookingsForCustomer(customerId) {
  const { rows } = await query(
    `${BOOKING_SELECT}
      WHERE b.customer_id = $1
      GROUP BY b.id, s.date, s.time, e.id, e.title, e.type, v.name, v.address
      ORDER BY b.created_at DESC`,
    [customerId]
  );
  return rows;
}

/**
 * Fetch one booking.
 *
 * `viewer` scopes access: a customer may only read their own booking. Returning 404
 * rather than 403 for someone else's booking avoids confirming that a given
 * reference exists.
 */
async function getBooking(bookingId, viewer) {
  const { rows } = await query(
    `${BOOKING_SELECT}
      WHERE b.id = $1
      GROUP BY b.id, s.date, s.time, e.id, e.title, e.type, v.name, v.address`,
    [bookingId]
  );
  const booking = rows[0];
  if (!booking) throw notFound(`Booking ${bookingId} not found`);

  if (viewer.role === 'customer' && booking.customer_id !== viewer.id) {
    throw notFound(`Booking ${bookingId} not found`);
  }
  return booking;
}

/** Look up by reference — the QR payload resolves through here. */
async function getBookingByRef(bookingRef, viewer) {
  const { rows } = await query(
    `${BOOKING_SELECT}
      WHERE b.booking_ref = $1
      GROUP BY b.id, s.date, s.time, e.id, e.title, e.type, v.name, v.address`,
    [bookingRef]
  );
  const booking = rows[0];
  if (!booking) throw notFound(`No booking found with reference ${bookingRef}`);

  if (viewer.role === 'customer' && booking.customer_id !== viewer.id) {
    throw forbidden('That booking belongs to another customer');
  }
  return booking;
}

/** Regenerate the QR for an existing confirmed booking. */
async function getBookingQr(bookingId, viewer) {
  const booking = await getBooking(bookingId, viewer);
  if (booking.status !== 'confirmed') {
    throw conflict('This booking is cancelled, so it has no valid ticket');
  }
  return {
    booking_ref: booking.booking_ref,
    qr_data_url: await qrService.generateBookingQr(booking.booking_ref),
  };
}

/* --- Cancellation -------------------------------------------------------- */

/**
 * Cancel a booking and re-place every released seat.
 *
 * The ordering inside the transaction matters and is the crux of the waitlist
 * requirement: a released seat is NOT set back to 'available' and then offered to
 * someone. It is handed to `placeSeat`, which decides — while still holding the
 * seat's row lock — whether it becomes an offer to the head of the FIFO queue or
 * goes back on general sale. There is never an instant where a waitlisted category
 * has a bookable seat sitting available for a passer-by to take ahead of the queue.
 *
 * @param {number} bookingId
 * @param {object} viewer  the caller; a customer may only cancel their own booking
 */
async function cancelBooking(bookingId, viewer) {
  // Required here rather than at module scope: waitlistService requires
  // holdService, which this module also requires, and a top-level import would
  // close a require cycle.
  const waitlistService = require('./waitlistService');

  const result = await withTransaction(async (client) => {
    /**
     * Lock the booking first.
     *
     * Two simultaneous cancel requests for the same booking (a double-clicked
     * button) would otherwise both read status 'confirmed' and both try to release
     * the seats, double-serving the waitlist. The second waits here, then sees
     * 'cancelled' and is rejected.
     */
    const { rows: bookingRows } = await client.query(
      `SELECT b.id, b.booking_ref, b.customer_id, b.show_id, b.status::text AS status,
              b.total_amount, u.email, u.name
         FROM bookings b
         JOIN users u ON u.id = b.customer_id
        WHERE b.id = $1
        FOR UPDATE OF b`,
      [bookingId]
    );

    const booking = bookingRows[0];
    if (!booking) throw notFound(`Booking ${bookingId} not found`);

    if (viewer.role === 'customer' && booking.customer_id !== viewer.id) {
      // 404 rather than 403, so booking ids cannot be probed.
      throw notFound(`Booking ${bookingId} not found`);
    }
    if (booking.status === 'cancelled') {
      throw conflict('This booking has already been cancelled');
    }

    const { rows: showRows } = await client.query(
      `SELECT s.id, s.date, s.time, e.title AS event_title, v.name AS venue_name
         FROM shows s
         JOIN events e ON e.id = s.event_id
         JOIN venues v ON v.id = e.venue_id
        WHERE s.id = $1`,
      [booking.show_id]
    );
    const show = showRows[0];

    // Lock the seats being released, in id order for consistent lock ordering.
    const { rows: seats } = await client.query(
      `SELECT ss.id, ss.show_id, ss.category, vs.row_label, vs.seat_number
         FROM booking_seats bs
         JOIN show_seats ss ON ss.id = bs.show_seat_id
         JOIN venue_seats vs ON vs.id = ss.venue_seat_id
        WHERE bs.booking_id = $1
        ORDER BY ss.id
        FOR UPDATE OF ss`,
      [bookingId]
    );

    await client.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
      [bookingId]
    );

    // Re-place each seat: offer to the queue, or release. One decision per seat,
    // made by the shared function.
    const offers = [];
    let releasedCount = 0;
    let offeredCount = 0;

    for (const seat of seats) {
      if (!config.isTest) {
        console.log(
          `[waitlist] seat ${seat.row_label}${seat.seat_number} released from booking ${bookingId} (${booking.booking_ref})`
        );
      }

      const outcome = await waitlistService.placeSeat(client, seat);
      if (outcome.outcome === 'offered') {
        offeredCount += 1;
        offers.push(outcome);
      } else {
        releasedCount += 1;
      }
    }

    const seatIds = seats.map((s) => s.id);
    const { rows: seatDetails } = await client.query(SEAT_DETAIL_SQL, [seatIds]);

    // Give the offer emails their show/seat context while we still have the client.
    const seatById = new Map(seatDetails.map((s) => [s.id, s]));
    const enrichedOffers = offers.map((o) => ({
      ...o,
      seat: seatById.get(o.seatId),
      show,
    }));

    return {
      booking,
      show,
      seats: seatDetails,
      offers: enrichedOffers,
      releasedCount,
      offeredCount,
    };
  });

  // ---- Committed. Side effects only from here. ----

  realtime.emitSeatUpdate(result.booking.show_id, result.seats, {
    reason: 'cancelled',
    actorId: viewer.id,
  });
  realtime.emitAvailabilityChanged(result.booking.show_id, 'cancelled');

  waitlistService.scheduleOfferEmails(result.offers);

  setImmediate(async () => {
    try {
      await mailer.sendCancellationConfirmation({
        to: result.booking.email,
        name: result.booking.name,
        booking: result.booking,
        show: result.show,
        seats: result.seats,
      });
    } catch (err) {
      console.error(`[booking] cancellation email failed for ${result.booking.booking_ref}:`, err.message);
    }
  });

  return {
    booking_ref: result.booking.booking_ref,
    status: 'cancelled',
    seats_released: result.releasedCount,
    seats_offered_to_waitlist: result.offeredCount,
    seats: result.seats.map((s) => ({
      id: s.id,
      row_label: s.row_label,
      seat_number: s.seat_number,
      category: s.category,
      status: s.status,
    })),
  };
}

module.exports = {
  createBooking,
  cancelBooking,
  listBookingsForCustomer,
  getBooking,
  getBookingByRef,
  getBookingQr,
  generateBookingRef,
  BOOKING_SELECT,
};
