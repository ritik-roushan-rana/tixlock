import { useMemo } from 'react';

import { cn } from '@/lib/utils';
import type { SeatMap } from '@/lib/api/types';
import { Skeleton } from '@/components/ui/skeleton';
import { Seat } from './Seat';
import { SeatLegend } from './SeatLegend';
import { categoryStyleFor, categoryStyleMap } from './seatState';

/**
 * Screen / stage marker.
 *
 * The reference draws this as a solid ink slab with a shallow curve on its lower
 * edge, label reversed out in cream caps. That is a deliberate change from the old
 * gradient arc with a glow beneath it: this system has no gradients and no blurs,
 * and the curve alone is enough to say "this end of the room". Depth comes from the
 * ink block against cream, not from light.
 *
 * The slab is a single filled path so it stays crisp at any width. Decorative;
 * the label text inside is the accessible content.
 */
function ScreenIndicator({ label }: { label: string }) {
  return (
    <div className="relative mx-auto w-full max-w-xl select-none">
      <svg
        viewBox="0 0 400 40"
        className="block h-10 w-full"
        aria-hidden
        preserveAspectRatio="none"
      >
        <path d="M0 0 H400 V16 Q200 40 0 16 Z" fill="hsl(var(--panel))" />
      </svg>
      <p className="eyebrow absolute inset-x-0 top-[0.5rem] text-center text-panel-foreground">
        {label}
      </p>
    </div>
  );
}

/**
 * The seat grid.
 *
 * Mobile behaviour: the grid scrolls horizontally inside its own container rather
 * than shrinking seats below a usable tap target (~28px). The row labels are
 * `sticky left-0` so you always know which row you are looking at while scrolled,
 * and the legend sits outside the scroll container so it stays visible.
 *
 * Rows are rendered exactly as the API orders them — no reordering, no grouping
 * changes. The redesign is styling plus the screen indicator and legend.
 */
export function SeatMapGrid({
  seatMap,
  selectedIds,
  recentlyChanged,
  onSelectSeat,
}: {
  seatMap: SeatMap;
  selectedIds: number[];
  recentlyChanged: Set<number>;
  onSelectSeat: (seatId: number) => void;
}) {
  const selected = new Set(selectedIds);

  // Colour assignment follows the show's pricing order so the priciest tier is not
  // arbitrarily coloured differently between two shows at the same venue.
  const categoryStyles = useMemo(
    () => categoryStyleMap(seatMap.pricing.map((tier) => tier.category)),
    [seatMap.pricing]
  );

  const screenLabel = seatMap.show.event.type === 'concert' ? 'Stage' : 'Screen';

  return (
    <div className="space-y-6">
      <ScreenIndicator label={screenLabel} />

      {/* No vignette and no glow behind the seats — this system rejects both. The
          seats sit directly on the section's tonal fill. */}
      <div className="relative">
        <div className="scrollbar-thin relative overflow-x-auto pb-2">
          <div
            // `w-max` (not just `min-w-max`) is what lets mx-auto centre the grid:
            // a plain block would stretch to the container and the rows would sit
            // hard left. With an explicit max-content width it centres when there is
            // room and still overflows into the horizontal scroll when there isn't.
            className="mx-auto flex w-max flex-col items-stretch gap-1 px-1"
            role="group"
            aria-label="Seat map. Use tab to move between seats and enter to select."
          >
            {seatMap.rows.map((row) => (
              <div key={row.row_label} className="flex items-center gap-3">
                {/* Opaque, not translucent: it sits over seats while the grid is
                    scrolled, and this system has no blurs to fall back on. */}
                <span
                  className="sticky left-0 z-10 grid w-5 shrink-0 place-items-center bg-card text-[11px] font-bold text-foreground"
                  aria-hidden
                >
                  {row.row_label}
                </span>

                {/* `flex-1 justify-center` centres shorter rows against the widest
                    one, which is what makes the block read as an auditorium rather
                    than a left-aligned table. */}
                <div className="flex flex-1 justify-center gap-1">
                  {row.seats.map((seat) => (
                    <Seat
                      key={seat.id}
                      seat={seat}
                      isSelected={selected.has(seat.id)}
                      justChanged={recentlyChanged.has(seat.id)}
                      categoryStyle={categoryStyleFor(categoryStyles, seat.category)}
                      onSelect={onSelectSeat}
                    />
                  ))}
                </div>

                {/* Trailing row label, so the far side of a wide grid is readable too.
                    Hidden on mobile, where the grid already overflows and every pixel
                    of width costs the user another swipe. */}
                <span
                  className="hidden w-5 shrink-0 place-items-center text-[11px] font-bold text-muted-foreground sm:grid"
                  aria-hidden
                >
                  {row.row_label}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Hairline, then the key — as the reference frames it. A rule is warranted
          here because the legend is a different kind of content, not more seats. */}
      <div className="border-t border-border pt-5">
        <SeatLegend pricing={seatMap.pricing} categoryStyles={categoryStyles} />
      </div>
    </div>
  );
}

export function SeatMapSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="mx-auto h-10 w-full max-w-xl" />
      <div className="space-y-1">
        {[8, 8, 10, 10, 10].map((count, rowIndex) => (
          <div key={rowIndex} className="flex items-center justify-center gap-1">
            <Skeleton className="h-4 w-5" />
            {Array.from({ length: count }).map((_, seatIndex) => (
              <Skeleton
                key={seatIndex}
                className={cn('h-seat w-seat sm:h-seat-touch sm:w-seat-touch')}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 border-t border-border pt-5">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-7 w-32" />
        ))}
      </div>
    </div>
  );
}
