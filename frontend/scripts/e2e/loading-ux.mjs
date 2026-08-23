/**
 * Loading experience, measured in a real throttled browser.
 *
 * The acceptance criterion is behavioural and visual: navigating to any major route
 * must never leave the user on a blank or black screen while a JS chunk, an API
 * request or an image is in flight. So this samples the DOM *and* the painted pixels
 * repeatedly during each navigation, rather than checking the settled end state.
 *
 * Two measurements per route:
 *   - structural: does `main` contain laid-out content (not empty, not a lone spinner)?
 *   - visual: is the viewport uniformly dark/blank? Screenshots are averaged, because
 *     "black screen" is a pixel claim and the dark theme's own background is #0f100e —
 *     the only way to tell "correctly dark page with content" from "black nothing" is
 *     to look at variance across the frame.
 *
 * Runs in dark theme deliberately: that is where an empty `main` reads as black.
 *
 * Usage: backend on :3000, `npm run build && npx vite preview --port 4173`, then
 *   node scripts/e2e/loading-ux.mjs
 */
import puppeteer from 'puppeteer-core';

const APP = process.env.APP_URL ?? 'http://localhost:4173';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let pass = 0;
let fail = 0;
const check = (name, ok, note = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`);
  ok ? pass++ : fail++;
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chrome DevTools presets. */
const PROFILES = {
  'slow 4G': { latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 },
  'high latency': { latency: 1500, downloadThroughput: (2 * 1024 * 1024) / 8, uploadThroughput: (1024 * 1024) / 8 },
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });

/** Average luminance and spread of a screenshot, to detect a blank frame. */
async function frameStats(page) {
  const shot = await page.screenshot({ encoding: 'base64' });
  return page.evaluate(
    (b64) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          const w = (c.width = 160);
          const h = (c.height = 100);
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const { data } = ctx.getImageData(0, 0, w, h);
          let sum = 0;
          const lums = [];
          for (let i = 0; i < data.length; i += 4) {
            const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
            lums.push(l);
            sum += l;
          }
          const mean = sum / lums.length;
          const variance = lums.reduce((a, l) => a + (l - mean) ** 2, 0) / lums.length;
          resolve({ mean: Math.round(mean), sd: Math.round(Math.sqrt(variance)) });
        };
        img.src = 'data:image/png;base64,' + b64;
      }),
    shot
  );
}

/** What `main` contains right now. */
const probe = () =>
  ({
    // eslint-disable-next-line no-undef
    ...(() => {
      const main = document.querySelector('main');
      if (!main) return { hasMain: false };
      const boxes = [...main.querySelectorAll('*')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 20 && r.height > 8;
      });
      return {
        hasMain: true,
        // Laid-out descendants: an empty or spinner-only main has almost none.
        blocks: boxes.length,
        text: (main.innerText || '').trim().length,
        status: Boolean(main.querySelector('[role="status"]')),
        skeletons: main.querySelectorAll('[aria-hidden="true"]').length,
        spinnerOnly: boxes.length < 4 && Boolean(main.querySelector('.animate-spin')),
      };
    })(),
  });

async function newDarkPage(profile) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // Dark theme before first paint, matching the app's own pre-paint inline script.
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('tb-theme', 'dark');
    document.documentElement.classList.add('dark');
  });
  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.clearBrowserCache');
  if (profile) await cdp.send('Network.emulateNetworkConditions', { offline: false, ...profile });
  return { page, cdp };
}

/**
 * Click through to a route and sample continuously during the transition.
 * Returns the worst frame seen.
 */
async function measureNavigation(page, go, label) {
  const samples = [];
  let stop = false;
  const sampler = (async () => {
    while (!stop) {
      try {
        const dom = await page.evaluate(probe);
        const px = await frameStats(page);
        samples.push({ ...dom, ...px });
      } catch {
        /* navigation mid-flight */
      }
      await settle(120);
    }
  })();

  await go();
  await settle(2500);
  stop = true;
  await sampler;

  const meaningful = samples.filter((s) => s.hasMain);
  const blank = meaningful.filter((s) => s.blocks < 4 || s.text === 0);
  // A near-uniform very dark frame is the "black screen" signature.
  const black = meaningful.filter((s) => s.mean < 22 && s.sd < 12);
  const worst = meaningful.reduce(
    (a, s) => (s.blocks < a.blocks ? s : a),
    meaningful[0] ?? { blocks: 0, text: 0, mean: 0, sd: 0 }
  );

  console.log(
    `    ${label}: ${meaningful.length} frames | worst ${worst.blocks} blocks / ${worst.text} chars / lum ${worst.mean}±${worst.sd}`
  );
  return { samples: meaningful, blank, black, worst };
}

for (const [profileName, profile] of Object.entries(PROFILES)) {
  console.log(`\n=== ${profileName} · dark theme ===`);
  const { page } = await newDarkPage(profile);

  // Cold load of the entry route.
  await page.goto(`${APP}/events`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main', { timeout: 60000 });
  const cold = await frameStats(page);
  const coldDom = await page.evaluate(probe);
  check(
    `cold /events is not a black screen`,
    !(cold.mean < 22 && cold.sd < 12),
    `lum ${cold.mean}±${cold.sd}, ${coldDom.blocks} blocks`
  );
  check(`  and shows a loading shell or content`, coldDom.blocks >= 4, `${coldDom.blocks} blocks`);

  await page.waitForFunction(() => document.querySelectorAll('a[href^="/events/"]').length > 0, {
    timeout: 60000,
  });
  await settle(profile.latency > 1000 ? 6000 : 4000);

  const href = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href^="/events/"]')].filter((a) =>
      /^\/events\/\d+$/.test(a.getAttribute('href'))
    );
    return links[links.length - 1]?.getAttribute('href');
  });

  // --- Event details, the page the report singled out ---
  const detail = await measureNavigation(
    page,
    () => page.evaluate((h) => document.querySelector(`a[href="${h}"]`).click(), href),
    'events -> detail'
  );
  check('detail: never a black frame', detail.black.length === 0, `${detail.black.length} black frames`);
  check('  never a blank frame', detail.blank.length === 0, `${detail.blank.length} blank frames`);
  check('  structure present in every frame', detail.worst.blocks >= 4, `min ${detail.worst.blocks} blocks`);

  // --- Seat map, the heaviest customer route (socket.io) ---
  // Wait for the showtimes to arrive before measuring. Under 1.5s of latency the
  // detail page's own API request can still be in flight when the sampler stops, and
  // "no link yet" is the test being early rather than the page being broken.
  const showHref = await page
    .waitForFunction(() => document.querySelector('a[href^="/shows/"]')?.getAttribute('href') ?? null, {
      timeout: 30000,
      polling: 200,
    })
    .then((h) => h.jsonValue())
    .catch(() => null);
  if (showHref) {
    const seat = await measureNavigation(
      page,
      () => page.evaluate((h) => document.querySelector(`a[href="${h}"]`).click(), showHref),
      'detail -> seat map'
    );
    check('seat map: never a black frame', seat.black.length === 0, `${seat.black.length} black frames`);
    check('  never a blank frame', seat.blank.length === 0, `${seat.blank.length} blank frames`);
    check('  seat lattice visible while loading', seat.worst.blocks >= 10, `min ${seat.worst.blocks} blocks`);
  } else {
    check('seat map: found a show link', false, 'no /shows/ link on the detail page');
  }

  await page.close();
}

/* --- Organiser dashboard: the 376 kB chart chunk must not gate the page ----- */
console.log('\n=== organiser dashboard · slow 4G · dark theme ===');
{
  const auth = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'organiser@ticketbooking.local', password: 'organiser123' }),
  }).then((r) => r.json());
  if (!auth.token) throw new Error('organiser login failed');

  const { page, cdp } = await newDarkPage(null);
  await page.goto(`${APP}/events`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => {
    localStorage.setItem('tb-auth', JSON.stringify({ state: { user: s.user, token: s.token }, version: 0 }));
  }, auth);
  await cdp.send('Network.clearBrowserCache');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, ...PROFILES['slow 4G'] });

  const chartRequests = [];
  page.on('request', (r) => {
    if (/charts-|RevenueChart-/.test(r.url())) chartRequests.push(r.url().split('/').pop());
  });

  const dash = await measureNavigation(
    page,
    () => page.goto(`${APP}/organiser`, { waitUntil: 'domcontentloaded' }).catch(() => {}),
    'cold /organiser'
  );
  check('dashboard: never a black frame', dash.black.length === 0, `${dash.black.length} black frames`);
  check('  never a blank frame', dash.blank.length === 0, `${dash.blank.length} blank frames`);
  check('  layout present throughout', dash.worst.blocks >= 6, `min ${dash.worst.blocks} blocks`);

  await settle(6000);
  const settled = await page.evaluate(() => ({
    heading: document.querySelector('h1')?.textContent?.trim() ?? null,
    charts: document.querySelectorAll('.recharts-wrapper').length,
    text: document.querySelector('main').innerText.length,
  }));
  check('  dashboard fully renders', Boolean(settled.heading) && settled.text > 200, `h1 "${settled.heading}"`);
  check('  charts arrive after the layout', settled.charts >= 1, `${settled.charts} chart(s)`);
  check(
    '  chart library is a separate async chunk',
    chartRequests.some((u) => u.startsWith('charts-')),
    chartRequests.join(', ') || 'none'
  );
  await page.close();
}

/* --- API stalled 3s: the shell must not wait for data ---------------------- */
console.log('\n=== API delayed 3s ===');
{
  const { page } = await newDarkPage(null);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (/\/api\/events(\?|$)|\/api\/events\/\d+$/.test(req.url())) {
      setTimeout(() => req.continue().catch(() => {}), 3000);
    } else req.continue().catch(() => {});
  });

  await page.goto(`${APP}/events`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main', { timeout: 30000 });
  await settle(1200);
  const mid = await page.evaluate(probe);
  const px = await frameStats(page);
  check('events page renders with the API still pending', mid.blocks >= 4, `${mid.blocks} blocks`);
  check('  not a black screen', !(px.mean < 22 && px.sd < 12), `lum ${px.mean}±${px.sd}`);
  check('  skeletons announced to assistive tech', mid.status, `role=status ${mid.status}`);
  await page.close();
}

console.log('\n==========================================');
console.log(`  passed: ${pass}  failed: ${fail}`);
console.log('==========================================');
await browser.close();
process.exitCode = fail === 0 ? 0 : 1;
