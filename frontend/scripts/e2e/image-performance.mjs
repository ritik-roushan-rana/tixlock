/**
 * Event image loading, measured in a real browser.
 *
 * jsdom cannot answer any of the questions that matter here — it has no image
 * decoder, no `srcset` selection, no HTTP cache and no layout — so this drives real
 * Chrome over CDP and asserts on the network log and on painted geometry.
 *
 * What it proves:
 *   - the details page paints its copy before the hero image finishes
 *   - the hero box is reserved, so loading it shifts nothing (CLS)
 *   - artwork is fetched as image URLs, never base64/blob/XHR-to-Buffer
 *   - `srcset` actually narrows what a 390px viewport downloads
 *   - a hero warmed on hover is not requested a second time after navigating
 *   - a failed image resolves to the category fallback, not a broken glyph
 *   - responses are cacheable, and a second visit re-reads from cache
 *
 * Usage: backend on :3000, `npm run build && npx vite preview --port 4173`, then
 *   node scripts/e2e/image-performance.mjs
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
const isArtwork = (url) => /picsum\.photos/.test(url);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });

/** A page that records every artwork request and any suspicious binary handling. */
async function instrument(page) {
  const log = { images: [], dataUrls: 0, xhrImages: 0 };

  page.on('request', (req) => {
    const url = req.url();
    // The app's favicon is a deliberate inline SVG data URI, so it must not count as
    // "artwork smuggled through base64" — that check is about photographs.
    if (url.startsWith('data:image') && !url.startsWith('data:image/svg+xml')) log.dataUrls++;
    // An image pulled through fetch/XHR is the buffer/base64 antipattern.
    if (isArtwork(url) && ['fetch', 'xhr'].includes(req.resourceType())) log.xhrImages++;
    if (isArtwork(url)) log.images.push({ url, type: req.resourceType() });
  });
  page.on('response', (res) => {
    if (!isArtwork(res.url())) return;
    const entry = log.images.find((i) => i.url === res.url() && i.status === undefined);
    if (entry) {
      entry.status = res.status();
      entry.contentType = res.headers()['content-type'];
      entry.cacheControl = res.headers()['cache-control'];
      entry.fromCache = res.fromCache();
    }
  });

  // Continuous layout-shift accounting, installed before any paint.
  await page.evaluateOnNewDocument(() => {
    window.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__cls += entry.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });

  return log;
}

const firstEventHref = async (page) =>
  page.evaluate(() => {
    const a = [...document.querySelectorAll('a[href^="/events/"]')].find((x) =>
      /^\/events\/\d+$/.test(x.getAttribute('href'))
    );
    return a?.getAttribute('href') ?? null;
  });

