'use strict';

/**
 * Waitlist: FIFO queue per (show, category), with time-limited single-use offers.
 *
 * =============================================================================
 * THE CENTRAL DECISION: WHERE DOES A RELEASED SEAT GO?
 * =============================================================================
 *
 * Whenever a seat stops being sold — a cancellation, or an offer nobody accepted —
 * exactly one question has to be answered: does it go back on general sale, or to
 * the person who has been waiting longest?
 *
 * That decision lives in one function, `placeSeat`, called from both paths:
 *
 *   cancellation  ─┐
 *                  ├─> placeSeat() ─> offer to head of FIFO queue, or release
 *   offer expiry  ─┘
 *
 * Keeping it in one place is deliberate. Two copies of "check the queue, claim the
 * head entry, mint a token, set the seat to offered, otherwise release" would
 * inevitably drift — one path would gain a fix the other did not, and the bug would
 * only appear in whichever flow was tested less.
 *
 * =============================================================================
 * WHY `FOR UPDATE SKIP LOCKED` ON THE QUEUE
 * =============================================================================
 *
 * Cancelling a 3-seat booking releases three seats of the same category in one
 * transaction, and the sweeper can be expiring several offers at once. Each
 * released seat independently asks for "the next waiting entry".
 *
 * With plain `FOR UPDATE`, the second seat would block on the first seat's lock and
 * then — after the first commits — re-read and find the same row now marked
 * 'offered', so it would fall through and find the next one. Correct, but it
 * serialises the whole batch behind one lock and, under the sweeper, risks a
 * transaction sitting idle waiting.
 *
 * `SKIP LOCKED` makes the second seat step straight over the row the first seat is
 * already claiming and take the next entry instead. Three seats released together
 * go to the first three people in the queue, in order, with no waiting. That is
 * exactly the desired semantics for handing work items to concurrent consumers,
 * which is what this is.
 * =============================================================================
 */

const crypto = require('node:crypto');

const { query, withTransaction } = require('../config/db');
const config = require('../config/env');
const { notFound, conflict, badRequest } = require('../lib/errors');
const realtime = require('../realtime/io');
const mailer = require('./mailer');
const { SEAT_DETAIL_SQL } = require('./holdService');

/**
 * Offer tokens are the entire authorisation for the emailed link, so they are 32
 * bytes of CSPRNG output rather than a sequential id or a hash of something
 * guessable. 256 bits is not brute-forceable, and the UNIQUE index on the column
 * means a collision would be rejected rather than silently overwriting an offer.
 */
const generateOfferToken = () => crypto.randomBytes(32).toString('hex');

/**
 * Allocation logging.
 *
 * Silenced under NODE_ENV=test so 43 suite cases do not bury real assertions in
 * noise, matching how sweeper.js and mailer.js already behave.
 */
const log = (...args) => {
  if (!config.isTest) console.log(...args);
};

/**
 * Offer tokens are the whole authorisation for the emailed link, so the full value
 * must never reach the logs — anyone who could read it could claim the seat. A
 * short prefix is enough to correlate a log line with a row in `waitlist`.
 */
const tokenTag = (token) => `${token.slice(0, 8)}…`;

/** `A5`, for log lines. Falls back to the row id when the label is unavailable. */
const seatTag = (seat) =>
  seat && seat.row_label != null && seat.seat_number != null
    ? `${seat.row_label}${seat.seat_number}`
    : `#${seat && seat.id}`;

/* ---------------------------------------------------------------------------
 * Joining the queue
 * ------------------------------------------------------------------------- */

/**
 * Join the waitlist for (show, category).
 *
 * Refuses when the category still has seats available: a waitlist entry for
 * something the customer could simply buy is a support ticket waiting to happen,
 * and it would also let someone jump the queue by joining early.
 */
