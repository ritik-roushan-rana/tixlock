import { BellRing, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatMoney, toMoneyOrNull } from '@/lib/money';
import type { CategoryAvailability, WaitlistMineItem } from '@/lib/api/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Per-category availability, and the waitlist entry point.
 *
 * The waitlist button only appears when the backend reports `sold_out` for that
 * category. That flag is authoritative and non-obvious: it counts a seat whose hold
 * has lapsed as available even if the cron sweep has not yet run, so it will not
 * offer a waitlist for a category that actually has a free seat. Trying to join a
 * category with seats left returns 409, so gating on this avoids a guaranteed error.
 */
export function AvailabilityPanel({
  categories,
  loading,
  myWaitlist,
  canJoin,
  joiningCategory,
  onJoin,
}: {
  categories: CategoryAvailability[] | undefined;
  loading: boolean;
  /** The viewer's own waitlist entries for this show. */
  myWaitlist: WaitlistMineItem[];
  canJoin: boolean;
  joiningCategory: string | null;
  onJoin: (category: string) => void;
}) {
  if (loading) {
    return (
      <Card className="border-0 bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="eyebrow text-muted-foreground">Availability</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-5 w-16" />
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  if (!categories || categories.length === 0) return null;

  return (
    <Card className="border-0 bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="eyebrow text-muted-foreground">Availability</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {categories.map((category) => {
          const price = toMoneyOrNull(category.price);
          const entry = myWaitlist.find(
            (w) => w.category === category.category && (w.status === 'waiting' || w.status === 'offered')
          );

          return (
            <div
              key={category.category}
              className="space-y-2 border-t border-border pt-3 first:border-t-0 first:pt-0"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{category.category}</p>
                  <p className="tabular text-xs text-muted-foreground">
                    {price === null ? 'Not priced' : formatMoney(price)}
                  </p>
                </div>
                {/* A status tag: solid fill, square, caps, per the spec. Sold out is
                    the error signal; a live count is a plain ink block, because
                    "seats remain" is not a warning. */}
                <span
                  className={cn(
                    'eyebrow shrink-0 px-2 py-1',
                    category.sold_out
                      ? 'bg-destructive text-destructive-foreground'
                      : 'bg-panel text-panel-foreground'
                  )}
                >
                  {category.sold_out ? 'Sold out' : `${category.available} left`}
                </span>
              </div>

              {entry ? (
                <p className="flex items-start gap-1.5 border-l-4 border-cobalt bg-card-alt px-2.5 py-1.5 text-xs text-foreground">
                  <BellRing className="mt-0.5 h-3 w-3 shrink-0" />
                  {entry.status === 'offered'
                    ? 'A seat has been offered to you — check your email or My tickets.'
                    : `On the waitlist${entry.position ? ` · position ${entry.position}` : ''}`}
                </p>
              ) : category.sold_out && canJoin ? (
                <Button
                  variant="cobalt"
                  size="sm"
                  className="w-full"
                  onClick={() => onJoin(category.category)}
                  disabled={joiningCategory !== null}
                >
                  {joiningCategory === category.category ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <BellRing />
                  )}
                  Join {category.category} waitlist
                </Button>
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
