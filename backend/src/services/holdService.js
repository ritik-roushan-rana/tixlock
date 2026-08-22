'use strict';

/**
 * Seat holds — the concurrency core of this application.
 *
 * =============================================================================
 * WHY EVERY MUTATION HERE LOOKS THE SAME
 * =============================================================================
 *
 * The dangerous pattern this module exists to avoid is the app-level
 * read-then-write:
 *
 *     const seats = await db.query('SELECT status FROM show_seats WHERE id = ANY($1)');
 *     if (seats.every(s => s.status === 'available')) {
 *       await db.query("UPDATE show_seats SET status = 'held' WHERE id = ANY($1)");
 *     }
 *
 * That has a time-of-check-to-time-of-use window between the two round trips.
 * Two requests can both read 'available', both pass the check, and both write —
 * so both customers are told they got seat A4. No amount of application logic
 * closes that window, because the gap is in the network round trip itself.
 *
 * The fix is to make the check and the set a single atomic database operation.
 * This module uses:
 *
 *     SELECT id FROM show_seats
 *      WHERE id = ANY($1) AND status = 'available'
 *      FOR UPDATE
 *
 * inside a transaction. `FOR UPDATE` takes a row-level write lock on every row
 * the SELECT returns. A concurrent transaction that tries to lock the same row
 * blocks until the first one commits or rolls back.
 *
 * The subtle part is what happens *after* that block ends. Under READ COMMITTED
 * — PostgreSQL's default — a statement that was waiting on a row lock does not
 * simply return the row it originally saw. When the blocking transaction commits,
 * PostgreSQL re-evaluates the WHERE clause against the newly committed version of
 * the row. The seat is now 'held', so `status = 'available'` is false, the row
 * drops out of the result set, and the second transaction's row count comes back
 * short. It rolls back and returns 409.
 *
 * That is why SERIALIZABLE is unnecessary here. SERIALIZABLE protects against
 * anomalies arising from reads the transaction did not lock; we are explicitly
 * locking the exact rows we intend to modify, so the narrower guarantee is
 * sufficient — and it costs no serialization failures to retry.
 *
 * `FOR UPDATE` versus the optimistic form:
 *
 *     UPDATE show_seats SET status = 'held'
 *      WHERE id = ANY($1) AND status = 'available'
 *     -- then compare rowCount to the requested count
 *
 * Both are correct, for the same underlying reason: the predicate is evaluated by
 * the database as part of the write, not by the application in between two
 * statements. They differ only in behaviour under contention. `FOR UPDATE` blocks
 * and then re-checks, so the loser learns precisely which seats it lost. The
 * optimistic UPDATE fails fast with a short row count but cannot say which seats
 * were the problem without a second query. Since a 409 here must name the
 * unavailable seats so the UI can grey them out, `FOR UPDATE` is the better fit.
 *
 * =============================================================================
 */

const { query, withTransaction } = require('../config/db');
const config = require('../config/env');
const { seatConflict, notFound, badRequest } = require('../lib/errors');
const realtime = require('../realtime/io');

/**
 * Columns needed to describe a seat in a broadcast, resolved inside the same
 * transaction that changed them.
 */
const SEAT_DETAIL_SQL = `
  SELECT ss.id, ss.show_id, ss.status::text AS status, ss.category,
         vs.row_label, vs.seat_number,
         sp.price
    FROM show_seats ss
    JOIN venue_seats vs ON vs.id = ss.venue_seat_id
    LEFT JOIN show_pricing sp ON sp.show_id = ss.show_id AND sp.category = ss.category
   WHERE ss.id = ANY($1::int[])
   ORDER BY vs.row_label, vs.seat_number
`;

/**
 * Place a hold on a set of seats.
 *
 * All-or-nothing: if any requested seat is not available, nothing is held and the
 * caller gets a 409 naming the seats that were taken.
 *
 * @param {number} showId
 * @param {number[]} seatIds  distinct seat ids (validation de-duplicates)
 * @param {number} customerId
 */