/* --- 1. Details page paints before the hero image resolves ------------------ */
console.log('\ncontent before image');
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const log = await instrument(page);

  // Hold the artwork so the "is the page usable yet?" question has a stable answer.
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (isArtwork(req.url())) setTimeout(() => req.continue().catch(() => {}), 4000);
    else req.continue().catch(() => {});
  });

  await page.goto(`${APP}/events`, { waitUntil: 'domcontentloaded' });
  await settle(3000);
  const href = await firstEventHref(page);
  check('found an event link', Boolean(href), String(href));

  await page.evaluate((h) => {
    document.querySelector(`a[href="${h}"]`).click();
  }, href);
  await settle(1200); // well inside the 4s artwork stall

  const early = await page.evaluate(() => {
    const img = document.querySelector('main img[src*="picsum"]');
    const h1 = document.querySelector('h1');
    const box = img?.getBoundingClientRect();
    return {
      path: location.pathname,
      title: h1?.textContent?.trim() ?? null,
      showtimePanel: /select showtime/i.test(document.body.innerText),
      imgComplete: img?.complete ?? null,
      // The reserved box must already have its final size while empty.
      boxW: box ? Math.round(box.width) : 0,
      boxH: box ? Math.round(box.height) : 0,
    };
  });

  check('route changed', /^\/events\/\d+$/.test(early.path), early.path);
  check('title is painted while the image is still loading', Boolean(early.title), String(early.title));
  check('  image genuinely not complete yet', early.imgComplete === false, String(early.imgComplete));
  check('  showtime panel is present', early.showtimePanel);
  check(
    '  hero box already reserved at full size',
    early.boxW > 300 && early.boxH > 150,
    `${early.boxW}x${early.boxH}`
  );

  /*
   * Zero the shift counter now that the detail page has painted.
   *
   * Total session CLS also contains the route transition — the events list is much
   * taller than the detail page, so the footer legitimately lands somewhere new — and
   * that is neither caused by nor fixable from the image path. Measuring from here
   * isolates the only question this script is asking: does the artwork arriving move
   * anything?
   */
  await page.evaluate(() => {
    window.__cls = 0;
  });

  await page.waitForFunction(
    () => {
      const i = document.querySelector('main img[src*="picsum"]');
      return Boolean(i && i.complete && i.naturalWidth > 0);
    },
    { timeout: 30000, polling: 100 }
  );
  // The fade is 200ms; poll rather than sleep so this cannot sample mid-transition.
  await page.waitForFunction(
    () => {
      const i = document.querySelector('main img[src*="picsum"]');
      return i && getComputedStyle(i).opacity === '1';
    },
    { timeout: 5000, polling: 50 }
  ).catch(() => {});

  const after = await page.evaluate(() => {
    const img = document.querySelector('main img[src*="picsum"]');
    return {
      // naturalWidth guards against `complete` being true for an unresolved source.
      complete: Boolean(img?.complete && img.naturalWidth > 0),
      opacity: img ? getComputedStyle(img).opacity : null,
      cls: window.__cls,
      currentSrc: img?.currentSrc ?? '',
    };
  });
  check('image eventually loads', after.complete === true);
  check('  placeholder gone: image fully opaque', after.opacity === '1', String(after.opacity));
  check(
    '  loading the image shifts nothing',
    after.cls < 0.005,
    `CLS ${after.cls.toFixed(4)} attributable to the image`
  );
  check('  served as webp', /\.webp/.test(after.currentSrc), after.currentSrc.slice(-40));
  check('no base64 artwork requests', log.dataUrls === 0, `${log.dataUrls} seen`);
  check('no artwork fetched via XHR/fetch', log.xhrImages === 0, `${log.xhrImages} seen`);
  // The same claim from the DOM side: artwork is a plain URL on an <img>, never a
  // base64 payload or an object URL produced from a Buffer.
  const srcShapes = await page.evaluate(() =>
    [...document.querySelectorAll('main img')].map((i) => i.getAttribute('src') ?? '')
  );
  check(
    'artwork src attributes are plain URLs',
    srcShapes.length > 0 && srcShapes.every((s) => /^https?:\/\//.test(s)),
    srcShapes.map((s) => s.slice(0, 24)).join(' , ') || 'none'
  );
  await page.close();
}

/* --- 1b. Slow detail API must not gate the page ----------------------------- */
console.log('\ncached data, slow API');
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await instrument(page);

  // Stall only GET /events/:id. Everything the list already knows — artwork, title,
  // venue, copy — should be on screen regardless of how long this takes.
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (/\/api\/events\/\d+$/.test(req.url())) setTimeout(() => req.continue().catch(() => {}), 5000);
    else req.continue().catch(() => {});
  });

  await page.goto(`${APP}/events`, { waitUntil: 'domcontentloaded' });
  await settle(3500);
  const href = await firstEventHref(page);

  await page.hover(`a[href="${href}"]`);
  await settle(500);
  await page.evaluate((h) => document.querySelector(`a[href="${h}"]`).click(), href);
  await settle(1500); // a third of the way into the 5s API stall

  const seeded = await page.evaluate(() => {
    const img = document.querySelector('main img[src*="picsum"]');
    return {
      title: document.querySelector('h1')?.textContent?.trim() ?? null,
      hasHeroImg: Boolean(img),
      heroLoaded: Boolean(img && img.complete && img.naturalWidth > 0),
      venueShown: /venue/i.test(document.body.innerText),
      // A full-page skeleton would leave no real copy at all.
      showtimesBusy: Boolean(document.querySelector('[aria-busy="true"]')),
      // The lie this must never tell while the shows are still unknown.
      claimsNoShowings: /no upcoming showings/i.test(document.body.innerText),
    };
  });

  check('title rendered from cached list data, API still pending', Boolean(seeded.title), String(seeded.title));
  check('  hero image element already mounted', seeded.hasHeroImg);
  check('  and already loaded, before the API answered', seeded.heroLoaded);
  check('  venue panel present', seeded.venueShown);
  check('  showtimes show a busy skeleton', seeded.showtimesBusy);
  check('  does not claim the event has no showings', seeded.claimsNoShowings === false);

  await settle(5000);
  const settled = await page.evaluate(() => ({
    busy: Boolean(document.querySelector('[aria-busy="true"]')),
    showtimes: /select showtime/i.test(document.body.innerText),
    rows: document.querySelectorAll('a[href^="/shows/"]').length,
    title: document.querySelector('h1')?.textContent?.trim() ?? null,
  }));
  check('real showtimes replace the skeleton', settled.busy === false && settled.rows > 0, `${settled.rows} showtime row(s)`);
  check('  showtime panel intact', settled.showtimes);
  // The seed must have described the event the API then confirmed. If they disagree,
  // the cache lookup matched the wrong id and the page showed the wrong artwork.
  check(
    '  seeded title matched the fetched event',
    seeded.title !== null && seeded.title === settled.title,
    `seeded "${seeded.title}" vs fetched "${settled.title}"`
  );
  await page.close();
}

