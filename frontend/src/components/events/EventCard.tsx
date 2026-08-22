import { NavLink } from 'react-router-dom';
import { CalendarClock, Clapperboard, Music4 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatMoney, toMoneyOrNull } from '@/lib/money';
import { formatDateShort } from '@/lib/datetime';
import { eventPoster } from '@/lib/posters';
import { eventTheme } from '@/lib/eventTheme';
import type { EventListItem } from '@/lib/api/types';
import { Poster } from '@/components/common/Poster';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Event card.
 *
 * Structure follows the reference: 4:5 artwork, an outlined price tag pinned to the
 * corner, an Anton title in caps, a venue/date row that justifies to both edges, and
 * a rule-separated status strip. No border, no shadow, no radius — the card is
 * defined by the tonal block behind its artwork and by whitespace.
 *
 * On the status strip: the reference shows availability ("TICKETS AVAILABLE",
 * "SOLD OUT", "FEW TICKETS LEFT"). GET /events returns no seat counts — availability
 * only exists on GET /events/:id — so rendering that here would either be invented or
 * need a request per card. It shows showing count instead, which is real data from the
 * same response. Availability could move here later if the list endpoint grew a
 * summary field, but that is a backend change, not a design one.
 */
export function EventCard({ event }: { event: EventListItem }) {
  const theme = eventTheme(event.type);
  const fromPrice = toMoneyOrNull(event.from_price);
  const TypeGlyph = event.type === 'concert' ? Music4 : Clapperboard;

  return (
    <NavLink
      to={`/events/${event.id}`}
      aria-label={`${event.title} at ${event.venue_name}`}
      className="group block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
    >
      <div className="relative mb-2 aspect-[4/5] w-full overflow-hidden bg-card">
        <Poster
          src={eventPoster(event.id, 600)}
          alt={event.title}
          type={event.type}
          decorative
          sizes="(max-width: 768px) 100vw, (max-width: 1024px) 50vw, 33vw"
          className="absolute inset-0 h-full w-full transition-transform duration-500 group-hover:scale-105"
        />

        {/* Outlined tag rather than a filled one: price is information, not a signal,
            so it does not spend lime or cobalt. */}
        {fromPrice !== null ? (
          <div className="eyebrow tabular absolute right-2 top-2 z-10 border border-foreground bg-background px-2 py-1 text-foreground">
            {formatMoney(fromPrice)}
          </div>
        ) : null}

        {/* Type chip. Filled for film, outlined for live — weight, not hue. */}
        <div
          className={cn(
            'eyebrow absolute left-2 top-2 z-10 inline-flex items-center gap-1 px-2 py-1',
            theme.chip
          )}
        >
          <TypeGlyph className="h-3 w-3" aria-hidden />
          {theme.label}
        </div>
      </div>

      <div className="space-y-1">
        <h3 className="heading text-display-md uppercase transition-colors group-hover:text-muted-foreground">
          {event.title}
        </h3>

        <p className="flex items-center justify-between gap-3 text-body-sm text-muted-foreground">
          <span className="truncate">{event.venue_name}</span>
          <span className="shrink-0 tabular">
            {event.next_show_date ? formatDateShort(event.next_show_date) : 'Dates TBA'}
          </span>
        </p>

        <div className="eyebrow mt-2 flex items-center gap-1.5 border-t border-card-alt pt-2 text-muted-foreground">
          <CalendarClock className="h-3.5 w-3.5" aria-hidden />
          {event.show_count} {event.show_count === 1 ? 'showing' : 'showings'}
        </div>
      </div>
    </NavLink>
  );
}

export function EventCardSkeleton() {
  return (
    <div>
      <Skeleton className="mb-2 aspect-[4/5] w-full" />
      <div className="space-y-2">
        <Skeleton className="h-7 w-4/5" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-3 w-28" />
      </div>
    </div>
  );
}
