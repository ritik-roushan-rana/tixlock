'use strict';

/**
 * The demo narrative: the sequence of real customer actions that leaves the system in a
 * state worth looking at.
 *
 * Everything here runs through the ordinary service layer — `holdSeats`, then
 * `createBooking`, then `cancelBooking`, then `joinWaitlist`, then `acceptOffer` — with
 * no direct writes to `show_seats`, `bookings` or `waitlist`. That is the point.
 * Hand-written INSERTs would let the demo present states the application can never
 * actually reach: a booking with no matching hold, a waitlist offer on a category that
 * still has seats free, a `held` seat with no expiry. Every state below is reachable by
 * a customer clicking buttons, because it was produced by the code those clicks run —
 * and the schema's own CHECK constraints agree, which is the cheapest available proof
 * that the demo is not lying.
 *
 * Order is load-bearing and reads top to bottom. You cannot cancel what nobody booked,
 * and `joinWaitlist` refuses outright while even one seat in the category is still
 * available, so a tier has to be genuinely sold out before anyone can queue for it.
 */

const { query } = require('../../config/db');
const holdService = require('../../services/holdService');
const bookingService = require('../../services/bookingService');
const waitlistService = require('../../services/waitlistService');

/**
 * The next N available seats of a category, in seating order.
 *
 * A read, so it goes straight to SQL. Ordering by row then seat number means demo
 * bookings fill from the front of the house the way real ones do, instead of
 * scattering across the map by primary key.
 */
async function availableSeats(showId, category, count) {
  const { rows } = await query(
    `SELECT ss.id
       FROM show_seats ss
       JOIN venue_seats vs ON vs.id = ss.venue_seat_id
      WHERE ss.show_id = $1
        AND ss.category = $2
        AND ss.status = 'available'
      ORDER BY vs.row_label, vs.seat_number
      LIMIT $3`,
    [showId, category, count]
  );
  if (rows.length < count) {
    throw new Error(
      `Demo needs ${count} available "${category}" seat(s) on show ${showId}, found ${rows.length}. ` +
        'Reduce that booking or enlarge the category in catalogue.js.'
    );
  }
  return rows.map((r) => r.id);
}

/** How many seats of a category are still sellable — used to sell a tier out exactly. */
async function countAvailable(showId, category) {
  const { rows } = await query(
    `SELECT count(*)::int AS n
       FROM show_seats
      WHERE show_id = $1 AND category = $2 AND status = 'available'`,
    [showId, category]
  );
  return rows[0].n;
}

/**
 * Book seats the way a customer does: place a hold, then convert it.
 *
 * Two calls rather than one because that is the only path the application offers.
 * `createBooking` requires the seats to already be held by this customer and not yet
 * expired, so a demo that skipped the hold would have to fake the seat state.
 */
async function book(ctx, { customer, showId, category, count }) {
  const user = ctx.user(customer);
  const seatIds = await availableSeats(showId, category, count);
  await holdService.holdSeats(showId, seatIds, user.id);
  const result = await bookingService.createBooking({
    showId,
    seatIds,
    customer: { id: user.id, name: user.name, email: user.email },
  });
  ctx.count.bookings += 1;
  return result.booking;
}

/** Sell every remaining seat in a category, in chunks, so the tier ends up sold out. */
async function sellOut(ctx, { showId, category, buyers, chunk }) {
  let remaining = await countAvailable(showId, category);
  let i = 0;
  const bookings = [];
  while (remaining > 0) {
    const take = Math.min(chunk, remaining);
    bookings.push(
      await book(ctx, { customer: buyers[i % buyers.length], showId, category, count: take })
    );
    remaining -= take;
    i += 1;
  }
  return bookings;
}

async function cancel(ctx, { customer, bookingId }) {
  const user = ctx.user(customer);
  const result = await bookingService.cancelBooking(bookingId, { id: user.id, role: 'customer' });
  ctx.count.cancellations += 1;
  return result;
}

async function joinQueue(ctx, { customer, showId, category }) {
  const user = ctx.user(customer);
  const entry = await waitlistService.joinWaitlist({ showId, category, customerId: user.id });
  ctx.count.waitlistJoins += 1;
  return entry;
}

/**
 * Read back the token an offer email would have carried.
 *
 * `cancelBooking` does not return offer tokens, deliberately — they are secrets that
 * belong in one recipient's inbox and nowhere else. The demo needs one in order to
 * redeem it, so it is read from the row it was written to.
 */
