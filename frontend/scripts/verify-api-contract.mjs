/**
 * Contract verification for the API client.
 *
 * Exercises every path/method pair declared in src/lib/api/endpoints.ts against a
 * running backend and asserts the response shape matches src/lib/api/types.ts.
 *
 * The point is to catch the failure mode a typechecker cannot see: a wrong URL or
 * verb typechecks perfectly and only fails at runtime. This walks the full surface
 * in one pass.
 *
 * Usage:  node scripts/verify-api-contract.mjs [API_URL]
 * Needs:  a running backend with seeded demo data.
 */

const BASE = (process.argv[2] ?? process.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ok    ${label}`);
  } else {
    fail += 1;
    failures.push(`${label} ${detail}`);
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON response */
    }
  }
  return { status: res.status, body: json, raw: text };
}

const login = async (email, password) => {
  const res = await call('POST', '/auth/login', { body: { email, password } });
  return res.body?.token ?? null;
};

/** Assert a value is a money field as the client models it: string | number. */
const isMoney = (v) => typeof v === 'string' || typeof v === 'number';
const isApiDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isApiTime = (v) => typeof v === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(v);

console.log(`=== API client contract verification against ${BASE} ===\n`);

/* --- Auth ---------------------------------------------------------------- */
console.log('authApi');
const health = await call('GET', '/health');
check('systemApi.health  GET /health', health.status === 200 && health.body?.status === 'ok');

const customer = await login('customer@ticketbooking.local', 'customer123');
const customer2 = await login('customer2@ticketbooking.local', 'customer123');
const organiser = await login('organiser@ticketbooking.local', 'organiser123');
const admin = await login('admin@ticketbooking.local', 'admin12345');

check('authApi.login     POST /auth/login', Boolean(customer && organiser && admin));

const me = await call('GET', '/auth/me', { token: customer });
check(
  'authApi.me        GET /auth/me',
  me.status === 200 && me.body?.user?.role === 'customer',
  me.status !== 200 ? `status ${me.status}` : ''
);

const stamp = Date.now();
const registered = await call('POST', '/auth/register', {
  body: { name: 'Contract Probe', email: `probe${stamp}@test.local`, password: 'probe12345' },
});
check(
  'authApi.register  POST /auth/register',
  registered.status === 201 && typeof registered.body?.token === 'string'
);

/* --- Venues -------------------------------------------------------------- */
console.log('\nvenuesApi');
const venues = await call('GET', '/venues', { token: admin });
check(
  'venuesApi.list    GET /venues',
  venues.status === 200 && Array.isArray(venues.body?.venues)
);
const venueId = venues.body?.venues?.[0]?.id;
check(
  '  shape: seat_count / category_count / event_count',
  typeof venues.body?.venues?.[0]?.seat_count === 'number' &&
    typeof venues.body?.venues?.[0]?.category_count === 'number' &&
    typeof venues.body?.venues?.[0]?.event_count === 'number'
);

const venueDetail = await call('GET', `/venues/${venueId}`, { token: admin });
check(
  'venuesApi.get     GET /venues/:id',
  venueDetail.status === 200 && Array.isArray(venueDetail.body?.venue?.rows)
);
check(
  '  shape: categories[] / locked / show_count',
  Array.isArray(venueDetail.body?.venue?.categories) &&
    typeof venueDetail.body?.venue?.locked === 'boolean' &&
    typeof venueDetail.body?.venue?.show_count === 'number'
);

/**
 * Pricing for the probe show, derived from the chosen venue's actual seat categories.
 *
 * Must not be hardcoded. The backend rejects a show whose pricing omits any category
 * the venue defines, and `venueId` above is simply whatever /venues returns first.
 * Against a long-lived database that is not necessarily the seeded auditorium with
 * Premium/Standard — this script creates a probe venue on every run, and those
 * accumulate and can sort ahead of it. Hardcoding category names made the check fail
 * for a reason that had nothing to do with the endpoint under test.
 */
const venueCategories = venueDetail.body?.venue?.categories ?? [];
const probePricing = Object.fromEntries(
  venueCategories.map((category, index) => [category, 200 + index * 150])
);
check(
  '  derived pricing covers every venue category',
  venueCategories.length > 0 &&
    Object.keys(probePricing).length === venueCategories.length,
  `categories=${JSON.stringify(venueCategories)}`
);

const createdVenue = await call('POST', '/venues', {
  token: admin,
  body: {
    name: `Contract Venue ${stamp}`,
    address: 'probe',
    layout: [{ row_label: 'A', seats: 4, category: 'Probe' }],
  },
});
check(
  'venuesApi.create  POST /venues',
  createdVenue.status === 201 && createdVenue.body?.venue?.seat_count === 4
);
const probeVenueId = createdVenue.body?.venue?.id;

const patched = await call('PATCH', `/venues/${probeVenueId}`, {
  token: admin,
  body: { name: `Contract Venue ${stamp} (renamed)` },
});
check('venuesApi.update  PATCH /venues/:id', patched.status === 200);

const relayout = await call('PUT', `/venues/${probeVenueId}/layout`, {
  token: admin,
  body: { layout: [{ row_label: 'A', seats: 6, category: 'Probe' }] },
});
check(
  'venuesApi.defineLayout PUT /venues/:id/layout',
  relayout.status === 200 && relayout.body?.seats_created === 6,
  relayout.status !== 200 ? `status ${relayout.status}` : ''
);

/* --- Events -------------------------------------------------------------- */
console.log('\neventsApi');
const events = await call('GET', '/events');
check('eventsApi.list    GET /events', events.status === 200 && Array.isArray(events.body?.events));
const firstEvent = events.body?.events?.[0];
check(
  '  shape: from_price is string|number|null, next_show_date is YYYY-MM-DD|null',
  (firstEvent?.from_price === null || isMoney(firstEvent?.from_price)) &&
    (firstEvent?.next_show_date === null || isApiDate(firstEvent?.next_show_date))
);

const filtered = await call('GET', '/events?type=movie&upcoming=true');
check('eventsApi.list    GET /events?filters', filtered.status === 200);

const mine = await call('GET', '/events/mine', { token: organiser });
check('eventsApi.mine    GET /events/mine', mine.status === 200 && Array.isArray(mine.body?.events));

const eventId = firstEvent?.id;
const eventDetail = await call('GET', `/events/${eventId}`);
check(
  'eventsApi.get     GET /events/:id',
  eventDetail.status === 200 && Array.isArray(eventDetail.body?.event?.shows)
);
const firstShow = eventDetail.body?.event?.shows?.[0];
check(
  '  shape: show.date/time formats + pricing[]',
  isApiDate(firstShow?.date) && isApiTime(firstShow?.time) && Array.isArray(firstShow?.pricing)
);

const createdEvent = await call('POST', '/events', {
  token: organiser,
  body: { title: `Contract Event ${stamp}`, type: 'movie', venue_id: venueId },
});
check('eventsApi.create  POST /events', createdEvent.status === 201);
const probeEventId = createdEvent.body?.event?.id;

const createdShow = await call('POST', `/events/${probeEventId}/shows`, {
  token: organiser,
  body: { date: '2027-06-01', time: '19:00', pricing: probePricing },
});
check(
  'eventsApi.createShow POST /events/:id/shows',
  createdShow.status === 201 && typeof createdShow.body?.show?.seats_created === 'number',
  `status=${createdShow.status} body=${createdShow.raw?.slice(0, 200)}`
);
const probeShowId = createdShow.body?.show?.id;

const deletedShow = await call('DELETE', `/events/${probeEventId}/shows/${probeShowId}`, {
  token: organiser,
});
check(
  'eventsApi.deleteShow DELETE /events/:e/shows/:s',
  deletedShow.status === 204,
  `status=${deletedShow.status} showId=${probeShowId} body=${deletedShow.raw?.slice(0, 200)}`
);

/* --- Shows and seat map -------------------------------------------------- */
console.log('\nshowsApi');
const showId = firstShow?.id;
const show = await call('GET', `/shows/${showId}`);
check(
  'showsApi.get      GET /shows/:id',
  show.status === 200 && Array.isArray(show.body?.pricing)
);

const seatMap = await call('GET', `/shows/${showId}/seats`, { token: customer });
check(
  'showsApi.seatMap  GET /shows/:id/seats',
  seatMap.status === 200 && Array.isArray(seatMap.body?.rows)
);
const seat = seatMap.body?.rows?.[0]?.seats?.[0];
check(
  '  shape: seat fields + server_time',
  typeof seat?.id === 'number' &&
    typeof seat?.status === 'string' &&
    typeof seat?.held_by_me === 'boolean' &&
    (seat?.price === null || isMoney(seat?.price)) &&
    typeof seatMap.body?.server_time === 'string'
);
check(
  '  summary has all five keys the client sums',
  ['total', 'available', 'held', 'booked', 'offered'].every(
    (k) => typeof seatMap.body?.summary?.[k] === 'number'
  )
);
check(
  '  anonymous seat map never leaks held_by',
  !JSON.stringify((await call('GET', `/shows/${showId}/seats`)).body ?? {}).includes('"held_by"')
);

const availability = await call('GET', `/shows/${showId}/availability`);
check(
  'showsApi.availability GET /shows/:id/availability',
  availability.status === 200 &&
    typeof availability.body?.categories?.[0]?.sold_out === 'boolean'
);

/* --- Holds --------------------------------------------------------------- */
console.log('\nshowsApi (holds)');
const freeSeats = (seatMap.body?.rows ?? [])
  .flatMap((r) => r.seats)
  .filter((s) => s.status === 'available')
  .slice(0, 2)
  .map((s) => s.id);

const held = await call('POST', `/shows/${showId}/hold`, {
  token: customer,
  body: { seat_ids: freeSeats },
});
check(
  'showsApi.hold     POST /shows/:id/hold',
  held.status === 201 && typeof held.body?.hold_expires_at === 'string',
  held.status !== 201 ? `status ${held.status}` : ''
);
check(
  '  shape: hold_ttl_minutes + seats[]',
  typeof held.body?.hold_ttl_minutes === 'number' && Array.isArray(held.body?.seats)
);

const conflict = await call('POST', `/shows/${showId}/hold`, {
  token: customer2,
  body: { seat_ids: freeSeats },
});
check(
  '  409 SEATS_UNAVAILABLE with unavailableSeatIds[]',
  conflict.status === 409 &&
    conflict.body?.error?.code === 'SEATS_UNAVAILABLE' &&
    Array.isArray(conflict.body?.error?.details?.unavailableSeatIds)
);

const myHolds = await call('GET', `/shows/${showId}/my-holds`, { token: customer });
check(
  'showsApi.myHolds  GET /shows/:id/my-holds',
  myHolds.status === 200 &&
    typeof myHolds.body?.server_time === 'string' &&
    Array.isArray(myHolds.body?.seats)
);

/* --- Bookings ------------------------------------------------------------ */
console.log('\nbookingsApi');
const booking = await call('POST', '/bookings', {
  token: customer,
  body: { show_id: showId, seat_ids: freeSeats },
});
check(
  'bookingsApi.create POST /bookings',
  booking.status === 201 && typeof booking.body?.booking?.booking_ref === 'string',
  booking.status !== 201 ? `status ${booking.status}` : ''
);
check(
  '  shape: qr_data_url is a PNG data URL',
  typeof booking.body?.qr_data_url === 'string' &&
    booking.body.qr_data_url.startsWith('data:image/png;base64,')
);
check(
  '  POST /bookings seats[].price is a STRING (client must normalise)',
  typeof booking.body?.booking?.seats?.[0]?.price === 'string'
);
const bookingId = booking.body?.booking?.id;
const bookingRef = booking.body?.booking?.booking_ref;

const history = await call('GET', '/bookings', { token: customer });
check(
  'bookingsApi.list  GET /bookings',
  history.status === 200 && Array.isArray(history.body?.bookings)
);
const historyItem = history.body?.bookings?.find((b) => b.id === bookingId);
check(
  '  GET /bookings seats[].price is a NUMBER (the documented inconsistency)',
  typeof historyItem?.seats?.[0]?.price === 'number',
  `got ${typeof historyItem?.seats?.[0]?.price}`
);
check('  total_amount stays a string', typeof historyItem?.total_amount === 'string');
check(
  '  shape: event_id/event_title/venue_name hoisted to top level',
  typeof historyItem?.event_id === 'number' && typeof historyItem?.event_title === 'string'
);

const byId = await call('GET', `/bookings/${bookingId}`, { token: customer });
check('bookingsApi.get   GET /bookings/:id', byId.status === 200);

const byRef = await call('GET', `/bookings/ref/${bookingRef}`, { token: customer });
check('bookingsApi.getByRef GET /bookings/ref/:ref', byRef.status === 200);

const qr = await call('GET', `/bookings/${bookingId}/qr`, { token: customer });
check(
  'bookingsApi.qr    GET /bookings/:id/qr',
  qr.status === 200 && typeof qr.body?.qr_data_url === 'string'
);

/* --- Waitlist ------------------------------------------------------------ */
console.log('\nwaitlistApi');
const waitlistMine = await call('GET', '/waitlist/mine', { token: customer2 });
check(
  'waitlistApi.mine  GET /waitlist/mine',
  waitlistMine.status === 200 && Array.isArray(waitlistMine.body?.waitlist)
);

const notSoldOut = await call('POST', '/waitlist', {
  token: customer2,
  body: { show_id: showId, category: availability.body?.categories?.[0]?.category ?? 'Premium' },
});
check(
  'waitlistApi.join  POST /waitlist (409 while seats remain)',
  notSoldOut.status === 409 || notSoldOut.status === 201,
  `status ${notSoldOut.status}`
);

const badOffer = await call('GET', '/waitlist/offers/deadbeefdeadbeef');
check(
  'waitlistApi.getOffer GET /waitlist/offers/:token (404 for bogus)',
  badOffer.status === 404
);

const badAccept = await call('POST', '/waitlist/offers/deadbeefdeadbeef/accept', {
  token: customer2,
});
check(
  'waitlistApi.acceptOffer POST /waitlist/offers/:token/accept (409 for bogus)',
  badAccept.status === 409
);

/* --- Cancel (after waitlist reads, since it mutates seat state) ---------- */
const cancelled = await call('POST', `/bookings/${bookingId}/cancel`, { token: customer });
check(
  'bookingsApi.cancel POST /bookings/:id/cancel',
  cancelled.status === 200 &&
    typeof cancelled.body?.seats_released === 'number' &&
    typeof cancelled.body?.seats_offered_to_waitlist === 'number'
);

const release = await call('DELETE', `/shows/${showId}/hold`, { token: customer, body: {} });
check(
  'showsApi.releaseHold DELETE /shows/:id/hold',
  release.status === 200 && typeof release.body?.released === 'number'
);

/* --- Dashboard ----------------------------------------------------------- */
console.log('\ndashboardApi');
const summary = await call('GET', '/dashboard/summary', { token: organiser });
check(
  'dashboardApi.summary GET /dashboard/summary',
  summary.status === 200 && Array.isArray(summary.body?.events)
);
check(
  '  totals.revenue is a money string',
  isMoney(summary.body?.totals?.revenue) && typeof summary.body?.totals?.seats_sold === 'number'
);

const report = await call('GET', `/dashboard/events/${eventId}`, { token: organiser });
check(
  'dashboardApi.eventReport GET /dashboard/events/:id',
  report.status === 200 &&
    Array.isArray(report.body?.shows) &&
    Array.isArray(report.body?.categories) &&
    Array.isArray(report.body?.waitlist)
);
check(
  '  occupancy_pct is a NUMERIC string (client uses toPercent)',
  isMoney(report.body?.shows?.[0]?.occupancy_pct)
);

const attendees = await call('GET', `/dashboard/events/${eventId}/bookings?limit=5`, {
  token: organiser,
});
check(
  'dashboardApi.eventBookings GET /dashboard/events/:id/bookings',
  attendees.status === 200 && Array.isArray(attendees.body?.bookings)
);

/* --- Role guards --------------------------------------------------------- */
console.log('\nrole enforcement the client relies on');
check(
  'customer -> /dashboard/summary is 403',
  (await call('GET', '/dashboard/summary', { token: customer })).status === 403
);
check(
  'customer -> POST /venues is 403',
  (await call('POST', '/venues', { token: customer, body: { name: 'x' } })).status === 403
);
check(
  'organiser -> POST /shows/:id/hold is 403 (customer-only)',
  (await call('POST', `/shows/${showId}/hold`, { token: organiser, body: { seat_ids: [1] } }))
    .status === 403
);
check('anonymous -> /bookings is 401', (await call('GET', '/bookings')).status === 401);

/* --- Summary ------------------------------------------------------------- */
console.log('\n==========================================');
console.log(`  passed: ${pass}`);
console.log(`  failed: ${fail}`);
console.log('==========================================');
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('API CLIENT CONTRACT VERIFIED');
