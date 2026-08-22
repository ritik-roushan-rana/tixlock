/**
 * Hero text-over-photograph contrast.
 *
 * `design-system.mjs` deliberately cannot judge this case: it composites background
 * colours up the ancestor chain, and a photograph is not a colour. It reports the hero
 * title under `over-media` and leaves it to a human. This script is that human.
 *
 * It hides the text, screenshots the exact band the text occupied, decodes it, and
 * computes the contrast between the text colour and *every* pixel behind it — so the
 * number it reports is the worst case, not an average that a bright patch can hide in.
 *
 * Why it exists: event posters render in full colour, so the hero's white Anton title
 * is legible only because of the scrim gradient beneath it. With the scrim's mid stop
 * at /35 the worst case measured 3.06:1 against a 3.0 requirement — technically
 * passing, but the artwork comes from a seeded placeholder service, so the next
 * featured event was one bright photo away from failing. This is what caught that and
 * what verifies the stronger scrim.
 *
 * No image library needed: the capture is decoded by the browser's own PNG decoder and
 * read back off a canvas.
 *
 * Usage: node scripts/e2e/hero-contrast.mjs     # exits 1 if any sample fails AA
 */
import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';

const APP = 'http://localhost:4173';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(`${APP}/events`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#featured-title', { timeout: 20000 });
await page
  .waitForFunction(
    () => [...document.querySelectorAll('img')].every((i) => i.complete),
    { timeout: 20000 }
  )
  .catch(() => {});
await sleep(1200);

const lum = (r, g, b) => {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

/** Sample the band a text element occupies, hiding the text itself first. */
async function sample(label, selector) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
      color: s.color,
      fontSize: parseFloat(s.fontSize),
      fontWeight: s.fontWeight,
    };
  }, selector);
  if (!box) return console.log(`  ${label}: not found`);

  // Hide the text so the capture is purely what sits behind it.
  await page.evaluate((sel) => {
    document.querySelector(sel).style.visibility = 'hidden';
  }, selector);
  const clip = {
    x: Math.max(0, box.x),
    y: Math.max(0, box.y),
    width: Math.max(1, Math.min(box.w, 1440 - box.x)),
    height: Math.max(1, Math.min(box.h, 1000 - box.y)),
  };
  const b64 = await page.screenshot({ clip, encoding: 'base64' });
  await page.evaluate((sel) => {
    document.querySelector(sel).style.visibility = '';
  }, selector);

  // Decode with the browser's own PNG decoder and read the pixels off a canvas, so
  // this needs no image library on the Node side.
  const pixels = await page.evaluate(async (dataUri) => {
    const img = new Image();
    img.src = dataUri;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  }, `data:image/png;base64,${b64}`);

  const fg = box.color.match(/\d+(\.\d+)?/g).map(Number);
  const fgLum = lum(fg[0], fg[1], fg[2]);

  let worst = Infinity;
  let worstPx = null;
  let total = 0;
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const c = ratio(fgLum, lum(r, g, b));
    total += c;
    count += 1;
    if (c < worst) {
      worst = c;
      worstPx = [r, g, b];
    }
  }

  const large = box.fontSize >= 24 || (box.fontSize >= 18.66 && Number(box.fontWeight) >= 700);
  const need = large ? 3 : 4.5;
  const verdict = worst >= need ? 'PASS' : 'FAIL';
  console.log(
    `  ${verdict}  ${label}\n        ${Math.round(box.fontSize)}px  worst ${worst.toFixed(
      2
    )}:1 (need ${need})  mean ${(total / count).toFixed(2)}:1  worst pixel rgb(${worstPx})`
  );
  return worst >= need;
}

console.log('hero text over artwork, full-colour image:');
const results = [];
results.push(await sample('featured title (Anton display)', '#featured-title'));
results.push(await sample('description', '#featured-title ~ p'));

// _shots/ is generated output and git-ignored, so it may not exist on a fresh
// checkout or after a cleanup. Create it rather than failing with ENOENT here.
await mkdir('_shots', { recursive: true });
await page.screenshot({ path: '_shots/hero-colour.png', clip: { x: 0, y: 0, width: 1440, height: 800 } });
console.log('wrote _shots/hero-colour.png');

await browser.close();
process.exit(results.some((r) => r === false) ? 1 : 0);
