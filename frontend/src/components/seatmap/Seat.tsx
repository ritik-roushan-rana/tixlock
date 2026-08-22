import { memo } from 'react';
import { Check, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatMoney, toMoneyOrNull } from '@/lib/money';
import type { SeatMapSeat } from '@/lib/api/types';
import {
  isSeatSelectable,
  seatAriaLabel,
  seatVisualState,
  type CategoryStyle,
  type SeatVisualState,
} from './seatState';

/**
 * Seat styling by state.
 *
 * Sharp squares, 1px ink borders, no radius and no glow — the reference draws seats
 * as a dense matrix of hard squares, and the shape language is 0px throughout.
 *
 * Each state still differs in fill *and* in at least one of border, glyph or
 * pattern, so none of them depend on hue alone:
 *
 *   available — light fill + 1px ink border, tier tone from the category tint
 *   selected  — solid cobalt + white tick. Cobalt is the system's selection signal.
 *   mine      — solid lime + ink border + tick, flashing its border. Lime marks the
 *               one thing that matters most on screen, and a live hold is it.
 *   taken      — flat grey, no border, no glyph. Not a seat you can have.
 *   offered   — ink diagonal hatch + ink border. A pattern, so it survives greyscale.
 *   booked    — solid ink + cream X. The heaviest thing on the map, and inert.
 *
 * Lime and cobalt both carry a glyph as well as a fill, which is what keeps
 * "selected" and "held by you" distinguishable without relying on colour vision.
 */
const STATE_CLASSES: Record<SeatVisualState, string> = {
  // `available` intentionally omits its fill here — the category tint supplies it.
  available: 'border border-border-strong cursor-pointer',
  selected: 'border border-border-strong bg-seat-selected text-cobalt-foreground cursor-pointer',
  mine: 'border-2 border-border-strong bg-seat-mine text-foreground cursor-pointer animate-hold-flash',
  taken: 'border border-transparent bg-seat-taken text-transparent cursor-not-allowed',
  offered: 'hatch border border-border-strong bg-transparent text-transparent cursor-not-allowed',
  booked: 'border border-border-strong bg-seat-booked text-background cursor-not-allowed',
};

/**
 * A single seat.
 *
 * Memoised on purpose: a 46-seat show is fine either way, but a 500-seat venue
 * re-rendering every seat on each socket event or hover would be visible. The
 * comparator below is what makes the memo effective.
 */
export const Seat = memo(
  function Seat({
    seat,
    isSelected,
    justChanged,
    categoryStyle,
    onSelect,
  }: {
    seat: SeatMapSeat;
    isSelected: boolean;
    /** Set briefly after a socket update so the seat can animate. */
    justChanged: boolean;
    categoryStyle: CategoryStyle;
    onSelect: (seatId: number) => void;
  }) {
    const state = seatVisualState(seat, isSelected);
    const selectable = isSeatSelectable(seat);
    const price = toMoneyOrNull(seat.price);
    const label = seatAriaLabel(seat, state, price === null ? null : formatMoney(price));

    return (
      <button
        type="button"
        disabled={!selectable}
        aria-label={label}
        aria-pressed={isSelected}
        title={label}
        // Stable hook for end-to-end tests, which need to address seats without
        // depending on visual classes or label wording.
        data-seat-id={seat.id}
        data-seat-state={state}
        onClick={() => selectable && onSelect(seat.id)}
        className={cn(
          // 28px, rising to 32px on a touch-sized viewport. The reference draws 16px
          // squares, which fails WCAG 2.5.8's 24px minimum target — so the shape is
          // borrowed and the size is not.
          'relative grid h-seat w-seat shrink-0 place-items-center rounded-none text-[10px] font-bold',
          'transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          'sm:h-seat-touch sm:w-seat-touch sm:text-[11px]',
          STATE_CLASSES[state],
          // Category tint applies only to available seats; every other state is a
          // deliberate, unambiguous signal that must not be diluted.
          state === 'available' && categoryStyle.chip,
          justChanged && 'animate-seat-pop'
        )}
      >
        {state === 'selected' || state === 'mine' ? (
          <Check className="h-4 w-4" strokeWidth={3} aria-hidden />
        ) : state === 'booked' ? (
          <X className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
        ) : state === 'available' ? (
          seat.seat_number
        ) : null}
      </button>
    );
  },
  (prev, next) =>
    prev.seat.id === next.seat.id &&
    prev.seat.status === next.seat.status &&
    prev.seat.held_by_me === next.seat.held_by_me &&
    prev.seat.price === next.seat.price &&
    prev.isSelected === next.isSelected &&
    prev.justChanged === next.justChanged &&
    prev.categoryStyle === next.categoryStyle
);
