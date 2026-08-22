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
      className={cn('relative overflow-hidden rounded-md bg-muted', className)}
      aria-hidden="true"
      {...props}
    >
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.6s_infinite] bg-gradient-to-r from-transparent via-foreground/[0.06] to-transparent" />
    </div>
  );
}

export { Skeleton };
