/**
 * Real-browser verification of the built SPA.
 *
 * Drives headless Chrome against the production bundle served by `vite preview`,
 * with the live backend on :3000.
 *
 * Navigation waits on `domcontentloaded` plus explicit content assertions, never
 * `networkidle2`: the seat map holds an open Socket.io connection by design, so the
 * network is never idle and a networkidle wait would always time out there.
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = process.env.APP_URL ?? 'http://localhost:4173';

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

const consoleErrors = [];
const failedRequests = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => {
  if (!r.url().includes('socket.io')) failedRequests.push(`${r.url()} ${r.failure()?.errorText}`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goto = (p) => page.goto(`${APP}${p}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
const bodyText = () => page.evaluate(() => document.body.innerText);

/**
 * Wait until the page's visible text contains `needle`, case-insensitively.
 *
 * Case matters here: several labels are uppercased with `text-transform`, and
 * innerText reports the *rendered* text, so "Seats sold" comes back "SEATS SOLD".
 */
async function waitForText(needle, timeout = 12000) {
  try {
    await page.waitForFunction(
      (n) => document.body.innerText.toLowerCase().includes(n.toLowerCase()),
      { timeout, polling: 200 },
      needle
    );
    return true;
  } catch {
    return false;
  }
}

/** Case-insensitive containment against the current body text. */
const has = (haystack, needle) => haystack.toLowerCase().includes(needle.toLowerCase());

async function signIn(email) {
  // Wipe the session on the app origin, then navigate to /login. Going to /login
  // while signed in is useless: the app correctly redirects away from it.
  await goto('/events');
  await page.evaluate(() => {
    localStorage.removeItem('tb-auth');
    localStorage.removeItem('tb-token');
  });
  await goto('/login');
  await page.waitForSelector('input[type="email"]', { timeout: 10000 });

  // Fill via the demo-account buttons: they call form.setValue() inside the app, so
  // react-hook-form's own state is updated. Writing to input.value only changes the
  // DOM, leaves RHF thinking the fields are empty, and validation then blocks submit.
  const filled = await page.evaluate((wanted) => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes(wanted)
    );
    if (!btn) return false;
    btn.click();
    return true;
  }, email);
  if (!filled) return false;

  await sleep(300);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.getAttribute('type') === 'submit'
    );
    btn?.click();
  });

  return page
    .waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
}

/**
 * Discover a bookable fixture instead of hard-coding ids.
 *
 * This used to navigate to `/events/1` and `/shows/1` and assert exactly 46 seats,
 * which pinned the script to one particular seeded venue. `npm run demo` now builds a
 * scenario whose show 1 is deliberately a *past* showing — it exists to give the
 * organiser's revenue a history — so the old anchor pointed at a screen this script has
 * no business booking on. Asking the API which showing is upcoming and has seats free
 * lets the walkthrough follow the data rather than dictate it.
 */
const API = process.env.API_URL ?? 'http://localhost:3000';
const fixture = await (async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { events } = await fetch(`${API}/api/events`).then((r) => r.json());
  for (const summary of events) {
    const { event } = await fetch(`${API}/api/events/${summary.id}`).then((r) => r.json());
    // Four seats free: the script books two and needs headroom to be re-runnable.
    const show = (event.shows ?? []).find((s) => s.date >= today && s.available_seats >= 4);
    if (show) {
      return {
        eventId: event.id,
        eventTitle: event.title,
        showId: show.id,
        totalSeats: show.total_seats,
      };
    }
  }
  throw new Error('No upcoming showing with free seats — run `cd backend && npm run demo`');
})();
console.log(
  `fixture: event ${fixture.eventId} "${fixture.eventTitle}", show ${fixture.showId} (${fixture.totalSeats} seats)\n`
);

console.log(`=== Browser verification against ${APP} ===\n`);

