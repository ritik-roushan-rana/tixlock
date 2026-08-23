import { cn } from '@/lib/utils';

/**
 * Loading placeholder.
 *
 * Uses a shimmer sweep rather than a pulse: at the sizes used here (seat grids,
 * table rows) a pulse reads as flicker, whereas a directional sweep reads as
 * "content is arriving".
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // Square, not `rounded-md`. The design system pins `--radius: 0` and every
        // other surface is hard-edged, so a rounded placeholder announced itself as a
        // different visual language than the content replacing it.
        'relative overflow-hidden rounded-none bg-muted',
        className
      )}
      aria-hidden="true"
      {...props}
    >
      {/*
        Sweep raised from 6% to 10% of foreground. On the dark theme `bg-muted` is
        #18191680 against a #0f100e page, and a 6% sweep over that was close to
        invisible — the skeleton read as a dead grey block rather than as pending
        content, which is precisely the "frozen" impression this work is removing.
        `motion-reduce` drops the animation for anyone who asked for less motion; the
        block still communicates position and size.
      */}
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.6s_infinite] bg-gradient-to-r from-transparent via-foreground/10 to-transparent motion-reduce:hidden" />
    </div>
  );
}

export { Skeleton };