async function holdSeats(showId, seatIds, customerId) {
  if (seatIds.length === 0) throw badRequest('Select at least one seat');

  /**
   * Lock in a deterministic order.
   *
   * Two transactions requesting overlapping seat sets in opposite orders would
   * deadlock: A locks seat 5 and waits for seat 9 while B holds 9 and waits for 5.
   * PostgreSQL detects that and kills one with a deadlock error — a 500-class
   * failure for what should be an orderly 409. Sorting the ids means every
   * transaction walks the rows in the same sequence, so the second one simply
   * queues behind the first on the lowest contended id.
   */
  const orderedIds = [...seatIds].sort((a, b) => a - b);

  const result = await withTransaction(async (client) => {
    // Confirm the show exists before reporting seat-level problems, so a bad show
    // id is a 404 rather than a confusing "seats unavailable".
    const { rows: showRows } = await client.query('SELECT id FROM shows WHERE id = $1', [showId]);
    if (!showRows[0]) throw notFound(`Show ${showId} not found`);

    /**
     * The atomic check-then-set.
     *
     * Three things the predicate must express, all evaluated by PostgreSQL:
     *
     *  - `show_id = $2`  — a seat id from a different show must not be holdable
     *    through this endpoint, or a caller could hold seats for a show they are
     *    not looking at.
     *  - `status = 'available' OR (status IN ('held','offered') AND hold_expires_at < now())`
     *    — a seat whose hold has lapsed is genuinely free even though the sweeper
     *    has not rewritten the row yet. Requiring status = 'available' alone would
     *    make seat availability depend on cron timing, so a customer would be
     *    refused a seat that the seat map is showing as free.
     *  - `FOR UPDATE` — locks these rows for the duration of the transaction.
     */
    const { rows: lockable } = await client.query(
      `SELECT ss.id
         FROM show_seats ss
        WHERE ss.id = ANY($1::int[])
          AND ss.show_id = $2
          AND (
                ss.status = 'available'
             OR (ss.status IN ('held','offered') AND ss.hold_expires_at < now())
          )
        FOR UPDATE`,
      [orderedIds, showId]
    );

    // The row-count comparison. This is the assertion that makes concurrent
    // double-booking impossible: if anyone else claimed one of these seats
    // between our request arriving and our lock being granted, the row is gone
    // from this result and the counts disagree.
    if (lockable.length !== orderedIds.length) {
      const claimed = new Set(lockable.map((r) => r.id));
      const unavailable = orderedIds.filter((id) => !claimed.has(id));
      // Throwing rolls back the transaction, releasing every lock we did acquire
      // so the winning request is not delayed.
      throw seatConflict(unavailable);
    }

    const { rows: updated } = await client.query(
      `UPDATE show_seats
          SET status = 'held',
              held_by = $2,
              -- Computed by PostgreSQL, not Node: the deadline must come from the
              -- same clock the sweeper and every expiry predicate compare against.
              hold_expires_at = now() + ($3 || ' minutes')::interval
        WHERE id = ANY($1::int[])
        RETURNING id, hold_expires_at`,
      [orderedIds, customerId, String(config.holdTtlMinutes)]
    );

    const { rows: seats } = await client.query(SEAT_DETAIL_SQL, [orderedIds]);

    return {
      showId,
      seatIds: orderedIds,
      holdExpiresAt: updated[0].hold_expires_at,
      seats,
    };
  });

  // Broadcast after commit — other viewers must never be told about a change
  // that a later rollback would undo.
  realtime.emitSeatUpdate(showId, result.seats, { reason: 'hold', actorId: customerId });
  realtime.emitAvailabilityChanged(showId, 'hold');

  return {
    show_id: showId,
    seat_ids: result.seatIds,
    hold_expires_at: result.holdExpiresAt,
    hold_ttl_minutes: config.holdTtlMinutes,
    seats: result.seats,
  };
}

/**
 * Release the caller's own hold early (they clicked "release" or changed their mind).
 *
 * Scoped to `held_by = customerId AND status = 'held'` so this can never release
 * someone else's hold, and never touches an 'offered' seat — a waitlist offer is
 * released through the waitlist flow, which has to consider the queue.
 */
async function releaseHold(showId, customerId, seatIds = null) {
  const result = await withTransaction(async (client) => {
    const params = [showId, customerId];
    let filter = '';
    if (seatIds && seatIds.length > 0) {
      params.push([...seatIds].sort((a, b) => a - b));
      filter = ` AND ss.id = ANY($3::int[])`;
    }

    const { rows: locked } = await client.query(
      `SELECT ss.id
         FROM show_seats ss
        WHERE ss.show_id = $1
          AND ss.held_by = $2
          AND ss.status = 'held'
          ${filter}
        FOR UPDATE`,
      params
    );

    if (locked.length === 0) return { seats: [], releasedIds: [] };

    const ids = locked.map((r) => r.id);
    await client.query(
      `UPDATE show_seats
          SET status = 'available', held_by = NULL, hold_expires_at = NULL
        WHERE id = ANY($1::int[])`,
      [ids]
    );

    const { rows: seats } = await client.query(SEAT_DETAIL_SQL, [ids]);
    return { seats, releasedIds: ids };
  });

  if (result.releasedIds.length > 0) {
    realtime.emitSeatUpdate(showId, result.seats, { reason: 'release', actorId: customerId });
    realtime.emitAvailabilityChanged(showId, 'release');
  }

  return { released: result.releasedIds.length, seat_ids: result.releasedIds };
}

/**
 * The caller's current live holds for a show, with the server-side deadline.
 * Lets a page reloaded mid-hold restore its countdown from the server's clock.
 */
async function getMyHolds(showId, customerId) {
  const { rows } = await query(
    `SELECT ss.id, ss.category, ss.status::text AS status, ss.hold_expires_at,
            vs.row_label, vs.seat_number, sp.price
       FROM show_seats ss
       JOIN venue_seats vs ON vs.id = ss.venue_seat_id
       LEFT JOIN show_pricing sp ON sp.show_id = ss.show_id AND sp.category = ss.category
      WHERE ss.show_id = $1
        AND ss.held_by = $2
        AND ss.status IN ('held','offered')
        AND ss.hold_expires_at > now()
      ORDER BY vs.row_label, vs.seat_number`,
    [showId, customerId]
  );

  return {
    seats: rows,
    hold_expires_at: rows.length > 0 ? rows[0].hold_expires_at : null,
    server_time: new Date().toISOString(),
  };
}

module.exports = { holdSeats, releaseHold, getMyHolds, SEAT_DETAIL_SQL };