/* --- Public -------------------------------------------------------------- */
console.log('public (anonymous)');
await goto('/events');
// Matched with a tolerant apostrophe class: the heading uses a typographic
// apostrophe (U+2019), not the ASCII one.
check(
  '/events renders',
  await page
    // Case-insensitive: the heading renders uppercased via CSS, and innerText
    // reports the rendered text. Tolerant apostrophe class covers the typographic ’.
    .waitForFunction(() => /what[\u2019']s on/i.test(document.body.innerText), { timeout: 12000 })
    .then(() => true)
    .catch(() => false)
);
check('  lists seeded events', await waitForText(fixture.eventTitle));
let body = await bodyText();
// The filter bar is a pill group plus two dates, not labelled form fields, so assert
// the controls themselves rather than their old visible label text. Search is no
// longer among them — it moved to the header — so it is checked separately below, and
// the page is asserted to have exactly one search field, in the bar.
const filterControls = await page.evaluate(() => {
  const navSearch = document.querySelector('header input#nav-search');
  const pills = document.querySelector('[role="group"][aria-label="Filter by type"]');
  const pillLabels = pills
    ? [...pills.querySelectorAll('button')].map((b) => b.textContent?.trim())
    : [];
  const dates = document.querySelectorAll('input#filter-from, input#filter-to').length;
  return {
    navSearch: Boolean(navSearch),
    navSearchType: navSearch?.getAttribute('type') ?? null,
    searchInputCount: document.querySelectorAll('input[type="search"]').length,
    pillCount: pillLabels.length,
    pillLabels,
    dates,
  };
});
check(
  '  filter controls present',
  filterControls.pillCount === 3 && filterControls.dates === 2,
  JSON.stringify(filterControls)
);
check(
  '  search lives in the header, and only there',
  filterControls.navSearch &&
    filterControls.navSearchType === 'search' &&
    filterControls.searchInputCount === 1,
  JSON.stringify(filterControls)
);

// Global search. Type into the header field and prove the URL and the grid follow.
await page.type('header input#nav-search', 'interstellar');
await new Promise((r) => setTimeout(r, 900)); // 300ms request debounce plus the fetch
const searched = await page.evaluate(() => ({
  q: new URL(location.href).searchParams.get('q'),
  body: document.body.innerText,
}));
check('  header search writes ?q=', searched.q === 'interstellar', String(searched.q));
check(
  '  search filters the grid',
  /Interstellar/i.test(searched.body) && !/Coldplay/i.test(searched.body),
  searched.body.slice(0, 200).replace(/\s+/g, ' ')
);

// The term is echoed on the page, so a filtered list is never unexplained while the
// only evidence sits in the header. Queried by its accessible name rather than
// asserted against body text: the chip renders the bare term, which also appears in
// the header field, so innerText alone would not prove the chip exists.
const termChip = await page.evaluate(
  () => document.querySelector('[aria-label="Clear search: interstellar"]')?.textContent?.trim() ?? null
);
check('  active term shown as a chip', termChip === 'interstellar', String(termChip));

// Venue match. No event title contains "Opera" — only the Royal Opera House's name
// does — so results here prove the search reaches past events.title.
await goto('/events?q=Opera');
check('  search matches venue names', await waitForText('Arijit Singh'));

// Description match. "wristbands" appears only in one event's description.
await goto('/events?q=wristbands');
const byDescription = await page.evaluate(() => document.body.innerText);
check(
  '  search matches descriptions',
  /Coldplay/i.test(byDescription) && !/Interstellar/i.test(byDescription),
  byDescription.slice(0, 160).replace(/\s+/g, ' ')
);

// A shared ?q= link survives a cold load: the field is URL-driven, not local state.
const restored = await page.evaluate(
  () => document.querySelector('header input#nav-search')?.value ?? null
);
check('  header field rehydrates from the URL', restored === 'wristbands', String(restored));

// Clearing restores the full list.
await goto('/events');
check('  cleared search restores all events', await waitForText('Coldplay'));

// The hero CTA is "Get tickets" in the brutalist redesign (was "Book now").
check('  hero spotlights an event', await waitForText('Get tickets'));

await goto(`/events/${fixture.eventId}`);
// The showtime picker's heading is "Select showtime" since the redesign (it was
// "Choose a showing"). Same assertion, current copy: prove the picker rendered.
check('/events/:id renders detail', await waitForText('Select showtime'));
body = await bodyText();
check('  price tier shown', has(body, 'Premium') || has(body, 'Standard'));

await goto(`/shows/${fixture.showId}`);
await page.waitForSelector('[data-seat-id]', { timeout: 12000 }).catch(() => {});
const seatCount = await page.evaluate(() => document.querySelectorAll('[data-seat-id]').length);
check('/shows/:id renders the seat grid', seatCount === fixture.totalSeats, `${seatCount} seats`);
check('  socket reports Live', await waitForText('Live'));
body = await bodyText();
check('  anonymous sees sign-in CTA', has(body, 'Sign in to book'));
check('  legend rendered', has(body, 'Available') && has(body, 'Booked'));

/* --- Customer ------------------------------------------------------------ */
console.log('\ncustomer');
check('login redirects customer to /events', await signIn('customer1@tixlock.com'), page.url());

await goto(`/shows/${fixture.showId}`);
await page.waitForSelector('[data-seat-id]:not([disabled])', { timeout: 12000 });
await page.evaluate(() => {
  [...document.querySelectorAll('[data-seat-id]:not([disabled])')].slice(0, 2).forEach((s) => s.click());
});
check('selecting seats updates checkout', await waitForText('Hold 2 seats'));

await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /Hold \d+ seat/i.test(x.textContent));
  b?.click();
});
check('hold starts the countdown', await waitForText('Seats held for you'));
const countdown = await page.evaluate(() => (document.body.innerText.match(/\b(\d{1,2}:\d{2})\b/) ?? [])[1]);
check('  countdown shows server-derived time', Boolean(countdown) && countdown !== '0:00', String(countdown));
check('  confirm button appears', has(await bodyText(), 'Confirm booking'));

