import type { EventType } from '@/lib/api/types';

/**
 * Per-event-type visual treatment, "Quiet Brutalism" edition.
 *
 * The governing rule of this design system is that colour is a signal — reserved for
 * status, the primary path and urgency — and never decorative. That rules out the
 * previous approach of giving each event type its own accent hue: spending cobalt or
 * lime on "this is a film" would devalue the same colours where they mean "selected"
 * or "confirm".
 *
 * So type is differentiated STRUCTURALLY instead: a filled ink chip for film, an
 * outlined chip for live music. Same two colours, different weight. It reads at a
 * glance across a grid, survives greyscale, and costs no signal.
 *
 * Field names are unchanged from the previous system so consumers that have not been
 * reworked yet keep compiling. Gradient and glow fields are flattened to inert values
 * rather than deleted, and get removed as each screen is reworked.
 */
export interface EventTheme {
  /** Human label, used in the type chip. */
  label: string;
  /** Accent edge. Ink for both types; cobalt is reserved for selection. */
  edge: string;
  /** Flattened: this system has no gradient washes. */
  wash: string;
  /** Border colour on hover. */
  hoverBorder: string;
  /** Flattened: this system has no glows. */
  hoverGlow: string;
  /** Text colour for labels and prices. */
  text: string;
  /** Title colour on card hover. */
  hoverText: string;
  /** Chip on a solid surface. Filled vs outlined is the type distinction. */
  chip: string;
  /** Chip on top of artwork — needs its own opaque backing. */
  chipOnImage: string;
  /** Flattened: poster fallback is a flat tonal block, not a gradient. */
  fallback: string;
  /** Outline for the poster frame. */
  ring: string;
}

const FILM: EventTheme = {
  label: 'Film',
  edge: 'bg-foreground',
  wash: 'from-card to-card',
  hoverBorder: 'group-hover:border-foreground',
  hoverGlow: 'shadow-none',
  text: 'text-foreground',
  hoverText: 'group-hover:text-muted-foreground',
  // Filled: the heavier of the two treatments.
  chip: 'bg-foreground text-background',
  chipOnImage: 'bg-foreground text-background',
  fallback: 'from-card-alt to-card-alt',
  ring: 'ring-border',
};

const LIVE: EventTheme = {
  label: 'Live',
  edge: 'bg-foreground',
  wash: 'from-card to-card',
  hoverBorder: 'group-hover:border-foreground',
  hoverGlow: 'shadow-none',
  text: 'text-foreground',
  hoverText: 'group-hover:text-muted-foreground',
  // Outlined: same ink, lighter weight.
  chip: 'border border-foreground text-foreground',
  chipOnImage: 'border border-background text-background',
  fallback: 'from-card-alt to-card-alt',
  ring: 'ring-border',
};

export function eventTheme(type: EventType): EventTheme {
  return type === 'concert' ? LIVE : FILM;
}
