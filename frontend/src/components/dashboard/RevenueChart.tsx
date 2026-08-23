import { lazy, Suspense } from 'react';

import type { DashboardEventRow, EventReportShow } from '@/lib/api/types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Lazy façade over the Recharts dashboard charts.
 *
 * Recharts is 376 kB, and it used to be a *static* import shared by both organiser
 * routes. Rollup therefore hoisted it into a shared chunk that had to finish
 * downloading before Suspense could resolve either route — so `/organiser` paid
 * ~412 kB before it painted anything but a spinner. That was the longest measurable
 * blank on the whole site, and it hit precisely the page users complained about.
 *
 * Splitting it here inverts the order: the dashboard's own chunk is 36 kB, so the
 * layout, stat cards and tables paint immediately, and the chart library streams in
 * behind them under its own Suspense boundary. Nothing about the charts themselves
 * changed — the implementations moved to ./charts.tsx untouched and the exported
 * names and props are identical, so no page needed editing.
 *
 * All three wrappers point at the same module, so it is fetched once and the second
 * and third charts resolve from cache.
 */

const ChartsModule = {
  RevenueByEvent: lazy(() =>
    import('./charts').then((m) => ({ default: m.RevenueByEventChart }))
  ),
  OccupancyByEvent: lazy(() =>
    import('./charts').then((m) => ({ default: m.OccupancyByEventChart }))
  ),
  ShowRevenue: lazy(() => import('./charts').then((m) => ({ default: m.ShowRevenueChart }))),
};

/**
 * Placeholder occupying the chart's exact footprint.
 *
 * `h-64` matches the `ResponsiveContainer` box inside `CardContent`, and the header
 * rows match the real title and description, so the chart swapping in shifts nothing
 * around it.
 */
function ChartSkeleton() {
  return (
    <Card className="border-0 bg-card">
      <CardHeader className="pb-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="mt-2 h-4 w-56" />
      </CardHeader>
      <CardContent>
        <div className="h-64 w-full" role="status" aria-live="polite">
          <span className="sr-only">Loading chart</span>
          {/* Bars of differing heights read as a chart arriving rather than a blank box. */}
          <div className="flex h-full items-end gap-2">
            {[45, 70, 35, 85, 55, 60, 40].map((h, i) => (
              <Skeleton key={i} className="flex-1" style={{ height: `${h}%` }} />
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function RevenueByEventChart({ events }: { events: DashboardEventRow[] }) {
  return (
    <Suspense fallback={<ChartSkeleton />}>
      <ChartsModule.RevenueByEvent events={events} />
    </Suspense>
  );
}

export function OccupancyByEventChart({ events }: { events: DashboardEventRow[] }) {
  return (
    <Suspense fallback={<ChartSkeleton />}>
      <ChartsModule.OccupancyByEvent events={events} />
    </Suspense>
  );
}

export function ShowRevenueChart({ shows }: { shows: EventReportShow[] }) {
  return (
    <Suspense fallback={<ChartSkeleton />}>
      <ChartsModule.ShowRevenue shows={shows} />
    </Suspense>
  );
}
