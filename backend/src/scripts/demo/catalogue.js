'use strict';

/**
 * The demo catalogue: who exists, where things happen, and what is on sale.
 *
 * Split from the narrative (see narrative.js) on purpose. This file is a static
 * description — accounts, venues, seat layouts, listings, showtimes, prices — and can be
 * edited freely without thinking about ordering. The narrative is the part where order
 * matters, because a cancellation needs a booking to cancel.
 *
 * Dates are offsets from the day the demo is built, never literals. A dataset with
 * hard-coded dates quietly ages into a list of past events that the public browse filters
 * out, and the app then presents itself to an evaluator as having nothing on. One
 * negative offset is deliberate: a past showing gives revenue a history.
 */

/* --- Accounts -------------------------------------------------------------
   Two tiers, and the distinction matters.

   SIGN-IN accounts are the four an evaluator is given. They are the documented
   credentials and they carry the interesting states.

   AUDIENCE accounts exist only to be other people: to fill a waitlist queue with
   a plausible line of customers, and to make an organiser's attendee list look
   like an audience rather than the same two names repeated. Nobody signs in as
   them, so they are not advertised.

   The audience addresses deliberately sit on a reserved `.local` domain. The
   mailer refuses to hand reserved domains to the provider, so a cancellation or
   waitlist offer involving one of these fixtures can never generate a bounce —
   and cancellations are exactly what the demo invites an evaluator to trigger.
   The four sign-in addresses have to be @tixlock.com because those are the
   credentials that were specified; see the note on tixlock.com in mailer.js. */

const SIGN_IN_USERS = [
  {
    key: 'organiser',
    name: 'Rhea Kapoor',
    email: 'organiser@tixlock.com',
    role: 'organiser',
    password: 'Organiser123',
    note: 'Owns all five listings — revenue and occupancy per event',
  },
  {
    key: 'customer1',
    name: 'Aarav Sharma',
    email: 'customer1@tixlock.com',
    role: 'customer',
    password: 'Customer123',
    note: 'Booking history, a cancellation, and a place in the sold-out queue',
  },
  {
    key: 'customer2',
    name: 'Priya Menon',
    email: 'customer2@tixlock.com',
    role: 'customer',
    password: 'Customer123',
    note: 'A live checkout hold, and a waitlist offer already redeemed',
  },
];

const AUDIENCE_USERS = [
  { key: 'neha', name: 'Neha Deshpande', email: 'neha@audience.tixlock.local', role: 'customer', password: 'Customer123' },
  { key: 'arjun', name: 'Arjun Rao', email: 'arjun@audience.tixlock.local', role: 'customer', password: 'Customer123' },
  { key: 'meera', name: 'Meera Nair', email: 'meera@audience.tixlock.local', role: 'customer', password: 'Customer123' },
  { key: 'vikram', name: 'Vikram Desai', email: 'vikram@audience.tixlock.local', role: 'customer', password: 'Customer123' },
  { key: 'ananya', name: 'Ananya Iyer', email: 'ananya@audience.tixlock.local', role: 'customer', password: 'Customer123' },
  { key: 'dev', name: 'Dev Malhotra', email: 'dev@audience.tixlock.local', role: 'customer', password: 'Customer123' },
];

const USERS = [...SIGN_IN_USERS, ...AUDIENCE_USERS];

/* --- Venues ---------------------------------------------------------------
   Every venue carries the same three categories — Premium, Gold, Standard — so a
   price tier means the same thing wherever an evaluator looks.

   Seat counts are chosen for demonstrability rather than realism. A category has
   to be small enough that "sold out" is reachable in a handful of bookings and
   legible on one screen; a true 20,000-seat arena would make the waitlist story
   invisible. The Opera House is deliberately tiny, because that is where the
   fully sold-out event lives. */

