import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, CalendarPlus, IndianRupee, Ticket, TrendingUp, Users } from 'lucide-react';

import { dashboardApi, eventsApi } from '@/lib/api/endpoints';
import { queryKeys } from '@/lib/queryKeys';
import { formatMoney } from '@/lib/money';
import { useAuthStore } from '@/store/auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/common/states';
import { CreateEventDialog } from '@/components/dashboard/CreateEventDialog';
import { CreateShowDialog } from '@/components/dashboard/CreateShowDialog';
import { OccupancyByEventChart, RevenueByEventChart } from '@/components/dashboard/RevenueChart';

/**
 * Organiser dashboard.
 *
 * Revenue figures throughout come from confirmed bookings only, and are computed by
 * the backend from the price captured at the point of sale — so re-pricing a show
 * later never rewrites past takings.
 */
export default function OrganiserPage() {
  const role = useAuthStore((s) => s.user?.role);

  const summaryQuery = useQuery({
    queryKey: queryKeys.dashboard.summary(),
    queryFn: dashboardApi.summary,
  });

  // Needed for the "add showing" picker; the summary rows do not carry venue_id in
  // the shape the dialog needs.
  const myEventsQuery = useQuery({
    queryKey: queryKeys.events.mine(),
    queryFn: eventsApi.mine,
  });

  const totals = summaryQuery.data?.totals;
  const events = summaryQuery.data?.events ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="heading text-display-lg">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {role === 'admin'
              ? 'Every event on the platform.'
              : 'Your events, seats sold and revenue.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <CreateShowDialog events={myEventsQuery.data ?? []} />
          <CreateEventDialog />
        </div>
      </div>

      {summaryQuery.isError ? (
        <ErrorState error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} />
      ) : (
        <>
          {/* --- Headline stats --------------------------------------------- */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Revenue"
              value={totals ? formatMoney(totals.revenue) : undefined}
              hint="confirmed bookings"
              icon={IndianRupee}
              loading={summaryQuery.isLoading}
            />
            <StatCard
              label="Seats sold"
              value={totals ? String(totals.seats_sold) : undefined}
              hint={totals ? `${totals.bookings} booking${totals.bookings === 1 ? '' : 's'}` : ''}
              icon={Ticket}
              loading={summaryQuery.isLoading}
            />
            <StatCard
              label="Events"
              value={totals ? String(totals.events) : undefined}
              hint={totals ? `${totals.shows} showing${totals.shows === 1 ? '' : 's'}` : ''}
              icon={BarChart3}
              loading={summaryQuery.isLoading}
            />
            <StatCard
              label="On waitlists"
              value={
                summaryQuery.isLoading
                  ? undefined
                  : String(
                      events.reduce(
                        (sum, event) => sum + event.waitlist_waiting + event.waitlist_offered,
                        0
                      )
                    )
              }
              hint="waiting or offered"
              icon={Users}
              loading={summaryQuery.isLoading}
            />
          </div>

          {/* --- Charts ----------------------------------------------------- */}
          {summaryQuery.isLoading ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <Skeleton className="h-80" />
              <Skeleton className="h-80" />
            </div>
          ) : events.length > 0 ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <RevenueByEventChart events={events} />
              <OccupancyByEventChart events={events} />
            </div>
          ) : null}

          {/* --- Events table ---------------------------------------------- */}
          <Card className="border-0 bg-card">
            <CardHeader className="pb-3">
              <CardTitle className="eyebrow text-muted-foreground">Events</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {summaryQuery.isLoading ? (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-12" />
                  ))}
                </div>
              ) : events.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    icon={<CalendarPlus className="h-5 w-5" />}
                    title="No events yet"
                    description="Create an event, then add a showing to make it bookable."
                    action={<CreateEventDialog />}
                  />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Event</TableHead>
                      <TableHead className="text-right">Shows</TableHead>
                      <TableHead className="text-right">Sold</TableHead>
                      <TableHead className="text-right">Held</TableHead>
                      <TableHead className="text-right">Free</TableHead>
                      <TableHead className="text-right">Waitlist</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.map((event) => (
                      <TableRow key={event.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="min-w-0">
                              <p className="truncate font-medium">{event.title}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {event.venue_name}
                              </p>
                            </div>
                            <Badge
                              variant={event.type === 'movie' ? 'default' : 'outline'}
                              className="shrink-0"
                            >
                              {event.type}
                            </Badge>
                          </div>
                        </TableCell>
                        <TableCell className="tabular text-right">{event.show_count}</TableCell>
                        <TableCell className="tabular text-right">
                          {event.booked_seats}/{event.total_seats}
                        </TableCell>
                        <TableCell className="tabular text-right">
                          {/* A held seat is a normal operating state, not a warning,
                              so it is ink like every other count. Zero recedes. */}
                          {event.pending_seats > 0 ? (
                            <span>{event.pending_seats}</span>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </TableCell>
                        <TableCell className="tabular text-right">{event.available_seats}</TableCell>
                        <TableCell className="text-right">
                          {event.waitlist_waiting + event.waitlist_offered > 0 ? (
                            <Badge variant="warning">
                              {event.waitlist_waiting}
                              {event.waitlist_offered > 0 ? `+${event.waitlist_offered}` : ''}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="tabular text-right font-medium">
                          {formatMoney(event.revenue)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" asChild>
                            <NavLink to={`/organiser/events/${event.id}`}>
                              <TrendingUp /> Details
                            </NavLink>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  loading,
}: {
  label: string;
  value: string | undefined;
  hint?: string;
  icon: typeof Ticket;
  loading: boolean;
}) {
  return (
    <Card className="border-0 bg-card">
      <CardContent className="flex items-start justify-between gap-3 p-5">
        <div className="min-w-0 space-y-1">
          <p className="eyebrow text-muted-foreground">{label}</p>
          {loading ? (
            <Skeleton className="h-7 w-24" />
          ) : (
            <p className="tabular heading truncate text-display-sm">{value ?? '—'}</p>
          )}
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        {/* Solid ink block. The 10%-primary wash it replaces was a tint carrying
            same-hue text, which is the pattern this system removed everywhere else. */}
        <span className="grid h-8 w-8 shrink-0 place-items-center bg-panel text-panel-foreground">
          <Icon className="h-4 w-4" />
        </span>
      </CardContent>
    </Card>
  );
}
