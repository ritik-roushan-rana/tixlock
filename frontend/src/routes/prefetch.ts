/**
 * Route chunk warming.
 *
 * Every page is a lazy chunk, so clicking an event mounts a Suspense fallback while
 * the chunk downloads. That fallback is much shorter than the real page, which
 * collapses the layout and then restores it — measured as the dominant layout shift on
 * the event detail route: the footer went from height 0 to 70 to 0 again, contributing
 * ~0.08 CLS at 1440px and ~0.13 at 390px, more than anything the images did.
 *
 * Warming the chunk on the same pointer/focus intent that warms the hero image removes
 * the fallback from the common path entirely: by the time the click lands the module is
 * already in the registry, so the real page renders on the first commit.
 *
 * Deduplication is free here — a dynamic `import()` of the same specifier returns the
 * same promise from the module registry, and React.lazy reuses it — but the guard keeps
 * repeated hovers from even entering that machinery.
 */

const started = new Set<string>();

function once(key: string, load: () => Promise<unknown>): void {
  if (started.has(key)) return;
  started.add(key);
  // Warming must never surface as an unhandled rejection or a runtime error. If the
  // chunk fails here, the click path retries it and Suspense/LazyBoundary reports it.
  void load().catch(() => started.delete(key));
}

/** Warm the event detail page chunk. Safe to call on every hover. */
export function prefetchEventDetailRoute(): void {
  once('event-detail', () => import('@/pages/EventDetailPage'));
}

/** Test seam. */
export function resetRoutePrefetchForTests(): void {
  started.clear();
}