const VENUES = [
  {
    key: 'pvr',
    name: 'PVR Icon — Screen 5',
    address: 'Phoenix Mills, Lower Parel, Mumbai 400013',
    layout: [
      { row_label: 'A', seats: 8, category: 'Premium' },
      { row_label: 'B', seats: 8, category: 'Premium' },
      { row_label: 'C', seats: 12, category: 'Gold' },
      { row_label: 'D', seats: 12, category: 'Gold' },
      { row_label: 'E', seats: 14, category: 'Standard' },
      { row_label: 'F', seats: 14, category: 'Standard' },
    ],
  },
  {
    key: 'bkc',
    name: 'Jio World Garden, BKC',
    address: 'Bandra Kurla Complex, Mumbai 400051',
    layout: [
      // The smallest tier at this venue, so it can be sold out inside the demo
      // and carry the offer/redemption story without the whole arena filling up.
      { row_label: 'P1', seats: 6, category: 'Premium' },
      { row_label: 'P2', seats: 6, category: 'Premium' },
      { row_label: 'G1', seats: 14, category: 'Gold' },
      { row_label: 'G2', seats: 14, category: 'Gold' },
      { row_label: 'S1', seats: 18, category: 'Standard' },
      { row_label: 'S2', seats: 18, category: 'Standard' },
    ],
  },
  {
    key: 'opera',
    name: 'Royal Opera House — The Quarter',
    address: 'Mama Parmanand Marg, Girgaon, Mumbai 400004',
    layout: [
      { row_label: 'A', seats: 4, category: 'Premium' },
      { row_label: 'B', seats: 4, category: 'Premium' },
      { row_label: 'C', seats: 4, category: 'Gold' },
      { row_label: 'D', seats: 4, category: 'Gold' },
      { row_label: 'E', seats: 4, category: 'Standard' },
      { row_label: 'F', seats: 4, category: 'Standard' },
    ],
  },
];

/* --- Listings -------------------------------------------------------------
   Descriptions are written out rather than lorem-filled because they do real
   work: the event detail page gives them the space licensed artwork would occupy,
   and the browse search matches them alongside title and venue name.

   `pricing` is the event's default per-category map. A showing may override it —
   matinees are cheaper — which is the point of pricing belonging to the showing
   rather than to the event. */

const EVENTS = [
  {
    key: 'interstellar',
    title: 'Interstellar Re-Release',
    type: 'movie',
    organiser: 'organiser',
    venue: 'pvr',
    description:
      'Nolan’s 2014 epic returns in a new 70mm IMAX transfer, with the Hans Zimmer organ score remixed for the format. 169 minutes, English with subtitles.',
    pricing: { Premium: 650, Gold: 450, Standard: 280 },
    showings: [
      // Past showing: gives the organiser's revenue a completed date to report,
      // and demonstrates that past shows drop out of the public browse.
      { dayOffset: -6, time: '18:30' },
      { dayOffset: 2, time: '18:30' },
      { dayOffset: 2, time: '22:00' },
      { dayOffset: 4, time: '19:00' },
    ],
  },
  {
    key: 'avengers',
    title: 'Avengers Marathon',
    type: 'movie',
    organiser: 'organiser',
    venue: 'pvr',
    description:
      'All four Avengers films back to back, with two intervals and a refill counter. Doors 09:00, runs about eleven hours — bring a cushion.',
    pricing: { Premium: 1200, Gold: 850, Standard: 550 },
    showings: [
      { dayOffset: 5, time: '09:30' },
      { dayOffset: 12, time: '09:30' },
    ],
  },
  {
    key: 'dune',
    title: 'Dune: Part Three',
    type: 'movie',
    organiser: 'organiser',
    venue: 'pvr',
    description:
      'Villeneuve closes the Arrakis saga. Presented in Dolby Atmos, 156 minutes, English with subtitles.',
    pricing: { Premium: 750, Gold: 500, Standard: 320 },
    showings: [
      // Matinee rates, to show per-showing pricing rather than per-event pricing.
      { dayOffset: 3, time: '12:45', pricing: { Premium: 500, Gold: 350, Standard: 220 } },
      { dayOffset: 6, time: '20:15' },
    ],
  },
  {
    key: 'coldplay',
    title: 'Coldplay World Tour',
    type: 'concert',
    organiser: 'organiser',
    venue: 'bkc',
    description:
      'The Music of the Spheres tour reaches Mumbai, with LED wristbands issued at the gate and a kinetic-floor section funding the show’s renewable power target.',
    pricing: { Premium: 18000, Gold: 9500, Standard: 4500 },
    showings: [
      { dayOffset: 9, time: '20:00' },
      { dayOffset: 10, time: '20:00' },
    ],
  },
  {
    /**
     * The completely sold-out event.
     *
     * One showing, not several, and at the 24-seat venue — both deliberate. "Sold
     * out" has to mean the event, so a second showing with seats left would make
     * the claim false; and a small room is what lets every last seat genuinely go
     * through the booking path rather than being asserted.
     */
    key: 'arijit',
    title: 'Arijit Singh Live',
    type: 'concert',
    organiser: 'organiser',
    venue: 'opera',
    description:
      'An unplugged night in the Opera House’s side room — voice, piano and a string quartet, 24 seats, no amplification. Sold out.',
    pricing: { Premium: 8500, Gold: 5500, Standard: 3200 },
    showings: [{ dayOffset: 8, time: '19:30' }],
  },
];

module.exports = { USERS, SIGN_IN_USERS, AUDIENCE_USERS, VENUES, EVENTS };
