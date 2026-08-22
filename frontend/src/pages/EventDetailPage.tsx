import { useMemo } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CalendarX2, Clapperboard, MapPin, Music4, User } from 'lucide-react';

import { cn } from '@/lib/utils';
import { eventsApi } from '@/lib/api/endpoints';
import { queryKeys } from '@/lib/queryKeys';
import { formatMoney, toMoneyOrNull } from '@/lib/money';
import { formatDate, formatDateShort, formatTime, isPast } from '@/lib/datetime';
import { eventBackdrop, venuePhoto } from '@/lib/posters';
import { eventTheme } from '@/lib/eventTheme';
import type { EventShow } from '@/lib/api/types';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Poster } from '@/components/common/Poster';
import { EmptyState, ErrorState } from '@/components/common/states';

/**
 * Event detail and showing selection.
 *
 * Two columns: editorial left (artwork, title, copy), transactional right (showtimes,
 * prices, venue). The right column is sticky on desktop so the booking path stays
 * reachable while reading a long description.
 *
 * Showings are grouped by date so a multi-day run reads as a schedule rather than a
 * flat list. Past showings are collapsed rather than hidden — an event page that
 * silently drops dates looks broken to someone who bookmarked it.
 *
 * Redesign only: the same query, the same `upcoming`/`past`/`byDate` derivations, and
 * the same one-click navigation to /shows/:id. No selection state was introduced —
 * each showtime is still a direct link, so booking is one click, not two.
 */
