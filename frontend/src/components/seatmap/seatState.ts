import type { SeatMapSeat } from '@/lib/api/types';

/**
 * The six visual states a seat can be in.
 *
 * Note this is NOT the same set as the API's `seat_status`. The API describes the
 * seat; the UI has to describe the seat *relative to the viewer*, which needs two
 * extra distinctions:
 *
 *   - `selected` — tapped locally, not yet held on the server. Purely client state.
 *   - `mine`     — held by this viewer (API status `held`/`offered` + held_by_me).
 *   - `taken`    — held by somebody else. The viewer cannot tell which person, by
 *                  design, and does not need to.
 *   - `offered`  — promised to someone at the front of the waitlist queue. Split out
 *                  from `taken` so the map can explain *why* a seat that looks free
 *                  cannot be bought, instead of lumping it in with ordinary holds.
 *
 * `taken` keeps its name rather than being renamed to something tidier because
 * scripts/e2e/realtime.mjs asserts on `data-seat-state="taken"` to prove the socket
 * patching works. Renaming it would be a silent break of that check.
 */
export type SeatVisualState =
  | 'available'
  | 'selected'
  | 'mine'
  | 'taken'
  | 'offered'
  | 'booked';

export function seatVisualState(seat: SeatMapSeat, isSelected: boolean): SeatVisualState {
  if (seat.status === 'booked') return 'booked';
  // Selection wins over `mine` so that, immediately after a hold, the seats the
  // user is about to pay for read as the active thing on screen.
  if (isSelected) return 'selected';
  if (seat.held_by_me) return 'mine';
  if (seat.status === 'offered') return 'offered';
  if (seat.status === 'held') return 'taken';
  return 'available';
}

/**
 * A seat is actionable when it is free, or when it is the viewer's own hold.
 *
 * Unchanged by the redesign. Splitting `offered` out of `taken` above is a purely
 * presentational distinction — an offered seat was already unselectable here because
 * its status is neither `available` nor held by the viewer.
 */
export function isSeatSelectable(seat: SeatMapSeat): boolean {
  return seat.status === 'available' || seat.held_by_me;
}

const STATE_LABEL: Record<SeatVisualState, string> = {
  available: 'available',
  selected: 'selected',
  mine: 'held by you',
  taken: 'unavailable',
  offered: 'reserved for a waitlist offer',
  booked: 'already booked',
};

/**
 * Accessible label for a seat button.
 *
 * Deliberately never says who holds a seat — the API does not expose that and the
 * UI must not imply it. "Unavailable" is all a viewer needs.
 */
export function seatAriaLabel(
  seat: SeatMapSeat,
  state: SeatVisualState,
  formattedPrice: string | null
): string {
  const where = `Row ${seat.row_label}, seat ${seat.seat_number}`;
  const price = formattedPrice ? `, ${formattedPrice}` : '';
  return `${where}, ${seat.category}${price}, ${STATE_LABEL[state]}`;
}

/**
 * Swatch classes for the state key, mirroring the seat fills in Seat.tsx.
 *
 * The labels "Available" and "Booked" are asserted by scripts/e2e/journey.mjs to
 * prove the legend rendered — don't reword those two.
 */
export const SEAT_LEGEND: Array<{
  state: SeatVisualState;
  label: string;
  className: string;
}> = [
  { state: 'available', label: 'Available', className: 'border border-border-strong bg-seat-available' },
  { state: 'selected', label: 'Selected', className: 'bg-seat-selected' },
  { state: 'mine', label: 'Held by you', className: 'border border-border-strong bg-seat-mine' },
  { state: 'taken', label: 'Taken', className: 'bg-seat-taken' },
  { state: 'offered', label: 'Waitlist offer', className: 'hatch border border-border-strong' },
  { state: 'booked', label: 'Booked', className: 'bg-seat-booked' },
];

/* ---------------------------------------------------------------------------
 * Seat categories
 * ------------------------------------------------------------------------- */

