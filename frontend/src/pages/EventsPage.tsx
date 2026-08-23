import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarX2, Search, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { eventsApi } from '@/lib/api/endpoints';
import { queryKeys } from '@/lib/queryKeys';
import { EVENT_TYPES, type EventFilters, type EventType } from '@/lib/api/types';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState, ErrorState } from '@/components/common/states';
import { EventCard, EventCardSkeleton } from '@/components/events/EventCard';
import {
  FeaturedEvent,
  FeaturedEventSkeleton,
  pickFeatured,
} from '@/components/events/FeaturedEvent';

const TYPE_LABEL: Record<EventType, string> = {
  movie: 'Movie',
  concert: 'Concert',
};

/**
 * Event browse.
 *
 * Filters live in the URL rather than component state so a filtered view is
 * shareable and survives a refresh or a back-navigation from an event detail page.
 *
 * That is also what let the search box move up into the header without either side
 * knowing about the other: AppShell's field writes `q`, this page reads it. There is
 * no shared store and no second request. The read is debounced, so a term arriving a
 * keystroke at a time is still one call.
 *
 * The redesign changed only presentation: the same `filters` object is built from the
 * same URL params and handed to the same query key and endpoint. The type filter is a
 * hard-edged chip group writing the identical `type` param a `<Select>` used to, and
 * the hero is derived client-side from the list response with no extra request.
 *
 * Deliberately absent: the reference's "LOAD MORE" button. `EventFilters` has no
 * limit or offset and GET /events returns the full set, so the control would be
 * decorative. Adding real pagination is a backend change.
 */