export default function EventDetailPage() {
  const { eventId: eventIdParam } = useParams<{ eventId: string }>();
  const eventId = Number(eventIdParam);

  const query = useQuery({
    queryKey: queryKeys.events.detail(eventId),
    queryFn: () => eventsApi.get(eventId),
    enabled: Number.isFinite(eventId) && eventId > 0,
  });

  const { upcoming, past } = useMemo(() => {
    const shows = query.data?.shows ?? [];
    return {
      upcoming: shows.filter((show) => !isPast(show.date, show.time)),
      past: shows.filter((show) => isPast(show.date, show.time)),
    };
  }, [query.data]);

  const byDate = useMemo(() => {
    const groups = new Map<string, EventShow[]>();
    for (const show of upcoming) {
      const existing = groups.get(show.date);
      if (existing) existing.push(show);
      else groups.set(show.date, [show]);
    }
    return [...groups.entries()];
  }, [upcoming]);

  if (!Number.isFinite(eventId) || eventId <= 0) {
    return <ErrorState error={new Error('That event link is not valid.')} />;
  }

  if (query.isError) {
    return (
      <div className="space-y-md">
        <BackLink />
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }

  if (query.isLoading || !query.data) {
    return (
      <div className="space-y-md">
        <BackLink />
        <div className="grid gap-lg lg:grid-cols-[1fr_22rem]">
          <div className="space-y-4">
            <Skeleton className="aspect-[16/10] w-full" />
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-16 w-4/5" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <Skeleton className="h-80 w-full" />
        </div>
      </div>
    );
  }

  const event = query.data;
  const theme = eventTheme(event.type);
  const TypeGlyph = event.type === 'concert' ? Music4 : Clapperboard;
  // Pricing is per-show; the first show stands in for the headline tier list, and the
  // caveat below the list says so rather than implying it is universal.
  const allPricing = event.shows[0]?.pricing ?? [];
  // The soonest upcoming showing is the primary path, so it gets the one lime action.
  const nextShow = upcoming[0] ?? null;

  return (
    <div className="space-y-md">
      <BackLink />

      <div className="grid gap-lg lg:grid-cols-[1fr_22rem]">
        {/* --- Editorial column --------------------------------------------- */}
        <div className="space-y-md">
          <Poster
            src={eventBackdrop(event.id, 1200)}
            alt={event.title}
            type={event.type}
            priority
            sizes="(max-width: 1024px) 100vw, 66vw"
            className="aspect-[16/10] w-full"
          />

          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('eyebrow inline-flex items-center gap-1 px-2 py-1', theme.chip)}>
              <TypeGlyph className="h-3 w-3" aria-hidden />
              {theme.label}
            </span>
            <span className="eyebrow inline-flex items-center gap-1 border border-border-strong px-2 py-1">
              {/* EventDetail omits show_count (it ships the full shows array instead),
                  so this counts the array rather than reading a summary field. */}
              {event.shows.length} {event.shows.length === 1 ? 'showing' : 'showings'}
            </span>
          </div>

          <h1 className="heading text-display-hero uppercase">{event.title}</h1>

          <div className="flex flex-wrap items-center gap-x-lg gap-y-2 text-body-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="h-4 w-4" aria-hidden />
              {event.venue_name}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <User className="h-4 w-4" aria-hidden />
              {event.organiser_name}
            </span>
          </div>

          {event.description ? (
            <>
              {/* Hairline rule, the one place this system permits a divider. */}
              <hr className="border-t border-border" />
              <p className="max-w-2xl text-body-md">{event.description}</p>
            </>
          ) : null}
        </div>

        {/* --- Transactional column ----------------------------------------- */}
        <div className="space-y-md lg:sticky lg:top-24 lg:self-start">
          <section aria-labelledby="showtimes" className="bg-card p-4">
            <h2 id="showtimes" className="eyebrow mb-3 text-muted-foreground">
              Select showtime
            </h2>

            {byDate.length === 0 ? (
              <EmptyState
                icon={<CalendarX2 className="h-5 w-5" />}
                title="No upcoming showings"
                description={
                  past.length > 0
                    ? 'Every showing for this event has already taken place.'
                    : 'The organiser has not scheduled any showings yet.'
                }
                action={
                  <Button variant="outline" asChild>
                    <NavLink to="/events">Browse other events</NavLink>
                  </Button>
                }
              />
            ) : (
              <div className="space-y-4">
                {byDate.map(([date, shows]) => (
                  <div key={date}>
                    <h3 className="eyebrow mb-1.5 text-muted-foreground">{formatDate(date)}</h3>
                    <ul className="divide-y divide-card-alt">
                      {shows.map((show) => (
                        <li key={show.id}>
                          <ShowRow show={show} primary={show.id === nextShow?.id} />
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}

            {allPricing.length > 0 ? (
              <div className="mt-4 border-t border-border pt-4">
                <h2 className="eyebrow mb-2 text-muted-foreground">Categories</h2>
                <ul className="divide-y divide-card-alt">
                  {allPricing.map((tier) => {
                    const price = toMoneyOrNull(tier.price);
                    return (
                      <li
                        key={tier.category}
                        className="flex items-baseline justify-between gap-3 py-2"
                      >
                        <span className="text-body-sm font-semibold">{tier.category}</span>
                        <span className="tabular text-body-sm">
                          {price === null ? '—' : formatMoney(price)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-2 text-body-sm text-muted-foreground">
                  Prices can vary between showings.
                </p>
              </div>
            ) : null}
          </section>

          {past.length > 0 ? (
            <details className="border border-border p-3">
              <summary className="eyebrow cursor-pointer text-muted-foreground">
                {past.length} past showing{past.length === 1 ? '' : 's'}
              </summary>
              <ul className="mt-2 space-y-1 text-body-sm text-muted-foreground">
                {past.map((show) => (
                  <li key={show.id} className="tabular">
                    {formatDateShort(show.date)} · {formatTime(show.time)} — {show.booked_seats}/
                    {show.total_seats} sold
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <section aria-labelledby="venue" className="bg-card p-4">
            <h2 id="venue" className="eyebrow mb-3 text-muted-foreground">
              Venue
            </h2>
            <Poster
              src={venuePhoto(event.venue_id, 640)}
              alt={`${event.venue_name} exterior`}
              type={event.type}
              decorative
              sizes="22rem"
              className="mb-2 aspect-[4/3] w-full"
            />
            <p className="text-body-sm font-semibold">{event.venue_name}</p>
            <p className="text-body-sm text-muted-foreground">{event.venue_address}</p>
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * One showtime.
 *
 * `primary` marks the soonest upcoming showing, which is the single most important
 * action on this screen and therefore the only lime element. Every other row is an
 * outlined secondary. Hover raises a 4px cobalt left edge, the spec's selection cue.
 *
 * A sold-out showing still links through: the seat map is where a customer joins the
 * waitlist, so blocking navigation would hide that entry point entirely.
 */
function ShowRow({ show, primary }: { show: EventShow; primary: boolean }) {
  const soldOut = show.available_seats === 0;
  const nearlyGone = !soldOut && show.available_seats <= Math.max(3, show.total_seats * 0.1);

  return (
    <NavLink
      to={`/shows/${show.id}`}
      className={cn(
        'flex items-center justify-between gap-3 border-l-4 px-3 py-2.5 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        primary
          ? 'border-l-lime bg-lime text-lime-foreground hover:bg-lime-dim'
          : 'border-l-transparent hover:border-l-cobalt hover:bg-card-alt'
      )}
    >
      <span className="min-w-0">
        <span className="tabular block text-body-md font-semibold">{formatTime(show.time)}</span>
        <span
          className={cn(
            'eyebrow block',
            primary
              ? 'text-lime-foreground/80'
              : soldOut
                ? 'text-destructive'
                : nearlyGone
                  ? 'text-foreground'
                  : 'text-muted-foreground'
          )}
        >
          {soldOut ? 'Sold out · join waitlist' : `${show.available_seats} left`}
        </span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
    </NavLink>
  );
}

function BackLink() {
  return (
    <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
      <NavLink to="/events">
        <ArrowLeft /> Back to events
      </NavLink>
    </Button>
  );
}