/**
 * Per-category tinting for available seats.
 *
 * Categories are free-text in the database ('Premium', 'Standard', …), so colours are
 * assigned by the category's position in the show's pricing list rather than by name.
 * That keeps it working for any venue without a hard-coded name map.
 *
 * The tint is deliberately faint. Seat *state* is the information that matters and
 * must stay dominant; category is a secondary cue that lets you see at a glance where
 * the premium block sits. Every non-available state overrides the tint completely.
 *
 * Classes are written out in full because Tailwind's JIT cannot see interpolated
 * class names and would purge them.
 */
export interface CategoryStyle {
  /** Applied to an available seat chip. */
  chip: string;
  /** Solid swatch for the legend. */
  swatch: string;
  /** Text colour for the legend price. */
  text: string;
}

/**
 * Category tints are MONOCHROME, and that is a deliberate constraint.
 *
 * The old set used sky / emerald / fuchsia / orange. In this system colour is a
 * functional layer only — lime is the primary path, cobalt is selection, red is
 * failure — so spending four more hues on "which price tier is this" would drown
 * the three signals that actually change what a user can do.
 *
 * Being able to see where the premium block sits is still real, useful information,
 * so it is kept and expressed tonally instead: available seats step through ink at
 * increasing alpha, lightest tier first. That survives greyscale, reads as a block
 * at a glance, and leaves the signal colours meaning exactly one thing each.
 *
 * Two constraints bound the range:
 *
 *   - The darkest step must keep a full-ink seat number above AA. At 42% ink over
 *     cream the number still measures roughly 6:1, so it holds.
 *   - No step may drift close to `--seat-taken` (#828a87, about 55% ink), or an
 *     available premium seat would read as somebody else's hold. 42% is the last
 *     step that stays clearly lighter, and the 1px ink border every available seat
 *     carries — which `taken` deliberately lacks — is the backstop.
 *
 * An earlier pass used 8/16/24% and the two-tier case was indistinguishable both on
 * the map and in the legend swatches, which made the cue worthless.
 *
 * Classes are written out in full because Tailwind's JIT cannot see interpolated
 * class names and would purge them.
 */
const CATEGORY_STYLES: CategoryStyle[] = [
  {
    chip: 'bg-seat-available hover:border-cobalt hover:bg-cobalt/10',
    swatch: 'bg-seat-available border border-border-strong',
    text: 'text-foreground',
  },
  {
    chip: 'bg-foreground/[0.14] hover:border-cobalt hover:bg-cobalt/10',
    swatch: 'bg-foreground/[0.14] border border-border-strong',
    text: 'text-foreground',
  },
  {
    chip: 'bg-foreground/[0.28] hover:border-cobalt hover:bg-cobalt/10',
    swatch: 'bg-foreground/[0.28] border border-border-strong',
    text: 'text-foreground',
  },
  {
    chip: 'bg-foreground/[0.42] hover:border-cobalt hover:bg-cobalt/10',
    swatch: 'bg-foreground/[0.42] border border-border-strong',
    text: 'text-foreground',
  },
];

/** Neutral fallback past the end of the palette. */
const CATEGORY_FALLBACK: CategoryStyle = {
  chip: 'bg-seat-available hover:border-cobalt hover:bg-cobalt/10',
  swatch: 'bg-seat-available border border-border-strong',
  text: 'text-foreground',
};

/**
 * Builds category -> style from the show's pricing order.
 *
 * Returned as a plain object so it can be computed once per render of the grid and
 * read by both the seats and the legend, keeping the two in agreement.
 */
export function categoryStyleMap(
  categories: readonly string[]
): Record<string, CategoryStyle> {
  return Object.fromEntries(
    categories.map((category, index) => [category, CATEGORY_STYLES[index] ?? CATEGORY_FALLBACK])
  );
}

export function categoryStyleFor(
  map: Record<string, CategoryStyle>,
  category: string
): CategoryStyle {
  return map[category] ?? CATEGORY_FALLBACK;
}