async function offerTokenFor(showId, customerId) {
  const { rows } = await query(
    `SELECT offer_token
       FROM waitlist
      WHERE show_id = $1 AND customer_id = $2 AND status = 'offered'
      LIMIT 1`,
    [showId, customerId]
  );
  if (!rows[0]?.offer_token) {
    throw new Error(`Expected an open waitlist offer for customer ${customerId} on show ${showId}`);
  }
  return rows[0].offer_token;
}

/* ------------------------------------------------------------------------- */

async function play(ctx) {
  const { shows, log } = ctx;
  const facts = {};

  /* --- Act 1: ordinary trade -------------------------------------------
     Enough spread that the organiser dashboards have something to report and no
     screen in the app is empty. The past Interstellar showing is included so
     revenue has history rather than only forecasts. */

  log('act 1 — ordinary bookings across both organisers');

  const pastInterstellar = shows('interstellar', 0);
  await book(ctx, { customer: 'aarav', showId: pastInterstellar, category: 'Premium', count: 2 });
  await book(ctx, { customer: 'rohan', showId: pastInterstellar, category: 'Standard', count: 3 });

  const interFriday = shows('interstellar', 1);
  await book(ctx, { customer: 'aarav', showId: interFriday, category: 'Recliner', count: 2 });
  await book(ctx, { customer: 'priya', showId: interFriday, category: 'Premium', count: 3 });
  await book(ctx, { customer: 'rohan', showId: interFriday, category: 'Standard', count: 2 });
  await book(ctx, { customer: 'meera', showId: interFriday, category: 'Standard', count: 4 });
  await book(ctx, { customer: 'dev', showId: shows('interstellar', 3), category: 'Premium', count: 2 });

  const laapataaMatinee = shows('laapataa', 0);
  await book(ctx, { customer: 'zoya', showId: laapataaMatinee, category: 'Premium', count: 3 });
  const toCancel = await book(ctx, {
    customer: 'aarav',
    showId: laapataaMatinee,
    category: 'Standard',
    count: 1,
  });
  await book(ctx, { customer: 'vikram', showId: shows('laapataa', 1), category: 'Recliner', count: 2 });

  await book(ctx, { customer: 'ananya', showId: shows('kantara', 0), category: 'Recliner', count: 2 });
  await book(ctx, { customer: 'dev', showId: shows('kantara', 0), category: 'Standard', count: 3 });

  const arijitNight1 = shows('arijit', 0);
  await book(ctx, { customer: 'aarav', showId: arijitNight1, category: 'Premium', count: 2 });
  await book(ctx, { customer: 'priya', showId: arijitNight1, category: 'Premium', count: 3 });
  await book(ctx, { customer: 'dev', showId: arijitNight1, category: 'General', count: 5 });
  await book(ctx, { customer: 'meera', showId: arijitNight1, category: 'General', count: 4 });

  // Night 2 leaves Golden Circle untouched, so one event shows a sold-out tier and
  // an open tier side by side.
  const arijitNight2 = shows('arijit', 1);
  await book(ctx, { customer: 'vikram', showId: arijitNight2, category: 'General', count: 6 });
  await book(ctx, { customer: 'ananya', showId: arijitNight2, category: 'Premium', count: 2 });

  await book(ctx, { customer: 'priya', showId: shows('coldplay', 0), category: 'General', count: 2 });
  await book(ctx, { customer: 'aarav', showId: shows('coldplay', 0), category: 'Premium', count: 2 });

  const jazzThisWeek = shows('jazz', 0);
  await book(ctx, { customer: 'aarav', showId: jazzThisWeek, category: 'Standard', count: 2 });
  await book(ctx, { customer: 'meera', showId: jazzThisWeek, category: 'Standard', count: 3 });
  await book(ctx, { customer: 'dev', showId: shows('jazz', 1), category: 'Standard', count: 2 });

  /* --- Act 2: a cancellation with nobody waiting -----------------------
     The plain path, and the contrast that makes Act 4 legible: with an empty
     queue a released seat simply returns to general sale. It also leaves a
     cancelled row in one customer's history, a view a fresh dataset otherwise
     never exercises. */

  log('act 2 — a cancellation with an empty queue (seat returns to general sale)');
  const plainCancel = await cancel(ctx, { customer: 'aarav', bookingId: toCancel.id });
  facts.plainCancellation = {
    ref: plainCancel.booking_ref,
    released: plainCancel.seats_released,
    offered: plainCancel.seats_offered_to_waitlist,
  };

  /* --- Act 3: a sold-out tier with a queue behind it -------------------
     Golden Circle on night 1 goes to zero, then three people queue for it. Left
     in exactly that state on purpose: it is the setup an evaluator needs in order
     to trigger the auto-assignment themselves, by signing in as one of the
     holders and cancelling. Nothing has been offered yet, so the FIFO order is
     theirs to verify. */

  log('act 3 — Golden Circle sells out, three customers queue');
  const gcBookings = await sellOut(ctx, {
    showId: arijitNight1,
    category: 'Golden Circle',
    buyers: ['rohan', 'meera', 'dev'],
    chunk: 4,
  });
  const queue = [];
  for (const who of ['zoya', 'ananya', 'vikram']) {
    const entry = await joinQueue(ctx, {
      customer: who,
      showId: arijitNight1,
      category: 'Golden Circle',
    });
    queue.push({ who, position: entry.position });
  }
  facts.soldOutQueue = {
    showId: arijitNight1,
    category: 'Golden Circle',
    queue,
    cancellable: { customer: 'rohan', ref: gcBookings[0].booking_ref, seats: 4 },
  };

  /* --- Act 4: the full waitlist loop, already played out ---------------
     Premium at the Opera House sells out, two people queue, and one booking is
     cancelled. The two released seats are offered to the queue in order — that is
     `placeSeat` doing the work, not the demo assigning anything.

     The two offers are then left in different states, because they demonstrate
     different halves of the requirement:
       - Priya redeems hers, so there is a completed offer -> hold -> booking chain
         visible as a 'fulfilled' queue entry with a real ticket behind it.
       - Zoya's is left open, so a live time-limited link is clickable in the UI
         for as long as OFFER_TTL_MINUTES allows. */

  log('act 4 — Opera House Premium sells out, is cancelled into, and one offer is redeemed');
  const jazzPremium = await sellOut(ctx, {
    showId: jazzThisWeek,
    category: 'Premium',
    buyers: ['ananya', 'vikram', 'rohan', 'dev'],
    chunk: 2,
  });

  // Priya joins first, so FIFO gives her the first released seat.
  await joinQueue(ctx, { customer: 'priya', showId: jazzThisWeek, category: 'Premium' });
  await joinQueue(ctx, { customer: 'zoya', showId: jazzThisWeek, category: 'Premium' });

  const cascade = await cancel(ctx, { customer: 'ananya', bookingId: jazzPremium[0].id });
  if (cascade.seats_offered_to_waitlist !== 2) {
    // Worth failing loudly. If this ever returns 0 the demo would ship a
    // "waitlist" with no offer in it, which is the one thing it exists to show.
    throw new Error(
      `Expected the cancellation to produce 2 waitlist offers, got ${cascade.seats_offered_to_waitlist}`
    );
  }

  const priya = ctx.user('priya');
  const token = await offerTokenFor(jazzThisWeek, priya.id);
  const accepted = await waitlistService.acceptOffer(token, priya.id);
  const redeemed = await bookingService.createBooking({
    showId: jazzThisWeek,
    seatIds: accepted.seat_ids,
    customer: { id: priya.id, name: priya.name, email: priya.email },
  });
  ctx.count.bookings += 1;

  facts.waitlistLoop = {
    showId: jazzThisWeek,
    category: 'Premium',
    cancelledRef: cascade.booking_ref,
    offersCreated: cascade.seats_offered_to_waitlist,
    fulfilled: { customer: 'priya', ref: redeemed.booking.booking_ref },
    openOffer: { customer: 'zoya' },
  };

  /* --- Act 5: a live checkout hold -------------------------------------
     Somebody mid-checkout, so the seat map shows all four seat states at once
     rather than only available and booked. Short-lived by nature: this is a real
     hold with the real TTL, so it auto-releases like any other. That it decays is
     the honest behaviour — a hold pinned open forever would misrepresent the very
     mechanism it is there to illustrate. */

  log('act 5 — a live checkout hold, with the real TTL');
  const holdShow = shows('interstellar', 2);
  const holdSeatIds = await availableSeats(holdShow, 'Recliner', 2);
  const held = await holdService.holdSeats(holdShow, holdSeatIds, ctx.user('priya').id);
  facts.liveHold = {
    showId: holdShow,
    customer: 'priya',
    seats: held.seats.map((s) => `${s.row_label}${s.seat_number}`).join(', '),
    ttlMinutes: held.hold_ttl_minutes,
    expiresAt: held.hold_expires_at,
  };

  return facts;
}

module.exports = { play };
