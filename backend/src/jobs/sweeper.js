'use strict';

/**
 * Background sweeper: expires stale holds and stale waitlist offers.
 *
 * Runs every 15 seconds by default (SWEEP_CRON).
 *
 * IMPORTANT FRAMING: this job is a tidier, not a source of truth. Every read path
 * treats a lapsed `hold_expires_at` as already free (see
 * seatService.EFFECTIVE_STATUS_SQL) and every write path re-checks expiry inside
 * its own transaction. So if this job were paused for an hour, no seat would be
 * wrongly withheld and no double booking would become possible — the sweep exists
 * to normalise rows, push Socket.io updates so open seat maps refresh without a
 * poll, and advance the waitlist queue, which is the one thing that genuinely does
 * need a scheduler because nobody's request would otherwise trigger it.
 */

const cron = require('node-cron');

const config = require('../config/env');
const { withTransaction } = require('../config/db');
const realtime = require('../realtime/io');
const { SEAT_DETAIL_SQL } = require('../services/holdService');

let task = null;
let running = false;

/**
 * Expire customer holds whose TTL has passed.
 *
 * `SKIP LOCKED` is what keeps this job from interfering with live traffic. A seat
 * that is currently inside a booking transaction is row-locked; without SKIP
 * LOCKED the sweep would queue behind that lock, holding its own transaction open
 * and delaying every other seat in the batch. Skipping is safe because a locked
 * row is by definition being dealt with by someone else right now, and if it is
 * still expired on the next tick we will pick it up then.
 *
 * Released seats go through waitlistService.placeSeat rather than straight to
 * 'available'. The brief describes hold expiry as flipping seats to available, and
 * for a category with nobody waiting that is exactly what placeSeat does. But when a
 * queue does exist, releasing to general sale would contradict the waitlist's own
 * rule that a seat only returns to general sale once the queue is empty — an
 * abandoned checkout would hand the seat to whoever refreshed fastest, ahead of
 * people who have been waiting. Routing every release through one decision keeps
 * that invariant true no matter which path freed the seat.
 */
async function sweepExpiredHolds() {
  const waitlistService = require('../services/waitlistService');

  return withTransaction(async (client) => {
    const { rows: expired } = await client.query(
      `SELECT id, show_id, category
         FROM show_seats
        WHERE status = 'held'
          AND hold_expires_at < now()
        ORDER BY id
        FOR UPDATE SKIP LOCKED`
    );

    if (expired.length === 0) {
      return { released: 0, offered: 0, byShow: new Map(), offers: [] };
    }

    let released = 0;
    let offered = 0;
    const offers = [];

    for (const seat of expired) {
      const outcome = await waitlistService.placeSeat(client, seat);
      if (outcome.outcome === 'offered') {
        offered += 1;
        offers.push(outcome);
      } else {
        released += 1;
      }
    }

    const ids = expired.map((r) => r.id);
    const { rows: seats } = await client.query(SEAT_DETAIL_SQL, [ids]);

    const byShow = new Map();
    for (const seat of seats) {
      if (!byShow.has(seat.show_id)) byShow.set(seat.show_id, []);
      byShow.get(seat.show_id).push(seat);
    }

    // Give the offer emails their context while the client is still available.
    const seatById = new Map(seats.map((s) => [s.id, s]));
    const showIds = [...new Set(seats.map((s) => s.show_id))];
    const { rows: shows } = await client.query(
      `SELECT s.id, s.date, s.time, e.title AS event_title, v.name AS venue_name
         FROM shows s
         JOIN events e ON e.id = s.event_id
         JOIN venues v ON v.id = e.venue_id
        WHERE s.id = ANY($1::int[])`,
      [showIds]
    );
    const showById = new Map(shows.map((s) => [s.id, s]));

    const enrichedOffers = offers.map((o) => {
      const seat = seatById.get(o.seatId);
      return { ...o, seat, show: showById.get(seat?.show_id) };
    });

    return { released, offered, byShow, offers: enrichedOffers };
  });
}

/**
 * Expire waitlist offers whose window has closed, and cascade each seat to the
 * next person in the queue.
 *
 * This is the part that must be a scheduled job. An expired customer hold is
 * effectively self-correcting because the next person to look at the seat map sees
 * the seat as free. An expired *offer* is different: the seat is earmarked for a
 * specific customer who did not act, and somebody has to notice and pass it along.
 * No user request would ever do that.
 *
 * Delegated to waitlistService because the cascade decision — next in FIFO order,
 * or release when the queue is empty — is the same logic a cancellation runs, and
 * having two copies of it would be how the two paths drift apart.
 */
async function sweepExpiredOffers() {
  // Required lazily to keep this file free of a load-order dependency on the
  // waitlist module, which itself pulls in holdService.
  const waitlistService = require('../services/waitlistService');
  return waitlistService.expireOverdueOffers();
}

/** One sweep pass. Exported so tests can drive it deterministically. */
async function runOnce({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...args) => console.log(...args);
  const summary = {
    holdsReleased: 0,
    holdsOfferedToWaitlist: 0,
    offersExpired: 0,
    offersCascaded: 0,
    seatsReleased: 0,
  };

  // The two sweeps are independent; a failure in one must not skip the other.
  try {
    const holds = await sweepExpiredHolds();
    summary.holdsReleased = holds.released;
    summary.holdsOfferedToWaitlist = holds.offered;

    for (const [showId, seats] of holds.byShow) {
      realtime.emitSeatUpdate(showId, seats, { reason: 'hold-expired' });
      realtime.emitAvailabilityChanged(showId, 'hold-expired');
    }

    if (holds.offers.length > 0) {
      require('../services/waitlistService').scheduleOfferEmails(holds.offers);
    }

    if (holds.released + holds.offered > 0) {
      log(
        `[sweep] expired ${holds.released + holds.offered} hold(s): ` +
          `${holds.released} released, ${holds.offered} offered to waitlist`
      );
    }
  } catch (err) {
    console.error('[sweep] hold sweep failed:', err.message);
  }

  try {
    const offers = await sweepExpiredOffers();
    summary.offersExpired = offers.expired;
    summary.offersCascaded = offers.cascaded;
    summary.seatsReleased = offers.released;
    if (offers.expired > 0) {
      log(
        `[sweep] expired ${offers.expired} offer(s): ` +
          `${offers.cascaded} cascaded to the next waitlist entry, ${offers.released} released`
      );
    }
  } catch (err) {
    console.error('[sweep] offer sweep failed:', err.message);
  }

  return summary;
}

/**
 * Start the scheduled sweeper.
 *
 * The `running` guard prevents overlapping passes. node-cron does not wait for an
 * async handler to finish before firing the next tick, so a sweep that takes
 * longer than the interval — a slow database moment, a large backlog — would
 * otherwise have two passes competing over the same rows.
 */
function start() {
  if (!config.sweepEnabled) {
    console.log('[sweep] disabled (SWEEP_ENABLED=false or NODE_ENV=test)');
    return null;
  }
  if (task) return task;

  task = cron.schedule(config.sweepCron, async () => {
    if (running) {
      console.warn('[sweep] previous pass still running, skipping this tick');
      return;
    }
    running = true;
    try {
      await runOnce({ quiet: true });
    } finally {
      running = false;
    }
  });

  console.log(`[sweep] scheduled "${config.sweepCron}"`);
  return task;
}

function stop() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = { start, stop, runOnce, sweepExpiredHolds, sweepExpiredOffers };