await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /Confirm booking/i.test(x.textContent));
  b?.click();
});
check('booking confirms', await waitForText('Booking confirmed'));
body = await bodyText();
const ref = (body.match(/TB-[A-Z2-9]{8}/) ?? [])[0];
check('  booking reference rendered', Boolean(ref), String(ref));
check(
  '  QR image rendered',
  await page.evaluate(() => !!document.querySelector('img[src^="data:image/png;base64,"]'))
);

await goto('/bookings');
check('/bookings lists the booking', await waitForText(ref ?? 'TB-'), String(ref));
check('  waitlist tab present', has(await bodyText(), 'Waitlist'));

/* --- Organiser ----------------------------------------------------------- */
console.log('\norganiser');
check('login redirects organiser to /organiser', await signIn('organiser@tixlock.com'), page.url());
check('dashboard renders stats', await waitForText('Seats sold'));
check('  events table rendered', await waitForText('Dune: Part Three'));
const charts = await page.evaluate(() => document.querySelectorAll('svg.recharts-surface').length);
check('  recharts rendered', charts >= 1, `${charts} surfaces`);

await goto(`/organiser/events/${fixture.eventId}`);
check('per-event report renders', await waitForText('Showings'));
body = await bodyText();
check('  categories + attendees tabs', has(body, 'Categories') && has(body, 'Attendees'));

/* --- Admin --------------------------------------------------------------- */
console.log('\nadmin');
check('login redirects admin to /admin', await signIn('admin@tixlock.com'), page.url());
check('venues page renders', await waitForText('Existing venues'));
body = await bodyText();
check('  layout editor rendered', has(body, 'Screen / Stage') && has(body, 'Categories'));
check('  presets offered', has(body, 'Small cinema'));
const editorSeats = await page.evaluate(
  () => document.querySelectorAll('button[aria-label^="Seat "]').length
);
check('  editor grid draws seats', editorSeats > 0, `${editorSeats} buttons`);
check('  seeded venue listed', has(body, 'PVR Icon'));

/* --- Role guard ---------------------------------------------------------- */
console.log('\nrole guards');
await goto('/bookings');
check(
  'admin on /bookings is refused client-side',
  await waitForText('not available for your account')
);

/* --- Responsive ---------------------------------------------------------- */
console.log('\nresponsive');
await page.setViewport({ width: 390, height: 844, isMobile: true });
await goto(`/shows/${fixture.showId}`);
await page.waitForSelector('[data-seat-id]', { timeout: 12000 }).catch(() => {});
const mobile = await page.evaluate(() => {
  const scroller = document.querySelector('.overflow-x-auto');
  const seat = document.querySelector('[data-seat-id]');
  return {
    hasScroller: Boolean(scroller),
    overflowX: scroller ? getComputedStyle(scroller).overflowX : null,
    seatWidth: seat ? seat.getBoundingClientRect().width : 0,
    pageOverflows: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
});
check('seat map has a horizontal scroll container', mobile.hasScroller && mobile.overflowX === 'auto', JSON.stringify(mobile));
check('  seats keep a usable tap size (>=26px)', mobile.seatWidth >= 26, `${mobile.seatWidth}px`);
check('  page does not overflow horizontally', !mobile.pageOverflows);

/* --- Theme --------------------------------------------------------------- */
await page.setViewport({ width: 1280, height: 900 });
await goto('/events');
await waitForText("What's on");
const themes = await page.evaluate(async () => {
  const before = document.documentElement.classList.contains('dark');
  const btn = [...document.querySelectorAll('button')].find((b) =>
    (b.getAttribute('aria-label') ?? '').includes('mode')
  );
  btn?.click();
  await new Promise((r) => setTimeout(r, 350));
  return { before, after: document.documentElement.classList.contains('dark') };
});
check('theme toggle flips the dark class', themes.before !== themes.after, JSON.stringify(themes));

/* --- Hygiene ------------------------------------------------------------- */
console.log('\nconsole hygiene');
const realErrors = consoleErrors.filter(
  (e) => !/DevTools|future flag|Download the React|source ?map/i.test(e)
);
check('no uncaught console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
check('no failed network requests', failedRequests.length === 0, failedRequests.slice(0, 2).join(' | '));

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
console.log('BROWSER VERIFICATION PASSED');
