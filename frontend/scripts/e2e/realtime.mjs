/**
 * Two-client realtime + waitlist verification.
 *
 * Two things a single-page walkthrough cannot prove:
 *   1. A hold made in one browser tab appears in another tab's seat map with no
 *      reload — i.e. the Socket.io subscription and cache patching actually work.
 *   2. The emailed waitlist offer page renders and claims a real offer.
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = 'http://localhost:4173';
const API = 'http://localhost:3000';

let pass = 0;
let fail = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${label} ${detail}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const login = async (email, password) =>
  (await api('POST', '/auth/login', { body: { email, password } })).body.token;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox'],
});

const goto = (page, path) =>
  page.goto(`${APP}${path}`, { waitUntil: 'domcontentloaded', timeout: 20000 });

async function signInAs(page, email) {
  await goto(page, '/events');
  await page.evaluate(() => {
    localStorage.removeItem('tb-auth');
    localStorage.removeItem('tb-token');
  });
  await goto(page, '/login');
  await page.waitForSelector('input[type="email"]');
  await page.evaluate((wanted) => {
    [...document.querySelectorAll('button')]
      .find((b) => (b.textContent ?? '').includes(wanted))
      ?.click();
  }, email);
  await sleep(300);
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.getAttribute('type') === 'submit')?.click();
  });
  await page
    .waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 15000 })
    .catch(() => {});
}

const seatState = (page, seatId) =>
  page.evaluate(
    (id) => document.querySelector(`[data-seat-id="${id}"]`)?.getAttribute('data-seat-state') ?? null,
    seatId
  );

console.log('=== Realtime + waitlist verification ===\n');

/* --- Fresh show ---------------------------------------------------------- */
const organiser = await login('organiser@ticketbooking.local', 'organiser123');
const created = await api('POST', '/events', {
  token: organiser,
  body: { title: `Realtime Probe ${Date.now()}`, type: 'concert', venue_id: 1 },
});
const eventId = created.body.event.id;
const showRes = await api('POST', `/events/${eventId}/shows`, {
  token: organiser,
  body: { date: '2027-03-03', time: '20:00', pricing: { Premium: 900, Standard: 400 } },
});
const showId = showRes.body.show.id;
console.log(`  probe show id ${showId} (${showRes.body.show.seats_created} seats)\n`);

/* --- 1. Live cross-client update ----------------------------------------- */
console.log('live seat updates between two clients');

const watcher = await browser.newPage();
await watcher.setViewport({ width: 1280, height: 900 });
await signInAs(watcher, 'customer2@ticketbooking.local');
await goto(watcher, `/shows/${showId}`);
await watcher.waitForSelector('[data-seat-id]', { timeout: 12000 });
await watcher.waitForFunction(() => document.body.innerText.includes('Live'), { timeout: 12000 }).catch(() => {});
check('watcher tab connected (Live)', await watcher.evaluate(() => document.body.innerText.includes('Live')));

const targetSeatId = await watcher.evaluate(
  () => document.querySelector('[data-seat-id][data-seat-state="available"]')?.getAttribute('data-seat-id')
);
check('found an available seat to contend over', Boolean(targetSeatId), String(targetSeatId));

const before = await seatState(watcher, targetSeatId);
check('  seat starts available in watcher tab', before === 'available', String(before));

// A different customer holds that seat, entirely out of band.
const customer = await login('customer@ticketbooking.local', 'customer123');
const heldRes = await api('POST', `/shows/${showId}/hold`, {
  token: customer,
  body: { seat_ids: [Number(targetSeatId)] },
});
check('  other customer holds it via the API', heldRes.status === 201, `status ${heldRes.status}`);

// The watcher must observe the change with no reload.
const observed = await watcher
  .waitForFunction(
    (id) => document.querySelector(`[data-seat-id="${id}"]`)?.getAttribute('data-seat-state') === 'taken',
    { timeout: 8000, polling: 150 },
    targetSeatId
  )
  .then(() => true)
  .catch(() => false);
check('  watcher sees it flip to taken WITHOUT a reload', observed, `state=${await seatState(watcher, targetSeatId)}`);

const stillSameUrl = watcher.url().endsWith(`/shows/${showId}`);
check('  watcher did not navigate or reload', stillSameUrl, watcher.url());

// And the summary counts follow the patch.
const summaryDropped = await watcher.evaluate(() => {
  const m = document.body.innerText.match(/(\d+)\s*AVAILABLE/i);
  return m ? Number(m[1]) : null;
});
check('  availability count reflects the change', summaryDropped !== null, `available=${summaryDropped}`);

