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
 * still has seats free, a `held` seat with no expiry. Every state below is reachable by a
 * customer clicking buttons, because it was produced by the code those clicks run — and
 * the schema's own CHECK constraints agree, which is the cheapest available proof that
 * the demo is not lying.
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
 * bookings fill from the front of the house the way real ones do, instead of scattering
 * across the map by primary key.
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

/**
 * Sell every remaining seat in a category, in fixed-size chunks.
 *
 * Chunk size is not cosmetic. Cancelling one of these bookings later releases the whole
 * chunk at once, and each released seat is a separate offer to the queue — so the chunk
 * size decides how many offers a single cancellation produces. Act 4 depends on that
 * being exactly two.
 */
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
 * belong in one recipient's inbox and nowhere else. The demo needs one in order to redeem
 * it, so it is read from the row it was written to.
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
     Partial occupancy across every listing, so the organiser dashboard has real
     figures to report, no screen in the app is empty, and a customer browsing
     sees a seat map with genuine gaps in it rather than a wall of one colour.
     The past Interstellar showing is booked too, so revenue has history rather
     than only forecasts. */

  log('act 1 — ordinary bookings across all five listings');

  const interPast = shows('interstellar', 0);
  await book(ctx, { customer: 'customer1', showId: interPast, category: 'Gold', count: 2 });
  await book(ctx, { customer: 'arjun', showId: interPast, category: 'Standard', count: 3 });

  const interFri = shows('interstellar', 1);
  await book(ctx, { customer: 'customer1', showId: interFri, category: 'Premium', count: 2 });
  await book(ctx, { customer: 'customer2', showId: interFri, category: 'Gold', count: 3 });
  await book(ctx, { customer: 'neha', showId: interFri, category: 'Standard', count: 2 });
  await book(ctx, { customer: 'meera', showId: interFri, category: 'Standard', count: 4 });
  await book(ctx, { customer: 'dev', showId: shows('interstellar', 3), category: 'Gold', count: 2 });

  const avengers = shows('avengers', 0);
  await book(ctx, { customer: 'customer2', showId: avengers, category: 'Premium', count: 2 });
  await book(ctx, { customer: 'vikram', showId: avengers, category: 'Gold', count: 3 });
  await book(ctx, { customer: 'ananya', showId: avengers, category: 'Standard', count: 4 });
  await book(ctx, { customer: 'neha', showId: shows('avengers', 1), category: 'Standard', count: 2 });

  const duneMatinee = shows('dune', 0);
  await book(ctx, { customer: 'arjun', showId: duneMatinee, category: 'Gold', count: 3 });
  const toCancel = await book(ctx, {
    customer: 'customer1',
    showId: duneMatinee,
    category: 'Standard',
    count: 1,
  });
  await book(ctx, { customer: 'meera', showId: shows('dune', 1), category: 'Premium', count: 2 });

  const coldplayNight1 = shows('coldplay', 0);
  await book(ctx, { customer: 'customer1', showId: coldplayNight1, category: 'Gold', count: 2 });
  await book(ctx, { customer: 'dev', showId: coldplayNight1, category: 'Standard', count: 5 });
  await book(ctx, { customer: 'meera', showId: coldplayNight1, category: 'Standard', count: 4 });
  await book(ctx, { customer: 'vikram', showId: shows('coldplay', 1), category: 'Standard', count: 6 });
  await book(ctx, { customer: 'ananya', showId: shows('coldplay', 1), category: 'Gold', count: 2 });

  /* --- Act 2: a cancellation with nobody waiting -----------------------
     The plain path, and the contrast that makes Act 4 legible: with an empty
     queue a released seat simply goes back on general sale. It also leaves a
     cancelled row in customer1's history, a view a freshly built dataset
     otherwise never exercises. */

  log('act 2 — a cancellation with an empty queue (seat returns to general sale)');
  const plainCancel = await cancel(ctx, { customer: 'customer1', bookingId: toCancel.id });
  facts.plainCancellation = {
    ref: plainCancel.booking_ref,
    released: plainCancel.seats_released,
    offered: plainCancel.seats_offered_to_waitlist,
  };

  /* --- Act 3: an event sold out down to the last seat -------------------
     Arijit Singh Live has one showing in a 24-seat room, and all three
     categories go to zero — so the *event* is sold out, not merely a tier of it.
     Every seat travels the real hold-then-book path; nothing is asserted.

     Six customers then queue across the three categories, and are left waiting.
     That is the setup an evaluator needs in order to fire the auto-assignment
     themselves by cancelling one of the bookings: because nothing has been
     offered yet, the FIFO order is theirs to verify rather than take on trust. */

  log('act 3 — Arijit Singh Live sells out completely, six customers queue');
  const arijit = shows('arijit', 0);

  /**
   * Booked first, and by a documented account rather than an audience fixture.
   *
   * The demo asks an evaluator to cancel a booking on the sold-out event in order to
   * watch the queue be served. That only works if they can sign in as whoever owns it,
   * so the seats have to belong to customer1 — handing out an audience fixture's
   * credentials for the headline demo action would be a poor trade. Standard rather than
   * Premium because customer1 is about to join the *Premium* queue, and offering
   * somebody the seat they just released reads like a bug even when it is not.
   */
  const evaluatorCancellable = await book(ctx, {
    customer: 'customer1',
    showId: arijit,
    category: 'Standard',
    count: 2,
  });

  for (const category of ['Premium', 'Gold', 'Standard']) {
    await sellOut(ctx, {
      showId: arijit,
      category,
      buyers: ['neha', 'arjun', 'meera', 'vikram', 'ananya', 'dev'],
      chunk: 2,
    });
  }

  const queue = [];
  const waitlistPlan = [
    { category: 'Premium', who: ['customer1', 'neha'] },
    { category: 'Gold', who: ['customer2', 'arjun'] },
    { category: 'Standard', who: ['meera', 'vikram'] },
  ];
  for (const { category, who } of waitlistPlan) {
    for (const customer of who) {
      const entry = await joinQueue(ctx, { customer, showId: arijit, category });
      queue.push({ customer, category, position: entry.position });
    }
  }

  const stillFree = await query(
    `SELECT count(*)::int AS n FROM show_seats WHERE show_id = $1 AND status = 'available'`,
    [arijit]
  );
  if (stillFree.rows[0].n !== 0) {
    // The headline claim of the demo. If it is ever untrue, fail rather than ship a
    // "sold out" event with seats quietly left in it.
    throw new Error(`Arijit Singh Live should be sold out, but ${stillFree.rows[0].n} seat(s) are free`);
  }

  facts.soldOut = {
    showId: arijit,
    queue,
    cancellable: {
      customer: 'customer1',
      ref: evaluatorCancellable.booking_ref,
      seats: 2,
      category: 'Standard',
    },
  };

  /* --- Act 4: the full waitlist loop, already played out ---------------
     Coldplay's Premium tier sells out, two customers queue, and one booking is
     cancelled. Its two seats are offered to the queue in order — that is
     `placeSeat` doing the work, not the demo assigning anything.

     The two offers are then deliberately left in different states, because they
     demonstrate different halves of the same requirement:
       - customer2 redeems hers, leaving a completed offer -> hold -> booking
         chain visible as a 'fulfilled' queue entry with a real ticket behind it.
       - customer1's is left open, so a live time-limited link is clickable in the
         UI for as long as OFFER_TTL_MINUTES allows.

     Note the tier stays sold out throughout: a cancelled seat becomes 'offered',
     never 'available', so it is never briefly on general sale. */

  log('act 4 — Coldplay Premium sells out, is cancelled into, and one offer is redeemed');
  const coldplayPremium = await sellOut(ctx, {
    showId: coldplayNight1,
    category: 'Premium',
    buyers: ['neha', 'arjun', 'meera', 'vikram', 'ananya', 'dev'],
    chunk: 2,
  });

  // customer2 joins first, so FIFO hands her the first released seat.
  await joinQueue(ctx, { customer: 'customer2', showId: coldplayNight1, category: 'Premium' });
  await joinQueue(ctx, { customer: 'customer1', showId: coldplayNight1, category: 'Premium' });

  // Cancelled by arjun, who is not in the queue — so both released seats go to
  // waiting customers rather than one returning to its own owner.
  const cascade = await cancel(ctx, { customer: 'arjun', bookingId: coldplayPremium[1].id });
  if (cascade.seats_offered_to_waitlist !== 2) {
    // Worth failing loudly. If this ever returns 0 the demo would ship a "waitlist"
    // containing no offer, which is the one thing this act exists to show.
    throw new Error(
      `Expected the cancellation to produce 2 waitlist offers, got ${cascade.seats_offered_to_waitlist}`
    );
  }

  const customer2 = ctx.user('customer2');
  const token = await offerTokenFor(coldplayNight1, customer2.id);
  const accepted = await waitlistService.acceptOffer(token, customer2.id);
  const redeemed = await bookingService.createBooking({
    showId: coldplayNight1,
    seatIds: accepted.seat_ids,
    customer: { id: customer2.id, name: customer2.name, email: customer2.email },
  });
  ctx.count.bookings += 1;

  facts.waitlistLoop = {
    showId: coldplayNight1,
    category: 'Premium',
    cancelledRef: cascade.booking_ref,
    offersCreated: cascade.seats_offered_to_waitlist,
    fulfilled: { customer: 'customer2', ref: redeemed.booking.booking_ref },
    openOffer: { customer: 'customer1' },
  };

  /* --- Act 5: a live checkout hold -------------------------------------
     Somebody mid-checkout, so a seat map shows all four seat states at once
     rather than only available and booked. Short-lived by nature: this is a real
     hold with the real TTL, so it auto-releases like any other. That it decays is
     the honest behaviour — a hold pinned open forever would misrepresent the very
     mechanism it is there to illustrate. */

  log('act 5 — a live checkout hold, with the real TTL');
  const holdShow = shows('interstellar', 2);
  const holdSeatIds = await availableSeats(holdShow, 'Premium', 2);
  const held = await holdService.holdSeats(holdShow, holdSeatIds, ctx.user('customer2').id);
  facts.liveHold = {
    showId: holdShow,
    customer: 'customer2',
    seats: held.seats.map((s) => `${s.row_label}${s.seat_number}`).join(', '),
    ttlMinutes: held.hold_ttl_minutes,
    expiresAt: held.hold_expires_at,
  };

  return facts;
}

module.exports = { play };
