import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BellRing,
  CalendarDays,
  MapPin,
  QrCode,
  Ticket,
  TicketX,
  Trash2,
  XCircle,
} from 'lucide-react';

import { bookingsApi, waitlistApi } from '@/lib/api/endpoints';
import { queryKeys } from '@/lib/queryKeys';
import { formatMoney } from '@/lib/money';
import { formatDate, formatTime, formatTimestamp } from '@/lib/datetime';
import type { BookingHistoryItem, WaitlistMineItem, WaitlistStatus } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState, ErrorState } from '@/components/common/states';

/**
 * Booking history and waitlist status.
 *
 * The cancellation confirmation is deliberately explicit about the waitlist: on this
 * platform cancelling can hand the seats straight to a queued customer rather than
 * returning them to general sale, which is not reversible and not obvious.
 */
export default function BookingsPage() {
  const bookingsQuery = useQuery({
    queryKey: queryKeys.bookings.list(),
    queryFn: bookingsApi.list,
  });

  const waitlistQuery = useQuery({
    queryKey: queryKeys.waitlist.mine(),
    queryFn: waitlistApi.mine,
  });

  const activeWaitlist = (waitlistQuery.data ?? []).filter(
    (entry) => entry.status === 'waiting' || entry.status === 'offered'
  );

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="heading text-display-lg">My tickets</h1>
        <p className="text-muted-foreground">
          Your bookings, and anything you are waiting on.
        </p>
      </div>

      <Tabs defaultValue="bookings">
        <TabsList>
          <TabsTrigger value="bookings">
            <Ticket className="h-3.5 w-3.5" /> Bookings
            {bookingsQuery.data ? (
              <span className="tabular ml-1 text-xs text-muted-foreground">
                {bookingsQuery.data.length}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="waitlist">
            <BellRing className="h-3.5 w-3.5" /> Waitlist
            {activeWaitlist.length > 0 ? (
              <span className="tabular ml-1 text-xs text-muted-foreground">
                {activeWaitlist.length}
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="bookings">
          {bookingsQuery.isError ? (
            <ErrorState error={bookingsQuery.error} onRetry={() => void bookingsQuery.refetch()} />
          ) : bookingsQuery.isLoading ? (
            <div className="grid gap-4 md:grid-cols-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-52" />
              ))}
            </div>
          ) : bookingsQuery.data && bookingsQuery.data.length === 0 ? (
            <EmptyState
              icon={<TicketX className="h-5 w-5" />}
              title="No bookings yet"
              description="Once you book a showing your tickets and QR codes appear here."
              action={
                <Button asChild>
                  <NavLink to="/events">Browse events</NavLink>
                </Button>
              }
            />
          ) : (
            /* `minmax(0,1fr)` on the single-column case, not a bare `grid`: an auto
               track is sized by its items' min-content, so one long untruncated title
               widened the track past the viewport. An explicit minimum of 0 caps it at
               the available width and lets `truncate` do its job. */
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2">
              {bookingsQuery.data?.map((booking) => (
                <BookingCard key={booking.id} booking={booking} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="waitlist">
          {waitlistQuery.isError ? (
            <ErrorState error={waitlistQuery.error} onRetry={() => void waitlistQuery.refetch()} />
          ) : waitlistQuery.isLoading ? (
            <Skeleton className="h-40" />
          ) : waitlistQuery.data && waitlistQuery.data.length === 0 ? (
            <EmptyState
              icon={<BellRing className="h-5 w-5" />}
              title="You are not on any waitlists"
              description="When a category is sold out you can join its waitlist from the seat map. If a seat is released we will email you a link to claim it."
            />
          ) : (
            <WaitlistTable entries={waitlistQuery.data ?? []} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* --- Booking card --------------------------------------------------------- */

function BookingCard({ booking }: { booking: BookingHistoryItem }) {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  const cancelled = booking.status === 'cancelled';

  const cancelMutation = useMutation({
    mutationFn: () => bookingsApi.cancel(booking.id),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.bookings.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.shows.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.events.all });

      // Report where the seats went — this is the visible outcome of the waitlist
      // mechanic and worth surfacing rather than a generic "cancelled".
      const parts: string[] = [];
      if (result.seats_offered_to_waitlist > 0) {
        parts.push(
          `${result.seats_offered_to_waitlist} seat${result.seats_offered_to_waitlist === 1 ? '' : 's'} offered to waitlisted customers`
        );
      }
      if (result.seats_released > 0) {
        parts.push(
          `${result.seats_released} seat${result.seats_released === 1 ? '' : 's'} returned to general sale`
        );
      }
      toast.success(`Booking ${result.booking_ref} cancelled`, {
        description: parts.join(' · ') || undefined,
      });
      setConfirmOpen(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Could not cancel this booking');
      setConfirmOpen(false);
    },
  });

  // Fetched only when the dialog opens, rather than for every card in the list.
  const qrQuery = useQuery({
    queryKey: queryKeys.bookings.qr(booking.id),
    queryFn: () => bookingsApi.qr(booking.id),
    enabled: qrOpen && !cancelled,
    staleTime: Infinity,
  });

  const seatLabels = booking.seats.map((s) => `${s.row_label}${s.seat_number}`).join(', ');

  return (
    // Flat tonal block. A cancelled booking is dimmed rather than recoloured, so the
    // card still reads as a record of what happened.
    <Card className={cn('border-0 bg-card', cancelled && 'opacity-70')}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="font-mono text-xs tracking-wider text-muted-foreground">
              {booking.booking_ref}
            </p>
            <CardTitle className="heading truncate text-display-sm">
              {booking.event_title}
            </CardTitle>
          </div>
          {/* Solid status tag. Ink for a live booking, error red for a cancelled one
              — the two states a customer needs to tell apart at a glance. */}
          <span
            className={cn(
              'eyebrow shrink-0 px-2 py-1',
              cancelled
                ? 'bg-destructive text-destructive-foreground'
                : 'bg-panel text-panel-foreground'
            )}
          >
            {booking.status}
          </span>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <dl className="space-y-1.5 text-sm text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <CalendarDays className="h-3.5 w-3.5 shrink-0" />
            <dd>
              {formatDate(booking.date)} · {formatTime(booking.time)}
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5 shrink-0" />
            <dd className="truncate">{booking.venue_name}</dd>
          </div>
        </dl>

        <Separator />

        <div className="flex items-end justify-between gap-3 text-sm">
          <div className="min-w-0">
            <p className="eyebrow text-muted-foreground">
              {booking.seats.length} seat{booking.seats.length === 1 ? '' : 's'}
            </p>
            <p className="tabular mt-1 truncate font-semibold">{seatLabels || '—'}</p>
          </div>
          <div className="text-right">
            <p className="eyebrow text-muted-foreground">Total</p>
            <p className="tabular heading mt-1 text-display-sm">
              {formatMoney(booking.total_amount)}
            </p>
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Booked {formatTimestamp(booking.created_at)}
          {cancelled && booking.cancelled_at
            ? ` · cancelled ${formatTimestamp(booking.cancelled_at)}`
            : ''}
        </p>

        {!cancelled ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={() => setQrOpen(true)}>
              <QrCode /> Ticket
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setConfirmOpen(true)}
            >
              <Trash2 /> Cancel
            </Button>
          </div>
        ) : null}
      </CardContent>

      {/* --- QR dialog ---------------------------------------------------- */}
      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="heading text-display-sm">Your ticket</DialogTitle>
            <DialogDescription>Show this at the venue entrance.</DialogDescription>
          </DialogHeader>
          {/* White, not cream, behind the QR: a scanner wants maximum contrast, and
              white is what a printed ticket will be anyway. */}
          <div className="flex flex-col items-center gap-3 bg-card p-5">
            {qrQuery.isLoading ? (
              <Skeleton className="h-40 w-40" />
            ) : qrQuery.isError ? (
              <ErrorState compact error={qrQuery.error} onRetry={() => void qrQuery.refetch()} />
            ) : qrQuery.data?.qr_data_url ? (
              <img
                src={qrQuery.data.qr_data_url}
                alt={`QR code for booking ${booking.booking_ref}`}
                className="h-40 w-40 bg-white p-2"
              />
            ) : (
              <p className="text-sm text-muted-foreground">QR code unavailable.</p>
            )}
            <p className="eyebrow text-muted-foreground">Scan at entry</p>
            <p className="font-mono text-sm font-bold tracking-widest">{booking.booking_ref}</p>
            <p className="text-center text-xs text-muted-foreground">
              {seatLabels} · {formatDate(booking.date)} {formatTime(booking.time)}
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* --- Cancel confirmation ------------------------------------------ */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel booking {booking.booking_ref}?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. Your {booking.seats.length} seat
              {booking.seats.length === 1 ? '' : 's'} are released immediately, and may be offered
              straight to customers on the waitlist for that category.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelMutation.isPending}>Keep booking</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                // Prevent the dialog closing before the request settles, so the
                // user sees the pending state rather than an instant dismiss.
                e.preventDefault();
                cancelMutation.mutate();
              }}
            >
              {cancelMutation.isPending ? 'Cancelling…' : 'Cancel booking'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/* --- Waitlist table ------------------------------------------------------- */

/**
 * Status tag fills for a waitlist entry.
 *
 * Replaces the shadcn Badge variants. Assignment is by meaning, not by decoration:
 * `offered` is the only one that needs the customer to act, so it takes lime — the
 * signal this system reserves for the thing that matters most. `waiting` and
 * `fulfilled` are ink (a fact, no action), and `expired` recedes to an outline.
 */
const WAITLIST_TAG: Record<WaitlistStatus, string> = {
  waiting: 'bg-panel text-panel-foreground',
  offered: 'bg-lime text-lime-foreground',
  fulfilled: 'bg-panel text-panel-foreground',
  expired: 'border border-border-strong text-muted-foreground',
};

function WaitlistTable({ entries }: { entries: WaitlistMineItem[] }) {
  const queryClient = useQueryClient();

  const leaveMutation = useMutation({
    mutationFn: (waitlistId: number) => waitlistApi.leave(waitlistId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.waitlist.mine() });
      toast.info('You left the waitlist');
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Could not leave the waitlist'),
  });

  return (
    <Card className="border-0 bg-card">
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell>
                  <p className="font-medium">{entry.event_title}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(entry.date)} · {formatTime(entry.time)} · {entry.venue_name}
                  </p>
                </TableCell>
                <TableCell>{entry.category}</TableCell>
                <TableCell>
                  <div className="flex flex-col items-start gap-1">
                    <span className={cn('eyebrow px-2 py-1', WAITLIST_TAG[entry.status])}>
                      {entry.status}
                    </span>
                    {entry.status === 'waiting' && entry.position ? (
                      <span className="tabular text-xs text-muted-foreground">
                        position {entry.position}
                      </span>
                    ) : null}
                    {entry.status === 'offered' && entry.offered_row_label ? (
                      <span className="text-xs text-muted-foreground">
                        seat {entry.offered_row_label}
                        {entry.offered_seat_number}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatTimestamp(entry.joined_at)}
                </TableCell>
                <TableCell className="text-right">
                  {entry.status === 'offered' && entry.offer_token ? (
                    // Lime: an offer is time-limited and claiming it is the single
                    // most important action available on this screen.
                    <Button variant="lime" size="sm" asChild>
                      <NavLink to={`/offer?token=${encodeURIComponent(entry.offer_token)}`}>
                        Claim seat
                      </NavLink>
                    </Button>
                  ) : entry.status === 'waiting' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => leaveMutation.mutate(entry.id)}
                      disabled={leaveMutation.isPending}
                    >
                      <XCircle /> Leave
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
