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
 * Two properties worth keeping if you swap the provider:
 *
 *  1. Deterministic. The same event must always resolve to the same picture. A random
 *     image per render makes the grid flicker on every refetch and makes a card's
 *     poster disagree with the hero backdrop for the same event.
 *  2. Shared seed across crops. `eventPoster` and `eventBackdrop` use one seed, so an
 *     event's portrait poster and landscape hero are the same photograph framed
 *     differently, the way real artwork behaves.
 */

/** Swap this one line to change providers. */
const IMAGE_ORIGIN = 'https://picsum.photos/seed';

/** Namespaced so seeds can't collide with anything else using the same service. */
function seedFor(kind: string, id: number | string): string {
  return encodeURIComponent(`tb-${kind}-${id}`);
}

function imageUrl(seed: string, width: number, height: number): string {
  return `${IMAGE_ORIGIN}/${seed}/${width}/${height}`;
}

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