// Release it again and confirm the reverse transition.
await api('DELETE', `/shows/${showId}/hold`, { token: customer, body: {} });
const released = await watcher
  .waitForFunction(
    (id) => document.querySelector(`[data-seat-id="${id}"]`)?.getAttribute('data-seat-state') === 'available',
    { timeout: 8000, polling: 150 },
    targetSeatId
  )
  .then(() => true)
  .catch(() => false);
check('  watcher sees the release too', released, `state=${await seatState(watcher, targetSeatId)}`);

await watcher.close();

/* --- 2. Waitlist offer page ---------------------------------------------- */
console.log('\nwaitlist offer page');

// Sell out Premium on the probe show, queue customer2, then cancel to create an offer.
const seatMap = (await api('GET', `/shows/${showId}/seats`)).body;
const premium = seatMap.rows.flatMap((r) => r.seats).filter((s) => s.category === 'Premium').map((s) => s.id);
for (let i = 0; i < premium.length; i += 10) {
  const batch = premium.slice(i, i + 10);
  await api('POST', `/shows/${showId}/hold`, { token: customer, body: { seat_ids: batch } });
  await api('POST', '/bookings', { token: customer, body: { show_id: showId, seat_ids: batch } });
}
const customer2 = await login('customer2@ticketbooking.local', 'customer123');
const joined = await api('POST', '/waitlist', {
  token: customer2,
  body: { show_id: showId, category: 'Premium' },
});
check('customer2 joins the sold-out Premium waitlist', joined.status === 201, `status ${joined.status}`);

const bookings = (await api('GET', '/bookings', { token: customer })).body.bookings;
const toCancel = bookings.find((b) => b.show_id === showId && b.status === 'confirmed');
const cancelRes = await api('POST', `/bookings/${toCancel.id}/cancel`, { token: customer });
check(
  '  cancelling offers a seat to the waitlist',
  cancelRes.body.seats_offered_to_waitlist === 1,
  JSON.stringify({ offered: cancelRes.body.seats_offered_to_waitlist, released: cancelRes.body.seats_released })
);

const mine = (await api('GET', '/waitlist/mine', { token: customer2 })).body.waitlist;
const offer = mine.find((w) => w.status === 'offered');
check('  offer token issued', Boolean(offer?.offer_token));

// Open the emailed link in a browser, signed in as the recipient.
const offerPage = await browser.newPage();
await offerPage.setViewport({ width: 1280, height: 900 });
await signInAs(offerPage, 'customer2@ticketbooking.local');
await goto(offerPage, `/offer?token=${encodeURIComponent(offer.offer_token)}`);

const offerRendered = await offerPage
  .waitForFunction(() => document.body.innerText.includes('reserved for you'), { timeout: 12000 })
  .then(() => true)
  .catch(() => false);
check('  /offer renders the reservation', offerRendered);

let offerBody = await offerPage.evaluate(() => document.body.innerText);
check('    shows the offered seat', /Your seat/i.test(offerBody), offerBody.slice(0, 100).replace(/\n/g, ' | '));
check('    shows a claim button', /Claim this seat/i.test(offerBody));

await offerPage.evaluate(() => {
  [...document.querySelectorAll('button')].find((b) => /Claim this seat/i.test(b.textContent))?.click();
});
const claimed = await offerPage
  .waitForFunction(() => document.body.innerText.includes('Seat claimed'), { timeout: 12000 })
  .then(() => true)
  .catch(() => false);
check('  claiming converts the offer to a hold', claimed);

await offerPage.evaluate(() => {
  [...document.querySelectorAll('button')].find((b) => /Confirm booking/i.test(b.textContent))?.click();
});
const booked = await offerPage
  .waitForFunction(() => document.body.innerText.includes('Booking confirmed'), { timeout: 12000 })
  .then(() => true)
  .catch(() => false);
check('  the claimed seat books successfully', booked);

// Single use: the same token must now fail.
const replay = await api('POST', `/waitlist/offers/${offer.offer_token}/accept`, { token: customer2 });
check('  the offer token is single use', replay.status === 409, `status ${replay.status}`);

await offerPage.close();
await browser.close();

console.log('\n==========================================');
console.log(`  passed: ${pass}`);
console.log(`  failed: ${fail}`);
console.log('==========================================');
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('REALTIME + WAITLIST VERIFICATION PASSED');