/* --- 2. Hover warm, then navigate: no duplicate request -------------------- */
console.log('\npreload dedupe');
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const log = await instrument(page);

  await page.goto(`${APP}/events`, { waitUntil: 'domcontentloaded' });
  await settle(3500);
  const href = await firstEventHref(page);

  // Hover repeatedly: dedupe should collapse this to a single warm.
  for (let i = 0; i < 4; i++) {
    await page.hover(`a[href="${href}"]`);
    await page.hover('h1');
    await settle(150);
  }
  await settle(2500);
  const warmed = log.images.filter((i) => /\/1280\/720|\/960\/540|\/1600\/900|\/1280\//.test(i.url));
  const beforeCount = log.images.length;

  await page.evaluate((h) => document.querySelector(`a[href="${h}"]`).click(), href);
  await settle(3500);

  const heroSrc = await page.evaluate(
    () => document.querySelector('main img[src*="picsum"]')?.currentSrc ?? ''
  );
  const requestsForHero = log.images.filter((i) => i.url === heroSrc);
  check('hero warmed before navigation', warmed.length > 0, `${warmed.length} backdrop request(s)`);
  check(
    'hero URL requested exactly once across hover + navigation',
    requestsForHero.length === 1,
    `${requestsForHero.length} request(s) for ${heroSrc.slice(-32)}`
  );
  // Every distinct URL should appear once; repeats mean the cache is being defeated.
  const counts = log.images.reduce((m, i) => m.set(i.url, (m.get(i.url) ?? 0) + 1), new Map());
  const repeated = [...counts.entries()].filter(([, n]) => n > 1);
  check('no artwork URL requested twice', repeated.length === 0, `${repeated.length} repeated, of ${counts.size} distinct, ${beforeCount} pre-nav`);
  await page.close();
}

/* --- 3. Responsive: a phone must not download the desktop asset ------------ */
console.log('\nresponsive srcset');
{
  const results = {};
  for (const [label, width] of [['mobile', 390], ['desktop', 1440]]) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 844, deviceScaleFactor: 1 });
    const log = await instrument(page);
    await page.goto(`${APP}/events`, { waitUntil: 'domcontentloaded' });
    await settle(3000);
    const href = await firstEventHref(page);
    await page.goto(`${APP}${href}`, { waitUntil: 'domcontentloaded' });
    await settle(4000);
    const picked = await page.evaluate(
      () => document.querySelector('main img[src*="picsum"]')?.currentSrc ?? ''
    );
    const chosen = Number((picked.match(/\/(\d+)\/\d+\.webp/) ?? [])[1] ?? 0);
    const bytes = log.images.filter((i) => i.url === picked);
    results[label] = { chosen, url: picked };
    check(`${label} (${width}px) picked a candidate`, chosen > 0, `${chosen}w  ${bytes.length} req`);
    await page.close();
  }
  check(
    'mobile downloads a smaller candidate than desktop',
    results.mobile.chosen > 0 && results.mobile.chosen < results.desktop.chosen,
    `mobile ${results.mobile.chosen}w vs desktop ${results.desktop.chosen}w`
  );
}

