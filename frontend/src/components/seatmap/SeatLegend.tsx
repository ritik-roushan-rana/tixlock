import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/money';
import type { Money } from '@/lib/api/types';
import { SEAT_LEGEND, categoryStyleFor, type CategoryStyle } from './seatState';

/**
 * Seat map key.
 *
 * Two rows of information that used to be one flat list:
 *
 *   1. Categories — swatch, name, price. This is the row people actually scan, because
 *      it answers "what will this cost me", so it comes first and gets the larger type.
 *   2. States — what each fill means. Secondary, so it is smaller and lower contrast.
 *
 * Both are horizontal and wrap, and both live outside the grid's horizontal scroll
 * container so they stay on screen while panning the map on mobile.
 */
export function SeatLegend({
  pricing,
  categoryStyles,
  className,
}: {
  pricing: readonly { category: string; price: Money }[];
  categoryStyles: Record<string, CategoryStyle>;
  className?: string;
}) {
  return (
    <div className={cn('space-y-3', className)}>
      {pricing.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <li className="eyebrow mr-1 text-muted-foreground">Tiers</li>
          {pricing.map((tier) => {
            const style = categoryStyleFor(categoryStyles, tier.category);
            return (
              <li key={tier.category} className="flex items-center gap-2">
                <span aria-hidden className={cn('h-3.5 w-3.5 shrink-0', style.swatch)} />
                <span className="text-xs font-semibold">{tier.category}</span>
                <span className={cn('tabular text-xs font-bold', style.text)}>
                  {formatMoney(tier.price)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      <ul className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <li className="eyebrow mr-1 text-muted-foreground">Status</li>
        {SEAT_LEGEND.map(({ state, label, className: swatch }) => (
          <li
            key={state}
            className="eyebrow flex items-center gap-1.5 font-normal tracking-normal text-muted-foreground"
          >
            <span aria-hidden className={cn('h-3 w-3 shrink-0', swatch)} />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
