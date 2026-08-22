/**
 * Design-system verification.
 *
 * journey.mjs and realtime.mjs prove behaviour. Nothing proved the *visual* rules the
 * redesign is built on, which is how a horizontal scrollbar on two mobile screens and
 * three contrast failures survived a green test run. This walks every route in the
 * right role, at desktop and mobile widths, and asserts the invariants from
 * `stitch_tixlock_seat_reservation_platform/tixlock_core/DESIGN.md`:
 *
 *   1. No box-shadows — depth in this system is a surface step, never a blur.
 *      The focused element is exempt: its ring is a required a11y affordance.
 *   2. 0px border-radius everywhere. The shape language is sharp without exception.
 *   3. Colour is signal only. At most ONE lime actionable element per screen ("the
 *      single most important action"); lime status tags and seat fills are unrestricted,
 *      which matches how the reference screens use it.
 *   4. WCAG AA contrast, computed against the *rendered* background by compositing
 *      translucent fills up the ancestor chain rather than trusting the token.
 *   5. No horizontal document overflow, and tap targets >= 24px (WCAG 2.5.8).
 *
 * Text reversed out over a photograph or over an absolutely positioned SVG (the hero
 * title, the seat map's ink stage slab) is reported under `over-media` and not counted
 * as a failure — a static check cannot judge those, so they need an eye on a
 * screenshot instead.
 *
 * Usage:
 *   node scripts/e2e/design-system.mjs            # audit, exit 1 on any violation
 *   node scripts/e2e/design-system.mjs --shots    # also write _shots/audit-*.png
 *
 * Prerequisites are the same as the other E2E scripts: backend on :3000, a production
 * preview on :4173, and Chrome at the path below.
 */
import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';

const APP = 'http://localhost:4173';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.argv.includes('--shots');

await mkdir('_shots', { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
});
const page = await browser.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160));
});

/* ------------------------------------------------------------------ *
 * The audit, run inside the page.
 * ------------------------------------------------------------------ */
