/**
 * Placeholder artwork.
 *
 * The backend has no image column, and inventing real film/artist poster URLs would
 * be both wrong and legally sketchy, so every image in the app is generic stock
 * photography from picsum.photos.
 *
 * The whole point of this module is that it is the ONLY place an image URL is built.
 * Screens call `eventPoster(id)` / `eventBackdrop(id)` and never construct a URL
 * themselves. When real artwork arrives — a `poster_url` column, a CDN, TMDB — the
 * change is confined to the two functions below and nothing else in the codebase
 * needs to move.
 *
 * One thing to know about this provider's cost model: every URL here is a 302 to
 * `fastly.picsum.photos`, so a cold image pays DNS + TLS on two hosts before any
 * pixel data moves — about 720 ms cold, 345 ms with warm DNS, measured. That is why
 * `index.html` preconnects to both hosts and why the detail hero is warmed on intent
 * (see `preloadImage`) rather than discovered late in the render.
 *
 * Two properties worth keeping if you swap the provider:
 *
 *  1. Deterministic. The same event must always resolve to the same picture. A random
 *     image per render makes the grid flicker on every refetch and makes a card's
 *     poster disagree with the hero backdrop for the same event.
 *  2. Shared seed across crops. `eventPoster` and `eventBackdrop` use one seed, so an
 *     event's portrait poster and landscape hero are the same photograph framed
 *     differently, the way real artwork behaves.
 */

import { preloadImage } from './imagePreload';

/** Swap this one line to change providers. */
const IMAGE_ORIGIN = 'https://picsum.photos/seed';

/** Namespaced so seeds can't collide with anything else using the same service. */
function seedFor(kind: string, id: number | string): string {
  return encodeURIComponent(`tb-${kind}-${id}`);
}

/**
 * `.webp` is not cosmetic. Measured against the same seed and crop:
 *
 *     1200x675   jpg 108,593 B / 438 ms      webp 69,386 B / 261 ms
 *     1600x900   jpg 175,391 B               webp 104,290 B
 *      640x360   jpg  36,139 B               webp 26,220 B
 *
 * 36-41% fewer bytes at a size no viewer can tell apart from the JPEG. Every browser
 * this app supports decodes WebP, and the provider transcodes on demand, so there is
 * no fallback path to maintain.
 */
const FORMAT = '.webp';

function imageUrl(seed: string, width: number, height: number): string {
  return `${IMAGE_ORIGIN}/${seed}/${width}/${height}${FORMAT}`;
}

/**
 * Candidate widths offered to the browser via `srcSet`.
 *
 * The provider renders any width on demand, which is what makes real responsive
 * images possible here. Without this a phone downloaded the full desktop asset: 1200w
 * webp is 69 KB against 26 KB at 640w, so a 390px screen was paying roughly 2.6x for
 * pixels it then threw away.
 *
 * Kept deliberately short. Each entry is a distinct URL and therefore a distinct
 * cache entry, and a ladder dense enough to "always fit" would guarantee that
 * arriving at a page never reuses anything already fetched.
 */
const WIDTHS = [640, 960, 1280, 1600] as const;

/** `srcSet` for a 16:9 backdrop, matching `eventBackdrop`'s crop. */
export function eventBackdropSrcSet(eventId: number | string): string {
  const seed = seedFor('event', eventId);
  return WIDTHS.map((w) => `${imageUrl(seed, w, Math.round(w * 0.5625))} ${w}w`).join(', ');
}

/** `srcSet` for a 2:3 portrait poster, matching `eventPoster`'s crop. */
export function eventPosterSrcSet(eventId: number | string): string {
  const seed = seedFor('event', eventId);
  // Cards never occupy a full desktop viewport, so the ladder stops lower.
  return [320, 480, 600, 800]
    .map((w) => `${imageUrl(seed, w, Math.round(w * 1.5))} ${w}w`)
    .join(', ');
}

/**
 * The detail page hero's `sizes`, exported so the preloader cannot drift from it.
 *
 * These two values pick the candidate the browser downloads. If a card warms the hero
 * under one `sizes` and the detail page renders it under another, the element selects
 * a URL that was never warmed and the image is fetched twice — the preload becomes a
 * pure cost. Keeping the string in one place is what makes that impossible.
 */
export const HERO_SIZES = '(max-width: 1024px) 100vw, 66vw';

/** The hero's fallback `src`, for browsers that ignore `srcSet`. */
export const HERO_FALLBACK_WIDTH = 1280;

/** Portrait 2:3 poster for event cards. */
export function eventPoster(eventId: number | string, width = 400): string {
  return imageUrl(seedFor('event', eventId), width, Math.round(width * 1.5));
}

/** Wide backdrop for the hero banner and event detail header. */
export function eventBackdrop(eventId: number | string, width = 1280): string {
  return imageUrl(seedFor('event', eventId), width, Math.round(width * 0.5625));
}

/** Square crop, for compact list rows and the ticket stub. */
export function eventThumb(eventId: number | string, size = 160): string {
  return imageUrl(seedFor('event', eventId), size, size);
}

/**
 * Venue photograph, seeded by venue rather than by event.
 *
 * Deliberately a different seed namespace: two events at the same venue should show
 * the same building, which is what makes the venue panel read as information rather
 * than decoration.
 */
export function venuePhoto(venueId: number | string, width = 640): string {
  return imageUrl(seedFor('venue', venueId), width, Math.round(width * 0.75));
}

/**
 * Warm the event detail hero while the user is still on the list.
 *
 * Called on pointer/focus intent from a card. By the time the route actually changes,
 * the 302, the DNS and TLS to both picsum hosts, and often the image itself are
 * already done, so the hero can paint on the first frame instead of after the API
 * round trip.
 *
 * Uses exactly the descriptor the detail page renders — same `srcSet`, same `sizes`,
 * same fallback `src` — so the element resolves to the warmed URL and issues no second
 * request. That agreement is the whole reason this lives here next to the builders
 * rather than at the call site.
 */
export function preloadEventHero(eventId: number | string): boolean {
  return preloadImage(eventBackdrop(eventId, HERO_FALLBACK_WIDTH), {
    srcSet: eventBackdropSrcSet(eventId),
    sizes: HERO_SIZES,
  });
}