export default function EventsPage() {
  const [params, setParams] = useSearchParams();

  const type = (params.get('type') as EventType | null) ?? undefined;
  const dateFrom = params.get('date_from') ?? undefined;
  const dateTo = params.get('date_to') ?? undefined;
  const urlQuery = params.get('q') ?? '';

  // The search box lives in the header now, so `q` arrives already in the URL and
  // there is no local mirror of it left to hold. Debouncing moved with it: the header
  // writes the param per keystroke, and this defers the *request* so a four-letter
  // word is one call rather than four.
  const debouncedSearch = useDebouncedValue(urlQuery, 300);

  const filters: EventFilters = useMemo(
    () => ({
      ...(type ? { type } : {}),
      ...(dateFrom ? { date_from: dateFrom } : {}),
      ...(dateTo ? { date_to: dateTo } : {}),
      ...(debouncedSearch.trim() ? { q: debouncedSearch.trim() } : {}),
    }),
    [type, dateFrom, dateTo, debouncedSearch]
  );

  const query = useQuery({
    queryKey: queryKeys.events.list(filters),
    queryFn: () => eventsApi.list(filters),
  });

  const update = (key: string, value: string | undefined) => {
    const nextParams = new URLSearchParams(params);
    if (!value) nextParams.delete(key);
    else nextParams.set(key, value);
    setParams(nextParams, { replace: true });
  };

  // Drops `q` along with the rest, which the header field picks up: it mirrors the
  // param, so clearing here visibly empties the box up in the bar.
  const clearAll = () => setParams(new URLSearchParams(), { replace: true });

  const activeFilterCount = [type, dateFrom, dateTo, urlQuery].filter(Boolean).length;

  // The API rejects a reversed range with a 400, so catch it before requesting.
  const rangeInvalid = Boolean(dateFrom && dateTo && dateFrom > dateTo);

  const events = query.data;
  // Spotlight only an unfiltered browse. Once someone is narrowing results, a banner
  // for one of them is noise between them and the grid.
  const featured = activeFilterCount === 0 && events ? pickFeatured(events) : null;
  const gridEvents = featured ? events!.filter((event) => event.id !== featured.id) : events;

  return (
    <div className="space-y-lg md:space-y-xl">
      {/* --- Hero ----------------------------------------------------------- */}
      {rangeInvalid ? null : query.isLoading ? (
        <FeaturedEventSkeleton />
      ) : featured ? (
        <FeaturedEvent event={featured} />
      ) : null}

      {/* --- Filters ---------------------------------------------------------
          One tonal block containing every control, per the reference. Sectioning
          by surface shift rather than by a rule or a card.

          Search is not among them any more — it is in the header, so it is reachable
          from a seat map or a ticket list too. What it wrote is what this block still
          reads, so an active term shows up here in the term chip and the clear count. */}
      <section className="bg-card p-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Chip group. Scrolls horizontally on mobile instead of wrapping, so the
              filter row stays one line tall. */}
          <div
            role="group"
            aria-label="Filter by type"
            className="scrollbar-thin flex gap-2 overflow-x-auto pb-1 md:pb-0"
          >
            <TypeChip active={!type} onClick={() => update('type', undefined)}>
              All
            </TypeChip>
            {EVENT_TYPES.map((option) => (
              <TypeChip
                key={option}
                active={type === option}
                onClick={() => update('type', option)}
              >
                {TYPE_LABEL[option]}
              </TypeChip>
            ))}
          </div>

          {/* The search term, echoed as a removable chip. Without it the page would
              silently show a filtered list while the only evidence sat in the header
              field, which is easy to miss on a narrow screen where it is behind an
              icon. Removing it clears just `q` and leaves the other filters alone. */}
          {urlQuery ? (
            <button
              type="button"
              onClick={() => update('q', undefined)}
              aria-label={`Clear search: ${urlQuery}`}
              className="eyebrow inline-flex max-w-full items-center gap-1.5 border border-border-strong bg-background px-2 py-1.5 text-foreground transition-colors hover:bg-card-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate normal-case tracking-normal">{urlQuery}</span>
              <X className="h-3.5 w-3.5 shrink-0" aria-hidden />
            </button>
          ) : null}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-card-alt pt-2">
          <Label htmlFor="filter-from" className="eyebrow text-muted-foreground">
            From
          </Label>
          <Input
            id="filter-from"
            type="date"
            value={dateFrom ?? ''}
            max={dateTo}
            onChange={(e) => update('date_from', e.target.value || undefined)}
            className="h-9 w-[9rem] border border-border-strong bg-background px-2 text-body-sm focus-visible:border-2 focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <Label htmlFor="filter-to" className="eyebrow text-muted-foreground">
            To
          </Label>
          <Input
            id="filter-to"
            type="date"
            value={dateTo ?? ''}
            min={dateFrom}
            onChange={(e) => update('date_to', e.target.value || undefined)}
            className="h-9 w-[9rem] border border-border-strong bg-background px-2 text-body-sm focus-visible:border-2 focus-visible:ring-0 focus-visible:ring-offset-0"
          />

          {activeFilterCount > 0 ? (
            <button
              type="button"
              onClick={clearAll}
              className="eyebrow ml-auto inline-flex items-center gap-1 text-muted-foreground underline decoration-1 underline-offset-4 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              Clear {activeFilterCount}
            </button>
          ) : null}

          {events && !query.isLoading ? (
            <p
              className={cn(
                'eyebrow tabular text-muted-foreground',
                activeFilterCount > 0 ? '' : 'ml-auto'
              )}
            >
              {events.length} {events.length === 1 ? 'event' : 'events'}
              {query.isFetching ? ' · updating' : ''}
            </p>
          ) : null}
        </div>
      </section>

      {/* --- What's on ------------------------------------------------------ */}
      <section aria-labelledby="whats-on" className="space-y-md">
        <h1 id="whats-on" className="heading text-display-lg uppercase">
          What&rsquo;s on
        </h1>

        {rangeInvalid ? (
          <ErrorState
            compact
            error={new Error('The "From" date is after the "To" date. Adjust the range.')}
          />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.isLoading ? (
          /* One live region on the container, not on each card: `Skeleton` is
             aria-hidden, so without this a screen reader hears nothing at all while
             the list loads, and six announcements would be worse than none. */
          <div
            role="status"
            aria-live="polite"
            className="grid grid-cols-1 gap-lg md:grid-cols-2 lg:grid-cols-3"
          >
            <span className="sr-only">Loading events</span>
            {Array.from({ length: 6 }).map((_, i) => (
              <EventCardSkeleton key={i} />
            ))}
          </div>
        ) : gridEvents && gridEvents.length === 0 ? (
          <EmptyState
            icon={<CalendarX2 className="h-5 w-5" />}
            title={
              activeFilterCount > 0 ? 'No events match these filters' : 'No events scheduled yet'
            }
            description={
              activeFilterCount > 0
                ? 'Try widening your date range or clearing the search.'
                : 'Only events with at least one scheduled showing appear here.'
            }
            action={
              activeFilterCount > 0 ? (
                <Button variant="outline" onClick={clearAll}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-lg md:grid-cols-2 lg:grid-cols-3">
            {gridEvents?.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Filter chip.
 *
 * Active is a solid ink block; inactive is an ink outline. Same two colours, inverted
 * — no signal colour spent on a filter, which is navigation rather than status.
 */
function TypeChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'eyebrow whitespace-nowrap px-4 py-2.5 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card',
        active
          ? 'bg-foreground text-background'
          : 'border border-border-strong text-foreground hover:bg-card-alt'
      )}
    >
      {children}
    </button>
  );
}