const AUDIT = () => {
  /* --- colour helpers ---------------------------------------------- */
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a);
    const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const over = (fg, bg) =>
    fg.a >= 1
      ? fg
      : {
          r: fg.r * fg.a + bg.r * (1 - fg.a),
          g: fg.g * fg.a + bg.g * (1 - fg.a),
          b: fg.b * fg.a + bg.b * (1 - fg.a),
          a: 1,
        };

  /** Effective background: walk up until something is opaque enough to matter. */
  const bgOf = (el) => {
    let node = el;
    let acc = null;
    while (node && node !== document.documentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) {
        acc = acc === null ? c : over(acc, c);
        if (acc.a >= 0.999) return acc;
      }
      node = node.parentElement;
    }
    const root = parse(getComputedStyle(document.body).backgroundColor) ?? {
      r: 255,
      g: 255,
      b: 255,
      a: 1,
    };
    return acc === null ? root : over(acc, root);
  };

  const tag = (el) => {
    const cls = String(el.className || '').split(/\s+/).slice(0, 4).join('.');
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
  };

  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const all = [...document.querySelectorAll('*')].filter(visible);

  /* --- 1. shadows -------------------------------------------------- */
  /*
   * A focus ring is a box-shadow in Tailwind's implementation, and it is a required
   * accessibility affordance rather than simulated depth — so the currently focused
   * element is exempt. Everything else must be flat.
   */
  const shadows = all
    .filter((e) => {
      const v = getComputedStyle(e).boxShadow;
      if (!v || v === 'none') return false;
      return e !== document.activeElement;
    })
    .map((e) => `${tag(e)}  ${getComputedStyle(e).boxShadow.slice(0, 60)}`);

  /* --- 2. radii ---------------------------------------------------- */
  const radii = all
    .filter((e) => {
      const r = getComputedStyle(e).borderRadius;
      return r && r !== '0px' && r !== '';
    })
    .map((e) => `${getComputedStyle(e).borderRadius}  ${tag(e)}`);

  /* --- 3. signal colour -------------------------------------------- */
  /*
   * DESIGN.md reserves lime for "the single most important action on a screen", and
   * separately permits it as a status-tag fill. The reference screens use it 2-4
   * times each on exactly that basis (a LIVE/FEATURED tag plus one CTA), so counting
   * every lime fill as overuse is wrong.
   *
   * The rule that actually matters is therefore: at most one lime *actionable*
   * element per screen. Tags, legend swatches and seat fills are unrestricted.
   */
  const LIME = ['rgb(193, 241, 0)', 'rgb(171, 214, 0)'];
  const isLime = (e) => LIME.includes(getComputedStyle(e).backgroundColor);
  const limeFills = all
    .filter(isLime)
    .map((e) => `${tag(e)}  "${(e.textContent || '').trim().slice(0, 30)}"`);
  const limeActions = all
    .filter((e) => isLime(e) && e.matches('a, button, [role="button"]'))
    // A lime seat is a state readout, not the screen's primary action.
    .filter((e) => !e.hasAttribute('data-seat-id'))
    .map((e) => `${tag(e)}  "${(e.textContent || '').trim().slice(0, 30)}"`);

  const gradients = all
    .filter((e) => {
      const b = getComputedStyle(e).backgroundImage;
      return b && b.includes('gradient');
    })
    .map((e) => `${tag(e)}  ${getComputedStyle(e).backgroundImage.slice(0, 50)}`);

  /* --- 4. contrast ------------------------------------------------- */
  /**
   * True when something is painted behind this text that a computed-style walk
   * cannot see: a photograph, or an absolutely positioned sibling like the seat
   * map's ink stage slab.
   *
   * `bgOf` only walks *ancestors*, so in both cases it reports the page's cream and
   * declares cream-on-cream. Those are the two places in this app where text is
   * deliberately reversed out over media, so they are reported separately for a
   * human to eyeball rather than counted as failures.
   */
  const overMedia = (el) => {
    const r = el.getBoundingClientRect();
    const overlaps = (o) =>
      o.left < r.right && o.right > r.left && o.top < r.bottom && o.bottom > r.top;

    const behind = (selector) => {
      let node = el.parentElement;
      while (node && node !== document.documentElement) {
        for (const media of node.querySelectorAll(selector)) {
          // A descendant is painted *in front of* this text, not behind it, and an
          // ancestor is not media in its own right. Only siblings-and-their-subtrees
          // can sit underneath.
          if (media.contains(el) || el.contains(media)) continue;
          if (overlaps(media.getBoundingClientRect())) return true;
        }
        node = node.parentElement;
      }
      return false;
    };

    // A photograph genuinely defeats a static check.
    if (behind('img, video')) return true;

    /*
     * An SVG only counts when the text is lifted out of flow to sit on top of it —
     * that is the seat map's ink stage slab, which is drawn as a sibling path with
     * the label absolutely positioned over it.
     *
     * Without the positioning requirement this also swallowed an inline lucide icon
     * inside a badge and the recharts plot surface behind a legend label, and both of
     * those were real contrast failures being hidden.
     */
    const pos = getComputedStyle(el).position;
    if ((pos === 'absolute' || pos === 'fixed') && behind('svg')) return true;

    return false;
  };

  const contrast = [];
  const overMediaText = [];
  for (const el of all) {
    // Only elements that render their own text.
    const own = [...el.childNodes].some(
      (n) => n.nodeType === 3 && n.textContent.trim().length > 0
    );
    if (!own) continue;
    const s = getComputedStyle(el);
    const fg = parse(s.color);
    if (!fg || fg.a === 0) continue;
    const bg = bgOf(el);
    const eff = over(fg, bg);
    const size = parseFloat(s.fontSize);
    const weight = parseInt(s.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(eff, bg);
    if (got < need) {
      if (overMedia(el)) {
        overMediaText.push(
          `${tag(el)}  "${(el.textContent || '').trim().slice(0, 30)}"`
        );
        continue;
      }
      contrast.push(
        `${got.toFixed(2)}:1 (need ${need}) ${Math.round(size)}px/${weight}  ${tag(el)}  "${(
          el.textContent || ''
        )
          .trim()
          .slice(0, 34)}"`
      );
    }
  }

  /* --- 5. layout / targets ----------------------------------------- */
  const overflow = document.documentElement.scrollWidth - window.innerWidth;

  /**
   * Which element is actually pushing the page wide.
   *
   * Reports the *narrowest* offenders — an element whose own box exceeds the
   * viewport but whose parent does not is the real culprit; its ancestors are just
   * being stretched by it. Anything inside a deliberate horizontal scroller (the
   * seat map) is excluded, because overflowing there is the intended behaviour.
   */
  const overflowCulprits = [];
  if (overflow > 0) {
    const inScroller = (el) => {
      let n = el.parentElement;
      while (n && n !== document.documentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
        n = n.parentElement;
      }
      return false;
    };
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.right <= window.innerWidth + 1 && r.left >= -1) continue;
      if (inScroller(el)) continue;
      const p = el.parentElement;
      const pr = p ? p.getBoundingClientRect() : null;
      // Keep only the outermost element that is itself wider than its parent's box,
      // i.e. the one introducing the overflow rather than inheriting it.
      const introduces = !pr || r.right > pr.right + 1 || r.left < pr.left - 1;
      if (!introduces) continue;
      overflowCulprits.push(
        `left:${Math.round(r.left)} right:${Math.round(r.right)} w:${Math.round(r.width)}  ${tag(el)}  "${(
          el.textContent || ''
        )
          .trim()
          .slice(0, 28)}"`
      );
    }
  }

  const smallTargets = all
    .filter((e) => {
      if (!['A', 'BUTTON', 'INPUT', 'SELECT'].includes(e.tagName)) return false;
      if (e.disabled) return false;
      const r = e.getBoundingClientRect();
      return (r.width < 24 || r.height < 24) && r.width > 0;
    })
    .map((e) => {
      const r = e.getBoundingClientRect();
      return `${Math.round(r.width)}x${Math.round(r.height)}  ${tag(e)}  "${(e.textContent || '')
        .trim()
        .slice(0, 24)}"`;
    });

  /* --- typography -------------------------------------------------- */
  const fonts = {};
  for (const el of all) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const f = getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '');
    fonts[f] = (fonts[f] ?? 0) + 1;
  }

  /** Anton is a single-weight face; asking for 700 smears it. */
  const antonBold = all
    .filter((e) => {
      const s = getComputedStyle(e);
      return s.fontFamily.includes('Anton') && parseInt(s.fontWeight, 10) > 400;
    })
    .map((e) => `${getComputedStyle(e).fontWeight}  ${tag(e)}`);

  return {
    shadows,
    radii,
    limeFills,
    limeActions,
    gradients,
    contrast,
    overMediaText,
    overflow,
    overflowCulprits,
    smallTargets,
    fonts,
    antonBold,
  };
};

