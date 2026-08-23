import { NavLink } from 'react-router-dom';
import { ArrowRight, CalendarDays, MapPin, Sparkle } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatMoney, toMoneyOrNull } from '@/lib/money';
import { formatDateShort } from '@/lib/datetime';
import { eventBackdrop, eventBackdropSrcSet, preloadEventHero } from '@/lib/posters';
import { prefetchEventDetailRoute } from '@/routes/prefetch';
import { eventTheme } from '@/lib/eventTheme';
import type { EventListItem } from '@/lib/api/types';
import { Poster } from '@/components/common/Poster';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Picks the event to spotlight.
 *
 * The backend has no `featured` flag and adding one is out of scope for a design
 * pass, so "soonest upcoming" stands in for editorial curation: it is the most
 * useful thing to put in front of a browsing customer, and it is derived entirely
 * from data the list endpoint already returns. Events with no scheduled show sort
 * last, and the first result is the fallback.
 *
 * Pure function over the existing response. No extra request, no API change.
 */
export function pickFeatured(events: readonly EventListItem[]): EventListItem | null {
  if (events.length === 0) return null;

  const dated = events.filter((event) => event.next_show_date !== null);
  if (dated.length === 0) return events[0];

  return dated.reduce((soonest, candidate) =>
    // ISO dates compare correctly as strings.
    (candidate.next_show_date as string) < (soonest.next_show_date as string) ? candidate : soonest
  );
}

export function FeaturedEvent({ event }: { event: EventListItem }) {
  const theme = eventTheme(event.type);
  const fromPrice = toMoneyOrNull(event.from_price);

  /** Chunk + hero, same as the grid cards. See EventCard for why the chunk matters. */
  const warmDetail = () => {
    prefetchEventDetailRoute();
    preloadEventHero(event.id);
  };

  return (
    <section
      aria-labelledby="featured-title"
      /* Sharp, borderless, full-bleed within the frame. Depth comes from the tonal
         step to card-alt behind the image, not from a shadow. */
      className="group relative isolate h-[60vh] w-full overflow-hidden bg-card-alt md:h-[70vh]"
    >
      <Poster
        src={eventBackdrop(event.id, 1600)}
        srcSet={eventBackdropSrcSet(event.id)}
        alt={event.title}
        type={event.type}
        decorative
        priority
        sizes="100vw"
        className="absolute inset-0 h-full w-full"
      />

      {/*
        Single scrim from the ink panel colour. One overlay, not four — the
        reductionist pillar: if it doesn't serve legibility, it's removed. Weighted to
        the lower half, where the copy sits, so the artwork above it keeps its detail
        instead of going muddy under a full-height wash.

        This carries the hero's legibility on its own now that the artwork renders in
        full colour with no `multiply` blend damping it. The mid stop was /35 at 45%,
        which left the 80px Anton title at a measured worst case of 3.06:1 against a
        3.0 requirement — passing, but on a photograph chosen by a seeded placeholder
        service, so the next featured event could just as easily land under it.
        Strengthening the mid stop buys real headroom instead of relying on the luck
        of a dark image. Verified by sampling painted pixels, not tokens.
      */}
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-t from-panel via-panel/65 via-50% to-transparent"
      />

      <div className="absolute bottom-0 left-0 w-full p-6 text-panel-foreground md:p-8 lg:p-16">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {/* Lime is the system's "most important thing on screen" marker. The hero
              is exactly that, so FEATURED earns it. Ink text on lime is 12.95:1. */}
          <span className="eyebrow inline-flex items-center gap-1.5 bg-lime px-2 py-1 text-lime-foreground">
            <Sparkle className="h-3.5 w-3.5" aria-hidden />
            Featured
          </span>
          <span className={cn('eyebrow inline-flex items-center px-2 py-1', theme.chipOnImage)}>
            {theme.label}
          </span>
        </div>

        <h2
          id="featured-title"
          className="heading mb-2 max-w-4xl text-display-hero uppercase text-panel-foreground"
        >
          {event.title}
        </h2>

        {event.description ? (
          <p className="mb-6 max-w-xl text-body-md text-panel-foreground/90">
            {event.description}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          {/* The one lime action on this screen. Uses the primitive's `lime` variant
              rather than inline colour classes, so the rule stays enforceable. */}
          <Button asChild variant="lime" size="xl" className="focus-visible:ring-offset-panel">
            {/* Same intent warm as the grid cards. The hero here is 100vw while the
                detail hero is 66vw on desktop, so they resolve to different candidates
                and this is not redundant. */}
            <NavLink
              to={`/events/${event.id}`}
              onPointerEnter={warmDetail}
              onFocus={warmDetail}
            >
              Get tickets
              <ArrowRight className="h-4 w-4" aria-hidden />
            </NavLink>
          </Button>

          <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-body-sm text-panel-foreground/90">
            <div className="flex items-center gap-1.5">
              <MapPin className="h-4 w-4 shrink-0" aria-hidden />
              <dd>{event.venue_name}</dd>
            </div>
            <div className="flex items-center gap-1.5">
              <CalendarDays className="h-4 w-4 shrink-0" aria-hidden />
              <dd>
                {event.next_show_date ? formatDateShort(event.next_show_date) : 'Dates TBA'}
              </dd>
            </div>
            {fromPrice !== null ? (
              <dd className="tabular font-semibold text-panel-foreground">
                From {formatMoney(fromPrice)}
              </dd>
            ) : null}
          </dl>
        </div>
      </div>
    </section>
  );
}

export function FeaturedEventSkeleton() {
  return (
    <div className="h-[60vh] w-full bg-card-alt md:h-[70vh]">
      <div className="flex h-full flex-col justify-end gap-4 p-6 md:p-8 lg:p-16">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-16 w-[min(38rem,85%)]" />
        <Skeleton className="h-4 w-[min(30rem,90%)]" />
        <Skeleton className="h-14 w-44" />
      </div>
    </div>
  );
}
