'use strict';

/**
 * The demo catalogue: who exists, where things happen, and what is on sale.
 *
 * Split from the narrative (see narrative.js) on purpose. This file is a static
 * description — accounts, venues, seat layouts, listings, showtimes, prices — and can
 * be edited freely without thinking about ordering. The narrative is the part where
 * order matters, because a cancellation needs a booking to cancel.
 *
 * Two rules hold throughout:
 *
 *  1. **Every address is `@ticketbooking.local`.** The mailer refuses to hand reserved
 *     domains to the provider (see UNROUTABLE_DOMAIN in mailer.js), so building the
 *     demo cannot send mail, cannot bounce, and cannot burn send quota. An evaluator
 *     who wants to see a real email registers with their own address.
 *  2. **Dates are offsets from the day the demo is built**, never literals. A dataset
 *     with hard-coded dates quietly ages into a list of past events that the public
 *     browse filters out, and the app then presents itself as having nothing on. One
 *     negative offset is deliberate: a past showing gives revenue a history.
 */

/* --- Accounts -------------------------------------------------------------
   The first four addresses are fixed contracts rather than choices: the sign-in
   screen's one-click demo buttons and every e2e script reference these exact
   addresses and passwords. The rest exist so booking lists and waitlist queues
   read like people instead of customer1/customer2. */

const USERS = [
  { key: 'organiser', name: 'Rhea Kapoor', email: 'organiser@ticketbooking.local', role: 'organiser', password: 'organiser123', note: 'Films at Cineplex Andheri' },
  { key: 'promoter', name: 'Kabir Sethi', email: 'promoter@ticketbooking.local', role: 'organiser', password: 'organiser123', note: 'Concerts at BKC + the Opera House' },

  { key: 'aarav', name: 'Aarav Sharma', email: 'customer@ticketbooking.local', role: 'customer', password: 'customer123', note: 'Booking history including a cancellation' },
  { key: 'priya', name: 'Priya Menon', email: 'customer2@ticketbooking.local', role: 'customer', password: 'customer123', note: 'A live checkout hold, and a fulfilled waitlist offer' },

  { key: 'rohan', name: 'Rohan Iyer', email: 'rohan@ticketbooking.local', role: 'customer', password: 'customer123', note: 'Holds 4 seats in a sold-out tier — cancel these' },
  { key: 'meera', name: 'Meera Nair', email: 'meera@ticketbooking.local', role: 'customer', password: 'customer123' },
  { key: 'zoya', name: 'Zoya Qureshi', email: 'zoya@ticketbooking.local', role: 'customer', password: 'customer123', note: 'Has a live, time-limited seat offer' },
  { key: 'ananya', name: 'Ananya Rao', email: 'ananya@ticketbooking.local', role: 'customer', password: 'customer123' },
  { key: 'vikram', name: 'Vikram Desai', email: 'vikram@ticketbooking.local', role: 'customer', password: 'customer123' },
  { key: 'dev', name: 'Dev Malhotra', email: 'dev@ticketbooking.local', role: 'customer', password: 'customer123' },
];

/* --- Venues ---------------------------------------------------------------
   Seat counts are chosen for demonstrability, not realism. A category has to be
   small enough that "sold out" is reachable in a handful of bookings and legible
   on one screen; a true 20,000-seat arena would make the waitlist story
   invisible. Row labels follow each building's own convention so the seat map
   reads like the place it describes. */

const VENUES = [
  {
    key: 'cineplex',
    name: 'Cineplex Andheri — Screen 4',
    address: 'Veera Desai Road, Andheri West, Mumbai 400053',
    layout: [
      { row_label: 'A', seats: 8, category: 'Recliner' },
      { row_label: 'B', seats: 8, category: 'Recliner' },
      { row_label: 'C', seats: 12, category: 'Premium' },
      { row_label: 'D', seats: 12, category: 'Premium' },
      { row_label: 'E', seats: 14, category: 'Standard' },
      { row_label: 'F', seats: 14, category: 'Standard' },
    ],
  },
  {
    key: 'bkc',
    name: 'Jio World Garden, BKC',
    address: 'Bandra Kurla Complex, Mumbai 400051',
    layout: [
      // Deliberately the smallest tier at this venue: 12 seats can be sold out
      // inside the demo, which is what makes the queue behind it real rather
      // than merely described.
      { row_label: 'GC1', seats: 6, category: 'Golden Circle' },
      { row_label: 'GC2', seats: 6, category: 'Golden Circle' },
      { row_label: 'P1', seats: 14, category: 'Premium' },
      { row_label: 'P2', seats: 14, category: 'Premium' },
      { row_label: 'G1', seats: 18, category: 'General' },
      { row_label: 'G2', seats: 18, category: 'General' },
    ],
  },
  {
    key: 'opera',
    name: 'Royal Opera House — The Quarter',
    address: 'Mama Parmanand Marg, Girgaon, Mumbai 400004',
    layout: [
      { row_label: 'A', seats: 4, category: 'Premium' },
      { row_label: 'B', seats: 4, category: 'Premium' },
      { row_label: 'C', seats: 8, category: 'Standard' },
      { row_label: 'D', seats: 8, category: 'Standard' },
    ],
  },
];