/* ------------------------------------------------------------------ *
 * Driver
 * ------------------------------------------------------------------ */
async function settle() {
  await page
    .waitForFunction(() => document.fonts.ready.then(() => true), { timeout: 15000 })
    .catch(() => {});
  await page
    .waitForFunction(
      () => {
        const i = [...document.querySelectorAll('img')];
        return i.length === 0 || i.every((x) => x.complete);
      },
      { timeout: 20000 }
    )
    .catch(() => {});
  // Let skeletons resolve into real content, and recharts finish animating.
  await sleep(1800);
}

async function signIn(email) {
  await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await page.evaluate((wanted) => {
    [...document.querySelectorAll('button')]
      .find((b) => (b.textContent ?? '').includes(wanted))
      ?.click();
  }, email);
  await sleep(400);
  await page.evaluate(() => {
    [...document.querySelectorAll('button')]
      .find((b) => b.getAttribute('type') === 'submit')
      ?.click();
  });
  await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 15000 });
  await sleep(600);
}

async function signOut() {
  // Must be on an app-origin document first: localStorage on about:blank throws.
  if (!page.url().startsWith(APP)) {
    await page.goto(`${APP}/events`, { waitUntil: 'domcontentloaded' });
  }
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}

let problems = 0;
const summary = [];