/* --- 4. Failure resolves to the fallback, not a broken glyph --------------- */
console.log('\nerror fallback');
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (req) => (isArtwork(req.url()) ? req.abort() : req.continue()));

  await page.goto(`${APP}/events`, { waitUntil: 'domcontentloaded' });
  await settle(3000);
  const href = await firstEventHref(page);
  await page.goto(`${APP}${href}`, { waitUntil: 'domcontentloaded' });
  await settle(3000);

  const state = await page.evaluate(() => {
    const heroBox = [...document.querySelectorAll('main div')].find((d) =>
      /aspect-\[16\/10\]/.test(d.className)
    );
    return {
      brokenImgs: [...document.querySelectorAll('img[src*="picsum"]')].length,
      glyph: Boolean(heroBox?.querySelector('svg')),
      title: document.querySelector('h1')?.textContent?.trim() ?? null,
      cls: window.__cls ?? 0,
    };
  });
  check('failed image is unmounted, no broken glyph', state.brokenImgs === 0, `${state.brokenImgs} img left`);
  check('  category fallback rendered instead', state.glyph);
  check('  page still fully usable', Boolean(state.title), String(state.title));
  check('  fallback causes no layout shift', state.cls < 0.02, `CLS ${state.cls.toFixed(4)}`);
  await page.close();
}

/* --- 5. Caching: a repeat visit should not re-download --------------------- */
console.log('\ncaching');
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const log = await instrument(page);
  await page.goto(`${APP}/events`, { waitUntil: 'domcontentloaded' });
  await settle(3000);
  const href = await firstEventHref(page);
  await page.goto(`${APP}${href}`, { waitUntil: 'domcontentloaded' });
  await settle(4000);

  const cc = log.images.find((i) => i.cacheControl)?.cacheControl ?? '';
  check('artwork is cacheable', /max-age=\d+/.test(cc), cc.slice(0, 60));

  const heroSrc = await page.evaluate(
    () => document.querySelector('main img[src*="picsum"]')?.currentSrc ?? ''
  );
  const before = log.images.length;
  await page.goto(`${APP}/events`, { waitUntil: 'domcontentloaded' });
  await settle(1500);
  await page.goto(`${APP}${href}`, { waitUntil: 'domcontentloaded' });
  await settle(3000);

  // Asserted on the hero specifically rather than on every artwork request. A revisit
  // legitimately fetches images the first pass never showed — cards below the fold that
  // the lazy loader skipped — so a blanket "nothing hits the network" would fail for a
  // reason that is not a caching problem.
  const heroOnRevisit = log.images.slice(before).filter((i) => i.url === heroSrc);
  const servedFromNetwork = heroOnRevisit.filter((i) => i.fromCache === false && i.status === 200);
  check(
    'revisited hero is not re-downloaded',
    servedFromNetwork.length === 0,
    `${heroOnRevisit.length} request(s) for the hero, ${servedFromNetwork.length} from network`
  );
  await page.close();
}

/* --- 6. Slow 3G: how long until the page is readable ---------------------- */
console.log('\nslow 3G');
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await instrument(page);
  await page.goto(`${APP}/events`, { waitUntil: 'domcontentloaded' });
  await settle(3500);
  const href = await firstEventHref(page);

  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');
  // Chrome DevTools' "Slow 3G" preset.
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 400,
    downloadThroughput: (400 * 1024) / 8,
    uploadThroughput: (400 * 1024) / 8,
  });

  const started = Date.now();
  await page.evaluate((h) => document.querySelector(`a[href="${h}"]`).click(), href);
  await page.waitForFunction(() => Boolean(document.querySelector('h1')?.textContent?.trim()), {
    timeout: 30000,
  });
  const titleAt = Date.now() - started;

  // From here on, any shift is the image's doing rather than the route change's.
  await page.evaluate(() => {
    window.__cls = 0;
  });
  await page
    .waitForFunction(
      () => {
        const i = document.querySelector('main img[src*="picsum"]');
        return Boolean(i && i.complete && i.naturalWidth > 0);
      },
      { timeout: 60000, polling: 100 }
    )
    .catch(() => {});
  const imageAt = Date.now() - started;
  const cls = await page.evaluate(() => window.__cls);

  console.log(`    title readable at ${titleAt}ms, hero complete at ${imageAt}ms`);
  check('on Slow 3G the copy is readable well before the image', titleAt < imageAt, `${titleAt}ms vs ${imageAt}ms`);
  check('  copy readable within 2s despite the throttle', titleAt < 2000, `${titleAt}ms`);
  check(
    '  the slow image still shifts nothing',
    cls < 0.005,
    `CLS ${cls.toFixed(4)} attributable to the image`
  );
  await page.close();
}

console.log('\n==========================================');
console.log(`  passed: ${pass}  failed: ${fail}`);
console.log('==========================================');
await browser.close();
process.exitCode = fail === 0 ? 0 : 1;