/* --- Listings -------------------------------------------------------------
   Descriptions are written out rather than lorem-filled because they do real
   work: the event detail page gives them the space licensed artwork would
   occupy, and the browse search matches them alongside title and venue name.

   `pricing` is the event's default per-category map. A showing may override it —
   matinees are cheaper — which is the point of pricing belonging to the showing
   rather than to the event. */

const EVENTS = [
  {
    key: 'interstellar',
    title: 'Interstellar — 10th Anniversary IMAX',
    type: 'movie',
    organiser: 'organiser',
    venue: 'cineplex',
    description:
      'Nolan’s 2014 epic returns in a new 70mm IMAX transfer, with the Hans Zimmer score remixed for the format. 169 minutes, English with subtitles.',
    pricing: { Recliner: 650, Premium: 400, Standard: 250 },
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
    key: 'laapataa',
    title: 'Laapataa Ladies',
    type: 'movie',
    organiser: 'organiser',
    venue: 'cineplex',
    description:
      'Kiran Rao’s comedy-drama about two brides swapped on a train journey through rural India. Hindi, 124 minutes.',
    pricing: { Recliner: 550, Premium: 350, Standard: 200 },
    showings: [
      // Matinee rates, to show per-showing pricing rather than per-event pricing.
      { dayOffset: 3, time: '12:45', pricing: { Recliner: 400, Premium: 250, Standard: 150 } },
      { dayOffset: 5, time: '20:15' },
    ],
  },
  {
    key: 'kantara',
    title: 'Kantara: Chapter 1',
    type: 'movie',
    organiser: 'organiser',
    venue: 'cineplex',
    description:
      'The prequel to the 2022 folklore action film, shot in the Kundapura dialect and presented in Kannada with subtitles.',
    pricing: { Recliner: 700, Premium: 450, Standard: 280 },
    showings: [{ dayOffset: 7, time: '19:30' }],
  },
  {
    /**
     * A listing with no showing at all.
     *
     * Included because it is a state the organiser UI has to handle rather than
     * hide: it appears in the organiser's own list flagged "No showings yet" with
     * an inline Add showing action, and it is correctly absent from the public
     * browse, since an event nobody can book is a dead link to a customer.
     */
    key: 'dune',
    title: 'Dune: Part Three',
    type: 'movie',
    organiser: 'organiser',
    venue: 'cineplex',
    description:
      'Announced for 2027. Listing drafted ahead of the distributor confirming dates — no showings scheduled yet.',
    pricing: { Recliner: 750, Premium: 500, Standard: 300 },
    showings: [],
  },
  {
    key: 'arijit',
    title: 'Arijit Singh — Alvida World Tour',
    type: 'concert',
    organiser: 'promoter',
    venue: 'bkc',
    description:
      'Two nights at Jio World Garden with a 14-piece live band. Doors 18:00, no re-entry. Golden Circle is standing room at the front of stage.',
    pricing: { 'Golden Circle': 12500, Premium: 6500, General: 3200 },
    showings: [
      { dayOffset: 9, time: '19:00' },
      { dayOffset: 10, time: '19:00' },
    ],
  },
  {
    key: 'coldplay',
    title: 'Coldplay — Music of the Spheres',
    type: 'concert',
    organiser: 'promoter',
    venue: 'bkc',
    description:
      'The tour’s Mumbai date, with LED wristbands issued at the gate and a kinetic-floor section funding the show’s renewable power target.',
    pricing: { 'Golden Circle': 18000, Premium: 9500, General: 4500 },
    showings: [{ dayOffset: 21, time: '20:00' }],
  },
  {
    key: 'jazz',
    title: 'Sunday Jazz — Louiz Banks Trio',
    type: 'concert',
    organiser: 'promoter',
    venue: 'opera',
    description:
      'An intimate residency in the Opera House’s side room. Two sets with an interval, table service, 24 seats only.',
    pricing: { Premium: 2200, Standard: 1200 },
    showings: [
      { dayOffset: 6, time: '19:30' },
      { dayOffset: 13, time: '19:30' },
    ],
  },
];

module.exports = { USERS, VENUES, EVENTS };