async function audit(label, route, { width = 1440, height = 1000 } = {}) {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(`${APP}${route}`, { waitUntil: 'domcontentloaded' });
  await settle();

  const r = await page.evaluate(AUDIT);
  const at = `${label} [${width}w]`;
  const lines = [];

  if (r.shadows.length) lines.push(['shadow', r.shadows]);
  if (r.radii.length) lines.push(['radius', r.radii]);
  if (r.contrast.length) lines.push(['contrast', r.contrast]);
  if (r.overflow > 0)
    lines.push(['h-overflow', [`${r.overflow}px`, ...r.overflowCulprits]]);
  if (r.smallTargets.length) lines.push(['tap-target', r.smallTargets]);
  if (r.antonBold.length) lines.push(['anton-bold', r.antonBold]);
  if (r.limeActions.length > 1) lines.push(['lime-overuse', r.limeActions]);

  console.log(`\n=== ${at}  ${route}`);
  console.log(
    `    lime:${r.limeFills.length} (actions:${r.limeActions.length})  gradients:${
      r.gradients.length
    }  fonts:${JSON.stringify(r.fonts)}`
  );
  if (r.gradients.length) r.gradients.forEach((g) => console.log(`    grad  ${g}`));
  // Not failures — text reversed out over media, which needs a human eye.
  if (r.overMediaText.length)
    r.overMediaText.forEach((t) => console.log(`    over-media  ${t}`));

  if (lines.length === 0) {
    console.log('    OK');
  } else {
    for (const [kind, items] of lines) {
      problems += items.length;
      for (const item of items) console.log(`    ${kind.padEnd(11)} ${item}`);
    }
  }
  summary.push([at, lines.reduce((n, [, i]) => n + i.length, 0)]);

  if (SHOTS) {
    const safe = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    await page.screenshot({ path: `_shots/audit-${safe}-${width}.png`, fullPage: true });
  }
}

/* --- anonymous ---------------------------------------------------- */
await signOut();
await audit('browse', '/events');
await audit('browse', '/events', { width: 390, height: 844 });
await audit('event detail', '/events/1');
await audit('event detail', '/events/1', { width: 390, height: 844 });
await audit('seat map anon', '/shows/1');
await audit('seat map anon', '/shows/1', { width: 390, height: 844 });
await audit('login', '/login');
await audit('register', '/register');
await audit('not found', '/nope');
await audit('offer bare', '/offer');

/* --- customer ----------------------------------------------------- */
await signIn('customer@ticketbooking.local');
await audit('bookings', '/bookings');
await audit('bookings', '/bookings', { width: 390, height: 844 });
await audit('seat map customer', '/shows/1');

/* --- organiser ---------------------------------------------------- */
await signOut();
await signIn('organiser@ticketbooking.local');
await audit('organiser dashboard', '/organiser');
await audit('organiser dashboard', '/organiser', { width: 390, height: 844 });
await audit('organiser event', '/organiser/events/1');

/* --- admin -------------------------------------------------------- */
await signOut();
await signIn('admin@ticketbooking.local');
await audit('admin venues', '/admin');
await audit('admin venues', '/admin', { width: 390, height: 844 });

/* --- report ------------------------------------------------------- */
console.log('\n==========================================');
for (const [label, n] of summary) {
  console.log(`  ${n === 0 ? 'ok  ' : 'FAIL'}  ${String(n).padStart(3)}  ${label}`);
}
console.log('==========================================');
console.log(`  total problems: ${problems}`);
if (consoleErrors.length) {
  console.log(`  console errors: ${consoleErrors.length}`);
  [...new Set(consoleErrors)].forEach((e) => console.log(`    ${e}`));
}

await browser.close();
process.exit(problems > 0 ? 1 : 0);
