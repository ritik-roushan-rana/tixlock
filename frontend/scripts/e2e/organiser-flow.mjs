/**
 * The organiser event-management flow, driven in a real browser.
 *
 * Walks the scenario an organiser actually performs: create a listing in one action,
 * find it by search, manage it, add a second showing to the same event, and confirm a
 * customer can then reach a seat map through it. Also covers the states that used to be
 * dead ends — an event with no showings, a venue with no layout, a missing price.
 *
 * Usage: backend on :3000, `npm run build && npx vite preview --port 4173`, then
 *   node scripts/e2e/organiser-flow.mjs
 */
import puppeteer from 'puppeteer-core';

const APP = process.env.APP_URL ?? 'http://localhost:4173';
const API = process.env.API_URL ?? 'http://localhost:3000';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let pass = 0;
let fail = 0;
const check = (name, ok, note = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`);
  ok ? pass++ : fail++;
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const login = async (email, password) => {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).then((x) => x.json());
  if (!r.token) throw new Error(`${email} login failed`);
  return r;
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });

async function signedInPage(session, width = 1440) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900 });
  await page.goto(`${APP}/events`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => {
    localStorage.setItem(
      'tb-auth',
      JSON.stringify({ state: { user: s.user, token: s.token }, version: 0 })
    );
  }, session);
  return page;
}

/**
 * Set a field's value the way React can observe.
 *
 * Two traps here, both harness-only:
 *
 * 1. `page.type` cannot be used on `<input type="date">`: keystrokes land in whichever
 *    segment happens to be focused, so "2099-12-25" came out as "91225-09-20".
 * 2. Plain `el.value = val` is silently swallowed. React installs its own `value`
 *    accessor on the input and remembers the last value it saw; assigning through that
 *    accessor updates the memo, so the `input` event dispatched afterwards looks like a
 *    no-op change and React never calls onChange. react-hook-form then holds the old
 *    value while the DOM shows the new one — which is exactly why submitting appeared
 *    to do nothing. Writing through the prototype setter bypasses the memo, leaving
 *    React's tracker stale and the event genuinely "changed".
 */
async function setInput(page, selector, value) {
  await page.evaluate(
    (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`no element for ${sel}`);
      const proto =
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      el.focus();
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    },
    selector,
    value
  );
}

/** Click a button whose visible text matches. */
async function clickText(page, text, tag = 'button') {
  const done = await page.evaluate(
    (t, sel) => {
      const el = [...document.querySelectorAll(sel)].find((b) =>
        (b.innerText || '').trim().toLowerCase().includes(t.toLowerCase())
      );
      if (!el) return false;
      el.click();
      return true;
    },
    text,
    tag
  );
  return done;
}

const organiser = await login('organiser@ticketbooking.local', 'organiser123');
const TITLE = `Flow Test ${Date.now()}`;

/* --- 1. Dashboard exposes exactly one primary creation action -------------- */
console.log('\ndashboard');
{
  const page = await signedInPage(organiser);
  await page.goto(`${APP}/organiser`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /Dashboard/.test(document.body.innerText), { timeout: 30000 });
  await settle(2500);

  const header = await page.evaluate(() => {
    // The action row sits beside the page heading.
    const h1 = document.querySelector('h1');
    const row = h1?.closest('div')?.parentElement;
    return (row?.innerText || '').replace(/\s+/g, ' ');
  });
  check('header offers "New event"', /new event/i.test(header), header.slice(0, 80));
  check('  header no longer offers "New showing"', !/new showing/i.test(header), header.slice(0, 80));

  const stats = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  check('Events stat reports showings separately', /showings? in total/i.test(stats));
  await page.close();
}

/* --- 2. One-step creation ------------------------------------------------- */
console.log('\ncreate event in one action');
{
  const page = await signedInPage(organiser);
  page.on('pageerror', (e) => console.log('   [pageerror]', e.message.slice(0, 160)));
  await page.goto(`${APP}/organiser`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /Dashboard/.test(document.body.innerText), { timeout: 30000 });
  await settle(2500);

  check('opened the create dialog', await clickText(page, 'New event'));
  await page.waitForFunction(() => /Create new event/i.test(document.body.innerText), {
    timeout: 15000,
  });

  const fields = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  check('  form asks for date and time', /date/i.test(fields) && /time/i.test(fields));
  check('  form has a first-showing section', /first showing/i.test(fields));

  await page.type('#event-title', TITLE);

  // Venue select is a Radix listbox, so drive it by clicking options.
  await page.click('#event-venue');
  await settle(400);
  const venuePicked = await page.evaluate(() => {
    const opt = [...document.querySelectorAll('[role="option"]')].find(
      (o) => !o.getAttribute('aria-disabled') && /seats$/.test(o.innerText.trim())
    );
    if (!opt) return null;
    const label = opt.innerText.trim();
    opt.click();
    return label;
  });
  check('  picked a venue with a seat layout', Boolean(venuePicked), String(venuePicked));

  // Categories must appear on their own, derived from that venue.
  await page.waitForFunction(
    () => document.querySelectorAll('input[aria-label^="Price for"]').length > 0,
    { timeout: 20000 }
  );
  const cats = await page.evaluate(() =>
    [...document.querySelectorAll('input[aria-label^="Price for"]')].map((i) =>
      i.getAttribute('aria-label').replace('Price for ', '')
    )
  );
  check('  seat categories appeared automatically', cats.length > 0, cats.join(', '));

  // Submit with a price missing, to prove validation holds.
  await setInput(page, '#event-date', '2099-09-29');
  check('  blocked while a category price is missing', await clickText(page, 'Create event'));
  await settle(900);
  const stillOpen = await page.evaluate(() => /Create new event/i.test(document.body.innerText));
  check('    dialog stayed open', stillOpen);

  // Now price every category and submit for real.
  for (const c of cats) await setInput(page, `input[aria-label="Price for ${c}"]`, '250');
  await clickText(page, 'Create event');
  await page.waitForFunction(() => !/Create new event/i.test(document.body.innerText), {
    timeout: 30000,
  });

  const toast = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  check('created, and the message explains what happened', /bookable/i.test(toast), toast.match(/[^.]*bookable[^.]*/i)?.[0]?.slice(0, 90) ?? '');
  check('  reports seats generated from the layout', /seats generated/i.test(toast));
  await page.close();
}

/* --- 3. The event is immediately findable, including by search ------------- */
console.log('\nfindable straight away');
{
  const mine = await fetch(`${API}/api/events/mine`, {
    headers: { Authorization: `Bearer ${organiser.token}` },
  }).then((r) => r.json());
  const created = mine.events.find((e) => e.title === TITLE);
  check('appears in the organiser event list', Boolean(created), TITLE);
  check('  with one showing', created?.show_count === 1, `show_count=${created?.show_count}`);

  const pub = await fetch(`${API}/api/events?q=${encodeURIComponent(TITLE)}`).then((r) => r.json());
  check('  and is publicly searchable, i.e. bookable', pub.events.some((e) => e.title === TITLE));

  // The original bug: an event with NO showing must still reach the organiser.
  const showless = await fetch(`${API}/api/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${organiser.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `${TITLE} Draft`, type: 'movie', venue_id: created.venue_id }),
  }).then((r) => r.json());
  const mine2 = await fetch(`${API}/api/events/mine`, {
    headers: { Authorization: `Bearer ${organiser.token}` },
  }).then((r) => r.json());
  check(
    'a showless event still reaches the organiser list',
    mine2.events.some((e) => e.id === showless.event.id)
  );
  const pub2 = await fetch(`${API}/api/events?q=${encodeURIComponent(`${TITLE} Draft`)}`).then((r) =>
    r.json()
  );
  check(
    '  but stays out of the public browse, being unbookable',
    !pub2.events.some((e) => e.id === showless.event.id)
  );
  globalThis.__createdId = created.id;
  globalThis.__draftId = showless.event.id;
}