async function joinWaitlist({ showId, category, customerId }) {
  return withTransaction(async (client) => {
    const { rows: showRows } = await client.query('SELECT id FROM shows WHERE id = $1', [showId]);
    if (!showRows[0]) throw notFound(`Show ${showId} not found`);

    // Confirm the category exists for this show at all, so a typo becomes a clear
    // 400 rather than an entry in a queue that will never be served.
    const { rows: catRows } = await client.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (
                WHERE status = 'available'
                   OR (status IN ('held','offered') AND hold_expires_at < now())
              )::int AS available
         FROM show_seats
        WHERE show_id = $1 AND category = $2`,
      [showId, category]
    );

    if (catRows[0].total === 0) {
      throw badRequest(`This show has no "${category}" seats`);
    }
    if (catRows[0].available > 0) {
      throw conflict(
        `"${category}" still has ${catRows[0].available} seat(s) available — book directly instead of joining the waitlist.`,
        { available: catRows[0].available }
      );
    }

    try {
      const { rows } = await client.query(
        `INSERT INTO waitlist (show_id, category, customer_id, status)
         VALUES ($1, $2, $3, 'waiting')
         RETURNING id, show_id, category, status::text AS status, joined_at`,
        [showId, category, customerId]
      );

      /**
       * Queue position, computed entirely in SQL by joining the row to itself.
       *
       * The obvious version — read joined_at back and pass it as a parameter — is
       * subtly broken. PostgreSQL stores TIMESTAMPTZ with microsecond precision but
       * a JavaScript Date only holds milliseconds, so the value that comes back and
       * goes out again is *earlier* than what is stored. The row then fails its own
       * `joined_at <= $n` test and every customer is told they are position 0.
       *
       * Comparing row tuples server-side keeps full precision. The (joined_at, id)
       * ordering matches the FIFO tiebreaker used when claiming the head of the
       * queue, so position and service order agree.
       */
      const { rows: posRows } = await client.query(
        `SELECT count(*)::int AS position
           FROM waitlist w2
           JOIN waitlist w ON w.id = $1
          WHERE w2.show_id = w.show_id
            AND w2.category = w.category
            AND w2.status = 'waiting'
            AND (w2.joined_at, w2.id) <= (w.joined_at, w.id)`,
        [rows[0].id]
      );

      return { ...rows[0], position: posRows[0].position };
    } catch (err) {
      // Partial unique index waitlist_one_active_per_customer_idx.
      if (err.code === '23505') {
        throw conflict('You are already on the waitlist for this category');
      }
      throw err;
    }
  });
}

/** The caller's waitlist entries, with live queue positions. */
async function listMyWaitlist(customerId) {
  const { rows } = await query(
    `SELECT w.id, w.show_id, w.category, w.status::text AS status, w.joined_at,
            w.offer_expires_at, w.offer_token,
            s.date, s.time,
            -- event_id is selected so the client can build the poster URL and link
            -- back to the event, the same way booking history does.
            e.id AS event_id, e.title AS event_title, e.type::text AS event_type,
            v.name AS venue_name,
            -- Same (joined_at, id) tuple comparison as joinWaitlist, so the position
            -- shown here matches the order seats are actually handed out in.
            CASE WHEN w.status = 'waiting' THEN (
              SELECT count(*)::int FROM waitlist w2
               WHERE w2.show_id = w.show_id AND w2.category = w.category
                 AND w2.status = 'waiting'
                 AND (w2.joined_at, w2.id) <= (w.joined_at, w.id)
            ) END AS position,
            ovs.row_label AS offered_row_label,
            ovs.seat_number AS offered_seat_number,
            w.offered_show_seat_id
       FROM waitlist w
       JOIN shows s  ON s.id = w.show_id
       JOIN events e ON e.id = s.event_id
       JOIN venues v ON v.id = e.venue_id
       LEFT JOIN show_seats oss ON oss.id = w.offered_show_seat_id
       LEFT JOIN venue_seats ovs ON ovs.id = oss.venue_seat_id
      WHERE w.customer_id = $1
      ORDER BY w.joined_at DESC`,
    [customerId]
  );
  return rows;
}

async function leaveWaitlist(waitlistId, customerId) {
  const { rowCount } = await query(
    `DELETE FROM waitlist
      WHERE id = $1 AND customer_id = $2 AND status = 'waiting'`,
    [waitlistId, customerId]
  );
  if (rowCount === 0) {
    throw conflict('That waitlist entry does not exist, is not yours, or has already been offered a seat');
  }
  return { removed: true };
}

/* ---------------------------------------------------------------------------
 * The core: placing a released seat
 * ------------------------------------------------------------------------- */

/**
 * Decide where a single released seat goes, inside an existing transaction.
 *
 * MUST be called with `client` already inside a transaction, and with the seat row
 * already locked by the caller — the caller has just changed that seat's status, so
 * it owns the lock. Taking a fresh lock here would be redundant at best and a
 * lock-ordering hazard at worst.
 *
 * @param {object} client   pg client inside a transaction
 * @param {object} seat     { id, show_id, category }
 * @param {number[]} [excludeCustomerIds] entries to skip — used on offer expiry so
 *                          the customer who just let their offer lapse is not
 *                          immediately offered the same seat again.
 * @returns {Promise<{outcome: 'offered'|'released', ...}>}
 */
async function placeSeat(client, seat, excludeCustomerIds = []) {
  /**
   * Claim the head of the queue.
   *
   * ORDER BY joined_at ASC is the FIFO guarantee. `id` is a tiebreaker because two
   * entries inserted in the same transaction can share a joined_at value — now()
   * is fixed for a whole transaction in PostgreSQL — and without it the order
   * between them would be undefined.
   *
   * SKIP LOCKED: see the module header.
   */
  const { rows: candidates } = await client.query(
    `SELECT w.id, w.customer_id, w.category,
            u.email, u.name
       FROM waitlist w
       JOIN users u ON u.id = w.customer_id
      WHERE w.show_id = $1
        AND w.category = $2
        AND w.status = 'waiting'
        AND ($3::int[] IS NULL OR NOT (w.customer_id = ANY($3::int[])))
      ORDER BY w.joined_at ASC, w.id ASC
      LIMIT 1
      FOR UPDATE OF w SKIP LOCKED`,
    [seat.show_id, seat.category, excludeCustomerIds.length > 0 ? excludeCustomerIds : null]
  );

  const next = candidates[0];

  // Nobody waiting -> the seat goes back on general sale. This is the only path
  // that returns a seat to 'available' after a cancellation.
  if (!next) {
    // The label is resolved in the same statement via a scalar subquery so that all
    // three callers of placeSeat get loggable seat names without each having to
    // join venue_seats itself.
    const { rows } = await client.query(
      `UPDATE show_seats ss
          SET status = 'available', held_by = NULL, hold_expires_at = NULL
        WHERE ss.id = $1
      RETURNING (SELECT vs.row_label FROM venue_seats vs WHERE vs.id = ss.venue_seat_id) AS row_label,
                (SELECT vs.seat_number FROM venue_seats vs WHERE vs.id = ss.venue_seat_id) AS seat_number`,
      [seat.id]
    );
    const label = seatTag({ ...seat, ...rows[0] });
    log(`[waitlist] seat ${label} returned to general sale — no one waiting in ${seat.category}`);
    return { outcome: 'released', seatId: seat.id, seatLabel: label };
  }

  log(
    `[waitlist] selected customer ${next.customer_id} from ${seat.category} queue (entry ${next.id})`
  );

  // Someone is waiting -> reserve the seat for them.
  const token = generateOfferToken();

  /**
   * The offer reuses show_seats.held_by / hold_expires_at with status 'offered'.
   *
   * Same two fields, different meaning, disambiguated by status: 'held' is "a
   * customer is at the checkout", 'offered' is "reserved for a waitlisted customer
   * who has been emailed a link". The sweeper needs that distinction because an
   * expired hold is released while an expired offer cascades.
   *
   * The window is OFFER_TTL_MINUTES (default 30) rather than the 10-minute hold TTL:
   * this person is reacting to an email, not sitting at a checkout screen.
   */
  const { rows: seatRows } = await client.query(
    `UPDATE show_seats ss
        SET status = 'offered',
            held_by = $2,
            hold_expires_at = now() + ($3 || ' minutes')::interval
      WHERE ss.id = $1
      RETURNING ss.hold_expires_at,
                (SELECT vs.row_label FROM venue_seats vs WHERE vs.id = ss.venue_seat_id) AS row_label,
                (SELECT vs.seat_number FROM venue_seats vs WHERE vs.id = ss.venue_seat_id) AS seat_number`,
    [seat.id, next.customer_id, String(config.offerTtlMinutes)]
  );
  const expiresAt = seatRows[0].hold_expires_at;
  const seatLabel = seatTag({ ...seat, ...seatRows[0] });

  log(`[waitlist] created offer token ${tokenTag(token)} for seat ${seatLabel}`);
  log(`[waitlist] seat ${seatLabel} reserved until ${new Date(expiresAt).toISOString()}`);

  await client.query(
    `UPDATE waitlist
        SET status = 'offered',
            offer_token = $2,
            offer_expires_at = $3,
            offered_show_seat_id = $4
      WHERE id = $1`,
    [next.id, token, expiresAt, seat.id]
  );

  return {
    outcome: 'offered',
    seatId: seat.id,
    seatLabel,
    waitlistId: next.id,
    customer: { id: next.customer_id, email: next.email, name: next.name },
    token,
    expiresAt,
    category: seat.category,
  };
}

/**
 * Send offer emails after the transaction has committed.
 *
 * Collected during the transaction and dispatched here so a slow SMTP server can
 * never hold locks on contended seat rows, and a bounced email can never roll back
 * a cancellation the customer has already been told succeeded.
 */
function scheduleOfferEmails(offers) {
  if (offers.length === 0) return;

  setImmediate(async () => {
    for (const offer of offers) {
      try {
        await mailer.sendWaitlistOffer({
          to: offer.customer.email,
          name: offer.customer.name,
          show: offer.show,
          seat: offer.seat,
          offerToken: offer.token,
          expiresAt: offer.expiresAt,
          category: offer.category,
        });
      } catch (err) {
        console.error(`[waitlist] offer email failed for entry ${offer.waitlistId}:`, err.message);
      }
    }
  });
}

/* ---------------------------------------------------------------------------
 * Offer expiry + cascade (driven by the cron sweeper)
 * ------------------------------------------------------------------------- */

/**
 * Expire overdue offers and cascade each seat to the next person in the queue.
 *
 * This is the one piece of the system that genuinely requires a scheduler. An
 * expired customer hold is self-correcting, because every read treats a lapsed
 * deadline as available and the next person to look at the seat map can take it.
 * An expired *offer* is not: the seat is earmarked for one specific customer who
 * did nothing, and no incoming request would ever notice. Something has to come
 * along and move it on.
 */
async function expireOverdueOffers() {
  const result = await withTransaction(async (client) => {
    /**
     * Find offers past their window.
     *
     * Driven from show_seats rather than from waitlist because show_seats carries
     * the index built for exactly this scan (status, hold_expires_at), and the seat
     * is the row that must be locked before it can be reassigned.
     */
    const { rows: expired } = await client.query(
      `SELECT ss.id, ss.show_id, ss.category, ss.held_by,
              vs.row_label, vs.seat_number
         FROM show_seats ss
         JOIN venue_seats vs ON vs.id = ss.venue_seat_id
        WHERE ss.status = 'offered'
          AND ss.hold_expires_at < now()
        ORDER BY ss.id
        FOR UPDATE OF ss SKIP LOCKED`
    );

    if (expired.length === 0) {
      return { expired: 0, cascaded: 0, released: 0, offers: [], seatsByShow: new Map() };
    }

    let cascaded = 0;
    let released = 0;
    const offers = [];
    const touchedSeatIds = [];

    for (const seat of expired) {
      log(
        `[waitlist] offer expired for seat ${seatTag(seat)} (customer ${seat.held_by}, ${seat.category}) — cascading`
      );

      // Close out the lapsed entry first so placeSeat cannot hand the seat back to
      // the same person: their row is no longer 'waiting'.
      await client.query(
        `UPDATE waitlist
            SET status = 'expired', offer_token = NULL, offer_expires_at = NULL
          WHERE offered_show_seat_id = $1 AND status = 'offered'`,
        [seat.id]
      );

      // Belt and braces: also exclude by customer id, in case an entry was
      // re-created by hand or a second entry exists for the same person.
      const outcome = await placeSeat(client, seat, seat.held_by ? [seat.held_by] : []);

      touchedSeatIds.push(seat.id);
      if (outcome.outcome === 'offered') {
        cascaded += 1;
        offers.push(outcome);
      } else {
        released += 1;
      }
    }

    // Resolve seat detail and per-offer context for the emails and broadcasts.
    const { rows: seatDetails } = await client.query(SEAT_DETAIL_SQL, [touchedSeatIds]);

    const seatsByShow = new Map();
    for (const s of seatDetails) {
      if (!seatsByShow.has(s.show_id)) seatsByShow.set(s.show_id, []);
      seatsByShow.get(s.show_id).push(s);
    }

    const enrichedOffers = await enrichOffers(client, offers, seatDetails);

    return { expired: expired.length, cascaded, released, offers: enrichedOffers, seatsByShow };
  });

  for (const [showId, seats] of result.seatsByShow) {
    realtime.emitSeatUpdate(showId, seats, { reason: 'offer-expired' });
    realtime.emitAvailabilityChanged(showId, 'offer-expired');
  }
  scheduleOfferEmails(result.offers);

  return { expired: result.expired, cascaded: result.cascaded, released: result.released };
}

/** Attach show and seat context to offers so the email templates have what they need. */
async function enrichOffers(client, offers, seatDetails) {
  if (offers.length === 0) return [];

  const seatById = new Map(seatDetails.map((s) => [s.id, s]));
  const showIds = [...new Set(offers.map((o) => seatById.get(o.seatId)?.show_id).filter(Boolean))];

  const { rows: shows } = await client.query(
    `SELECT s.id, s.date, s.time, e.title AS event_title, v.name AS venue_name
       FROM shows s
       JOIN events e ON e.id = s.event_id
       JOIN venues v ON v.id = e.venue_id
      WHERE s.id = ANY($1::int[])`,
    [showIds]
  );
  const showById = new Map(shows.map((s) => [s.id, s]));

  return offers.map((offer) => {
    const seat = seatById.get(offer.seatId);
    return { ...offer, seat, show: showById.get(seat?.show_id) };
  });
}

/* ---------------------------------------------------------------------------
 * Accepting an offer
 * ------------------------------------------------------------------------- */

/**
 * Redeem an offer token.
 *
 * Converts the offer into a normal hold owned by the customer, so the existing
 * booking endpoint completes the purchase — the booking path already accepts
 * status 'offered', so this returns the seat and lets the customer confirm.
 *
 * Single use is enforced by clearing offer_token in the same transaction that
 * checks it. A second request finds no matching row and gets a 409, so a forwarded
 * email cannot be redeemed twice.
 */
async function acceptOffer(token, customerId) {
  const result = await withTransaction(async (client) => {
    /**
     * Locate and lock the offer.
     *
     * `offer_expires_at > now()` is evaluated by PostgreSQL inside the transaction
     * for the same reason booking re-checks hold expiry: the sweeper may not have
     * run yet, and an offer past its deadline must not be redeemable even though
     * the row still says 'offered'.
     */
    const { rows } = await client.query(
      `SELECT w.id, w.customer_id, w.show_id, w.category, w.offered_show_seat_id,
              w.offer_expires_at
         FROM waitlist w
        WHERE w.offer_token = $1
          AND w.status = 'offered'
          AND w.offer_expires_at > now()
        FOR UPDATE`,
      [token]
    );

    const offer = rows[0];
    if (!offer) {
      throw conflict(
        'This offer link is no longer valid. It may have already been used, or the reservation window may have closed.'
      );
    }

    // The link is single-use but not transferable: only the customer it was issued
    // to may redeem it, even if they forward the email.
    if (offer.customer_id !== customerId) {
      throw conflict('This offer was issued to a different customer');
    }

    // Lock and re-verify the seat itself.
    const { rows: seatRows } = await client.query(
      `SELECT ss.id, ss.show_id, ss.category, ss.status::text AS status, ss.held_by
         FROM show_seats ss
        WHERE ss.id = $1
          AND ss.status = 'offered'
          AND ss.held_by = $2
          AND ss.hold_expires_at > now()
        FOR UPDATE`,
      [offer.offered_show_seat_id, customerId]
    );

    if (!seatRows[0]) {
      throw conflict('The seat reserved for you is no longer available');
    }

    /**
     * Consume the offer.
     *
     * The entry moves to 'fulfilled' and the token is cleared in the same
     * statement. Clearing the token while leaving status 'offered' is not an option:
     * waitlist_offer_fields_consistent requires an 'offered' row to carry both a
     * token and a deadline, and the database rejects the half-state. That constraint
     * is what forced this to be modelled properly rather than left ambiguous.
     *
     * 'fulfilled' at accept time — rather than at payment time — is the honest
     * reading: the queue has done its job and handed this customer the seat. From
     * here they are an ordinary customer with an ordinary hold, and if they abandon
     * checkout the seat is re-placed through the normal release path, which consults
     * the queue again.
     *
     * Single use falls out of this: a replayed link finds status 'fulfilled' with a
     * NULL token, so the lookup above matches nothing and returns 409.
     */
    await client.query(
      `UPDATE waitlist
          SET status = 'fulfilled',
              offer_token = NULL,
              offer_expires_at = NULL
        WHERE id = $1`,
      [offer.id]
    );

    // Convert to a regular hold so the standard checkout can complete it, and give
    // the customer a fresh hold window to actually pay.
    const { rows: heldRows } = await client.query(
      `UPDATE show_seats
          SET status = 'held',
              hold_expires_at = now() + ($2 || ' minutes')::interval
        WHERE id = $1
        RETURNING hold_expires_at`,
      [offer.offered_show_seat_id, String(config.holdTtlMinutes)]
    );

    const { rows: seatDetail } = await client.query(SEAT_DETAIL_SQL, [[offer.offered_show_seat_id]]);

    return {
      showId: offer.show_id,
      seatId: offer.offered_show_seat_id,
      category: offer.category,
      holdExpiresAt: heldRows[0].hold_expires_at,
      seats: seatDetail,
    };
  });

  realtime.emitSeatUpdate(result.showId, result.seats, { reason: 'offer-accepted', actorId: customerId });

  return {
    show_id: result.showId,
    seat_ids: [result.seatId],
    category: result.category,
    hold_expires_at: result.holdExpiresAt,
    hold_ttl_minutes: config.holdTtlMinutes,
    seats: result.seats,
  };
}

/** Read an offer by token without consuming it, so the landing page can render it. */
async function getOfferByToken(token) {
  const { rows } = await query(
    `SELECT w.id, w.category, w.offer_expires_at, w.customer_id,
            w.offer_expires_at > now() AS still_valid,
            -- Selected so the route can return it as offer.seat.id. Without it the
            -- route's "id: offer.offered_show_seat_id" resolved to undefined and the
            -- key was silently dropped from the JSON response.
            w.offered_show_seat_id,
            s.id AS show_id, s.date, s.time,
            e.title AS event_title,
            v.name AS venue_name,
            vs.row_label, vs.seat_number,
            sp.price
       FROM waitlist w
       JOIN shows s  ON s.id = w.show_id
       JOIN events e ON e.id = s.event_id
       JOIN venues v ON v.id = e.venue_id
       LEFT JOIN show_seats oss ON oss.id = w.offered_show_seat_id
       LEFT JOIN venue_seats vs ON vs.id = oss.venue_seat_id
       LEFT JOIN show_pricing sp ON sp.show_id = w.show_id AND sp.category = w.category
      WHERE w.offer_token = $1 AND w.status = 'offered'`,
    [token]
  );
  if (!rows[0]) throw notFound('That offer link is not valid or has already been used');
  return rows[0];
}

/** Queue depth per category, for the organiser dashboard. */
async function getWaitlistSummary(showId) {
  const { rows } = await query(
    `SELECT category,
            count(*) FILTER (WHERE status = 'waiting')::int   AS waiting,
            count(*) FILTER (WHERE status = 'offered')::int   AS offered,
            count(*) FILTER (WHERE status = 'fulfilled')::int AS fulfilled,
            count(*) FILTER (WHERE status = 'expired')::int   AS expired
       FROM waitlist
      WHERE show_id = $1
      GROUP BY category
      ORDER BY category`,
    [showId]
  );
  return rows;
}

module.exports = {
  joinWaitlist,
  listMyWaitlist,
  leaveWaitlist,
  placeSeat,
  scheduleOfferEmails,
  expireOverdueOffers,
  acceptOffer,
  getOfferByToken,
  getWaitlistSummary,
  generateOfferToken,
};
