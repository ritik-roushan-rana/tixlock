import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * Status tag.
 *
 * The spec is specific about these: "small boxes with solid backgrounds and
 * high-contrast text". So the pill shape is gone, and every variant is now a SOLID
 * fill rather than a 15%-opacity tint carrying same-hue text. Those tints were the
 * worst contrast offenders in the old system — `warning` was #a8580a text on a 15%
 * wash of itself, which measured under 3:1 on cream.
 *
 * Type is `.eyebrow` (12px, bold, caps, wide tracking), the one place this system
 * uses uppercase. That means callers no longer need `capitalize`, and a lowercase
 * database value like "cancelled" renders correctly without transformation.
 *
 * Variant meanings, so they stay used consistently:
 *   default / secondary — a neutral fact. Ink fill, or a tonal one.
 *   destructive         — a failure or a blocker. The only red.
 *   warning             — needs attention but is not broken. Cobalt, because this
 *                         system has no amber signal and cobalt is its "look here".
 *   success             — a completed good outcome. Lime, the positive signal.
 *   outline / muted     — receded, historical, or not applicable.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 border px-2 py-1 text-[0.75rem] font-bold uppercase leading-none tracking-[0.08em] transition-colors focus:outline-none',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-panel text-panel-foreground',
        secondary: 'border-transparent bg-card-alt text-foreground',
        outline: 'border-border-strong text-foreground',
        success: 'border-transparent bg-lime text-lime-foreground',
        warning: 'border-transparent bg-cobalt text-cobalt-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        /*
         * Ink text, not muted text.
         *
         * `--muted-foreground` is tuned to clear 4.5:1 on cream (5.00) and on --card
         * (4.50). This variant fills with --card-alt, the darkest surface in the
         * ladder, where the same grey drops to 4.07:1 and fails. Recession here comes
         * from the tonal fill and the 12px size — scale and weight, which is how this
         * system is meant to build hierarchy — rather than from washing out the text.
         */
        muted: 'border-transparent bg-card-alt text-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