/* --- 4. Manage: add a second showing to the SAME event --------------------- */
console.log('\nmanage and add a second showing');
{
  const page = await signedInPage(organiser);
  await page.goto(`${APP}/organiser/events/${globalThis.__createdId}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 30000 }, TITLE);
  await settle(2000);

  const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  check('event information is shown', body.includes(TITLE));
  check('  venue named on the manage page', /Auditorium|Venue|Cinema/i.test(body));
  check('  offers "Add showing" in event context', /add showing/i.test(body));

  check('opened the add-showing dialog', await clickText(page, 'Add showing'));
  await page.waitForFunction(() => /Add a showing/i.test(document.body.innerText), { timeout: 15000 });

  const dialog = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    return {
      text: (d?.innerText || '').replace(/\s+/g, ' '),
      hasEventPicker: Boolean(d?.querySelector('#show-event')),
    };
  });
  check('  event is fixed context, not a picker', dialog.hasEventPicker === false);
  check('  and names the event', dialog.text.includes(TITLE), dialog.text.slice(0, 90));

  await setInput(page, '#show-date', '2099-09-30');
  const cats2 = await page.evaluate(() =>
    [...document.querySelectorAll('input[aria-label^="Price for"]')].map((i) =>
      i.getAttribute('aria-label').replace('Price for ', '')
    )
  );
  for (const c of cats2) await setInput(page, `input[aria-label="Price for ${c}"]`, '300');
  await clickText(page, 'Create showing');
  await settle(4000);

  const after = await fetch(`${API}/api/events/${globalThis.__createdId}`).then((r) => r.json());
  check('both showings belong to the same event', after.event.shows.length === 2, `${after.event.shows.length} showings`);
  check(
    '  each showing has its own seat inventory',
    after.event.shows.every((s) => s.total_seats > 0) &&
      new Set(after.event.shows.map((s) => s.id)).size === 2
  );
  await page.close();
}

/* --- 5. Showless event is recoverable from the UI -------------------------- */
console.log('\nshowless event is not a dead end');
{
  const page = await signedInPage(organiser);
  await page.goto(`${APP}/organiser`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /Dashboard/.test(document.body.innerText), { timeout: 30000 });
  await settle(2500);
  const row = await page.evaluate(
    (t) => {
      const tr = [...document.querySelectorAll('tr')].find((r) => r.innerText.includes(t));
      return tr ? tr.innerText.replace(/\s+/g, ' ') : null;
    },
    `${TITLE} Draft`
  );
  check('the showless event is listed on the dashboard', Boolean(row), String(row).slice(0, 90));
  check('  flagged as having no showings', /no showings yet/i.test(row ?? ''));
  check('  offers Add showing inline', /add showing/i.test(row ?? ''));
  await page.close();
}

/* --- 6. Customer path still works ----------------------------------------- */
console.log('\ncustomer side');
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${APP}/events/${globalThis.__createdId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /Select showtime/i.test(document.body.innerText), {
    timeout: 30000,
  });
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('a[href^="/shows/"]')].map((a) => a.getAttribute('href'))
  );
  check('customer sees both showings to choose from', links.length === 2, `${links.length} showtime link(s)`);

  await page.goto(`${APP}${links[0]}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-seat-id]', { timeout: 30000 });
  const seats = await page.evaluate(() => document.querySelectorAll('[data-seat-id]').length);
  check('  seat map renders for the chosen showing', seats > 0, `${seats} seats`);
  await page.close();
}

/* --- 7. Mobile ------------------------------------------------------------- */
console.log('\nmobile');
{
  const page = await signedInPage(organiser, 390);
  await page.goto(`${APP}/organiser`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /Dashboard/.test(document.body.innerText), { timeout: 30000 });
  await settle(2500);
  const m = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    hasNewEvent: /new event/i.test(document.body.innerText),
  }));
  check('dashboard has no horizontal overflow at 390px', !m.overflow);
  check('  primary action still reachable', m.hasNewEvent);
  await page.close();
}

console.log('\n==========================================');
console.log(`  passed: ${pass}  failed: ${fail}`);
console.log('==========================================');
await browser.close();
process.exitCode = fail === 0 ? 0 : 1;
