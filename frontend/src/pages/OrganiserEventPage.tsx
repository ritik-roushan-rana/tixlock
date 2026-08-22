import { NavLink, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Users } from 'lucide-react';

import { dashboardApi } from '@/lib/api/endpoints';
import { queryKeys } from '@/lib/queryKeys';
import { formatMoney, toPercent } from '@/lib/money';
import { formatDate, formatTime, formatTimestamp } from '@/lib/datetime';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, ErrorState } from '@/components/common/states';
import { ShowRevenueChart } from '@/components/dashboard/RevenueChart';

/**
 * Per-event report: showings, categories, waitlist depth and the attendee list.
 *
 * Note the category figures aggregate across every showing of the event, not per
 * showing — that is how the backend computes them, and labelling it explicitly
 * avoids the numbers looking wrong next to the per-showing table.
 */
export default function OrganiserEventPage() {
  const { eventId: eventIdParam } = useParams<{ eventId: string }>();
  const eventId = Number(eventIdParam);

  const reportQuery = useQuery({
    queryKey: queryKeys.dashboard.eventReport(eventId),
    queryFn: () => dashboardApi.eventReport(eventId),
    enabled: Number.isFinite(eventId) && eventId > 0,
  });

  const attendeesQuery = useQuery({
    queryKey: queryKeys.dashboard.eventBookings(eventId),
    queryFn: () => dashboardApi.eventBookings(eventId, 100),
    enabled: Number.isFinite(eventId) && eventId > 0,
  });

  if (!Number.isFinite(eventId) || eventId <= 0) {
    return <ErrorState error={new Error('That event link is not valid.')} />;
  }

  if (reportQuery.isError) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorState error={reportQuery.error} onRetry={() => void reportQuery.refetch()} />
      </div>
    );
  }

  if (reportQuery.isLoading || !reportQuery.data) {
    return (
      <div className="space-y-6">
        <BackLink />
        <Skeleton className="h-8 w-72" />
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  const { event, shows, categories, waitlist, totals } = reportQuery.data;

  return (
    <div className="space-y-6">
      <BackLink />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Badge variant={event.type === 'movie' ? 'default' : 'outline'}>
            {event.type}
          </Badge>
          <h1 className="heading text-display-lg">{event.title}</h1>
        </div>
        <Button variant="outline" size="sm" asChild>
          <NavLink to={`/events/${event.id}`}>
            <ExternalLink /> Customer view
          </NavLink>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <MiniStat label="Revenue" value={formatMoney(totals.revenue)} />
        <MiniStat label="Seats sold" value={String(totals.seats_sold)} />
        <MiniStat
          label="Showings"
          value={String(totals.shows)}
          hint={`${totals.bookings} booking${totals.bookings === 1 ? '' : 's'}`}
        />
      </div>

      {shows.length > 0 ? <ShowRevenueChart shows={shows} /> : null}

      <Tabs defaultValue="showings">
        <TabsList>
          <TabsTrigger value="showings">Showings</TabsTrigger>
          <TabsTrigger value="categories">Categories</TabsTrigger>
          <TabsTrigger value="waitlist">Waitlist</TabsTrigger>
          <TabsTrigger value="attendees">Attendees</TabsTrigger>
        </TabsList>

        {/* --- Showings ---------------------------------------------------- */}
        <TabsContent value="showings">
          <Card className="border-0 bg-card">
            <CardContent className="p-0">
              {shows.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="No showings yet" description="Add a showing from the dashboard." />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead className="text-right">Sold</TableHead>
                      <TableHead className="text-right">Occupancy</TableHead>
                      <TableHead className="text-right">Held</TableHead>
                      <TableHead className="text-right">Bookings</TableHead>
                      <TableHead className="text-right">Cancelled</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shows.map((show) => {
                      const occupancy = toPercent(show.occupancy_pct);
                      return (
                        <TableRow key={show.id}>
                          <TableCell className="whitespace-nowrap">
                            {formatDate(show.date)}
                            <span className="tabular ml-1 text-muted-foreground">
                              {formatTime(show.time)}
                            </span>
                          </TableCell>
                          <TableCell className="tabular text-right">
                            {show.booked_seats}/{show.total_seats}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-2">
                              <div
                                className="h-2 w-16 overflow-hidden bg-card-alt"
                                aria-hidden
                              >
                                {/* 8px, square ends, cobalt fill — the spec's
                                    progress indicator. */}
                                <div
                                  className="h-full bg-cobalt"
                                  style={{ width: `${Math.min(100, occupancy)}%` }}
                                />
                              </div>
                              <span className="tabular w-12 text-right">{occupancy}%</span>
                            </div>
                          </TableCell>
                          <TableCell className="tabular text-right">
                            {show.held_seats + show.offered_seats}
                          </TableCell>
                          <TableCell className="tabular text-right">
                            {show.bookings_confirmed}
                          </TableCell>
                          <TableCell className="tabular text-right text-muted-foreground">
                            {show.bookings_cancelled}
                          </TableCell>
                          <TableCell className="tabular text-right font-medium">
                            {formatMoney(show.revenue)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="sm" asChild>
                              <NavLink to={`/shows/${show.id}`}>Seat map</NavLink>
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* --- Categories -------------------------------------------------- */}
        <TabsContent value="categories">
          <Card className="border-0 bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="eyebrow text-muted-foreground">By category</CardTitle>
              <p className="text-xs text-muted-foreground">
                Totalled across every showing of this event.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Sold</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {categories.map((category) => (
                    <TableRow key={category.category}>
                      <TableCell className="font-medium">{category.category}</TableCell>
                      <TableCell className="tabular text-right">
                        {category.booked_seats}/{category.total_seats}
                      </TableCell>
                      <TableCell className="tabular text-right font-medium">
                        {formatMoney(category.revenue)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* --- Waitlist ---------------------------------------------------- */}
        <TabsContent value="waitlist">
          <Card className="border-0 bg-card">
            <CardContent className="p-0">
              {waitlist.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    icon={<Users className="h-5 w-5" />}
                    title="Nobody on the waitlist"
                    description="Customers can join a waitlist once a category sells out."
                  />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Waiting</TableHead>
                      <TableHead className="text-right">Offered</TableHead>
                      <TableHead className="text-right">Fulfilled</TableHead>
                      <TableHead className="text-right">Expired</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {waitlist.map((row) => (
                      <TableRow key={row.category}>
                        <TableCell className="font-medium">{row.category}</TableCell>
                        <TableCell className="tabular text-right">{row.waiting}</TableCell>
                        {/* Monochrome. These are three counts of the same thing, and
                            tinting them amber/green implied one is a warning and one
                            is a success — neither is true, and it spent two signals. */}
                        <TableCell className="tabular text-right">{row.offered}</TableCell>
                        <TableCell className="tabular text-right">{row.fulfilled}</TableCell>
                        <TableCell className="tabular text-right text-muted-foreground">
                          {row.expired}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* --- Attendees --------------------------------------------------- */}
        <TabsContent value="attendees">
          <Card className="border-0 bg-card">
            <CardContent className="p-0">
              {attendeesQuery.isError ? (
                <div className="p-4">
                  <ErrorState
                    error={attendeesQuery.error}
                    onRetry={() => void attendeesQuery.refetch()}
                  />
                </div>
              ) : attendeesQuery.isLoading ? (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-12" />
                  ))}
                </div>
              ) : attendeesQuery.data && attendeesQuery.data.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="No bookings yet" description="Attendees appear here as tickets sell." />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reference</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Showing</TableHead>
                      <TableHead>Seats</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Booked</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {attendeesQuery.data?.map((booking) => (
                      <TableRow key={booking.id}>
                        <TableCell className="font-mono text-xs">{booking.booking_ref}</TableCell>
                        <TableCell>
                          <p className="truncate font-medium">{booking.customer_name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {booking.customer_email}
                          </p>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {formatDate(booking.date)} {formatTime(booking.time)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {booking.seats ?? '—'}
                          <span className="ml-1 text-muted-foreground">({booking.seat_count})</span>
                        </TableCell>
                        <TableCell className="tabular text-right">
                          {formatMoney(booking.total_amount)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={booking.status === 'confirmed' ? 'success' : 'destructive'}
                           
                          >
                            {booking.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {formatTimestamp(booking.created_at)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="border-0 bg-card">
      <CardContent className="space-y-1 p-5">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="tabular heading text-display-sm">{value}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function BackLink() {
  return (
    <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
      <NavLink to="/organiser">
        <ArrowLeft /> Back to dashboard
      </NavLink>
    </Button>
  );
}
