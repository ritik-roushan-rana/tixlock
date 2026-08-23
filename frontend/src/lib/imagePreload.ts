/**
 * Warm an image into the browser cache before the element that needs it exists.
 *
 * Why this is needed at all: the event hero `<img>` is not in the DOM until
 * `GET /events/:id` resolves, so on a cold navigation the request chain is
 * serialised — route chunk, then API round trip, then render, and only then does the
 * browser discover the `src` and start DNS + TLS + a 302 + the download. `priority`
 * and `fetchPriority="high"` on the element cannot help with that; they order
 * requests, they do not make one start earlier. Warming on intent (pointer or focus
 * on a card) moves the whole image chain to run *in parallel with* the API request
 * instead of after it.
 *
 * The duplicate-request trap, and how this avoids it:
 *
 * A responsive `<img>` picks one candidate from `srcSet` using `sizes`, the viewport
 * and DPR. Preloading a single hard-coded URL would warm a *different* URL from the
 * one the element later selects, so the naive version of this doubles the requests
 * rather than removing a delay. `HTMLImageElement` runs the identical selection
 * algorithm, so assigning `sizes` before `srcset` — order matters, the candidate is
 * chosen when `srcset` is set — makes the preload resolve to exactly the URL the real
 * element will ask for. It then hits the memory cache and issues no second request.
 */

/**
 * URLs already warmed this session.
 *
 * Hovering a grid re-fires pointerenter constantly; without this, each pass would
 * construct another Image and re-enter the cache lookup. Cheap insurance, and it also
 * makes the "no duplicate requests" property testable.
 */
const warmed = new Set<string>();

export interface PreloadOptions {
  /** Candidate set, identical to the one the real element renders with. */
  srcSet?: string;
  /** Layout hint, identical to the real element's. Applied before `srcSet`. */
  sizes?: string;
}

/**
 * Start fetching an image at low priority. Returns true if a fetch was started,
 * false when this exact source was already warmed.
 *
 * Never throws and never rejects: a failed warm is not an error, the real `<img>`
 * will surface it through its own `onError`.
 */
export function preloadImage(src: string, { srcSet, sizes }: PreloadOptions = {}): boolean {
  if (typeof window === 'undefined' || !src) return false;

  // Key on the whole candidate set: the same `src` under a different `srcSet` can
  // resolve to a different URL, so `src` alone would wrongly report a hit.
  const key = `${src}|${srcSet ?? ''}|${sizes ?? ''}`;
  if (warmed.has(key)) return false;
  warmed.add(key);

  const img = new Image();
  // Warming is speculative, so it must never compete with what the current page is
  // already fetching. `low` is exactly this case: useful soon, not needed now.
  img.fetchPriority = 'low';
  img.decoding = 'async';
  if (sizes) img.sizes = sizes;
  if (srcSet) img.srcset = srcSet;
  img.src = src;

  return true;
}

/** Test seam. Production code has no reason to call this. */
export function resetPreloadCacheForTests(): void {
  warmed.clear();
}
