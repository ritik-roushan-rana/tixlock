import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BellRing,
  CalendarDays,
  CheckCircle2,
  Clock,
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
import { formatDate, formatDuration, formatTime, formatTimestamp } from '@/lib/datetime';
import { eventThumb } from '@/lib/posters';
import { useCountdown } from '@/hooks/useCountdown';
import { Poster } from '@/components/common/Poster';
import type { BookingHistoryItem, WaitlistMineItem, WaitlistStatus } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
      {/* Tabs wrap the whole screen so the trigger row can sit on the title's
          baseline (editorial masthead) while the panels stay inside the same
          Tabs root. */}
      <Tabs defaultValue="bookings">
        <div className="mb-lg flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div className="min-w-0 space-y-2">
            <h1 className="heading text-display-hero uppercase">My tickets</h1>
            <p className="text-muted-foreground">
              Your bookings, and anything you are waiting on.
            </p>
          </div>
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
        </div>

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
            // Same shape as the bookings skeleton, since the panels now render the
            // same kind of card.
            <div className="grid gap-4 md:grid-cols-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-52" />
              ))}
            </div>
          ) : waitlistQuery.data && waitlistQuery.data.length === 0 ? (
            <EmptyState
              icon={<BellRing className="h-5 w-5" />}
              title="You are not on any waitlists"
              description="When a category is sold out you can join its waitlist from the seat map. If a seat is released we will email you a link to claim it."
            />
          ) : (
            <WaitlistList
              entries={waitlistQuery.data ?? []}
              onOfferExpired={() => void waitlistQuery.refetch()}
            />
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
    <Card
      className={cn(
        'relative flex flex-col gap-4 overflow-hidden border-0 bg-card p-4',
        cancelled && 'opacity-70'
      )}
    >
      {/* Corner status tag. Lime for a live booking — a status tag, not an action, so
          it does not spend the screen's one lime CTA — and error red for a cancelled
          one. Both carry ink or on-destructive text, never white on lime. */}
      <span
        className={cn(
          'eyebrow absolute right-4 top-4 z-10 flex items-center gap-1 px-2 py-1',
          cancelled ? 'bg-destructive text-destructive-foreground' : 'bg-lime text-lime-foreground'
        )}
      >
        {cancelled ? <XCircle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
        {booking.status}
      </span>

      <div className="flex flex-1 flex-col gap-4 sm:flex-row">
        {/* Square artwork block. Full colour by design — see Poster's `blend` prop for
            why the monochrome treatment was removed: the poster is how you tell a film
            from a gig while scanning the list. */}
        {/* Decorative: the title sits immediately beside it, so a screen reader
            announcing the artwork would only repeat what the heading already says. */}
        <Poster
          src={eventThumb(booking.event_id, 240)}
          alt={`Artwork for ${booking.event_title}`}
          type={booking.event_type}
          decorative
          className="aspect-square w-full shrink-0 sm:h-[120px] sm:w-[120px]"
          sizes="120px"
        />

        {/* `min-w-0` so the truncating title cannot set a min-content floor that
            widens the grid track past the viewport at 390px. */}
        <div className="flex min-w-0 flex-1 flex-col justify-between">
          <div className="min-w-0">
            <p className="font-mono text-xs tracking-wider text-muted-foreground">
              {booking.booking_ref}
            </p>
            {/* pr clears the absolute status tag so long titles never run under it. */}
            <CardTitle className="heading mt-1 truncate pr-24 text-display-md uppercase">
              {booking.event_title}
            </CardTitle>

            <dl className="mt-2 space-y-1 text-sm text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <CalendarDays className="h-4 w-4 shrink-0" />
                <dd className="truncate">
                  {formatDate(booking.date)} · {formatTime(booking.time)}
                </dd>
              </div>
              <div className="flex items-center gap-1.5">
                <MapPin className="h-4 w-4 shrink-0" />
                <dd className="truncate">{booking.venue_name}</dd>
              </div>
            </dl>
          </div>

          {/* Hard-edged seat strip: the ticket's operative detail, framed so it reads
              as data rather than prose. Sits on the page ground, a step below the
              card, so the hairline does the separating instead of a shadow. */}
          <div className="mt-3 flex items-end justify-between gap-3 border border-border-strong bg-background p-2">
            <div className="min-w-0">
              <p className="eyebrow text-muted-foreground">
                {booking.seats.length} seat{booking.seats.length === 1 ? '' : 's'}
              </p>
              <p className="tabular mt-0.5 truncate text-sm font-bold">{seatLabels || '—'}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="eyebrow text-muted-foreground">Total</p>
              <p className="tabular mt-0.5 text-sm font-bold">
                {formatMoney(booking.total_amount)}
              </p>
            </div>
          </div>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Booked {formatTimestamp(booking.created_at)}
        {cancelled && booking.cancelled_at
          ? ` · cancelled ${formatTimestamp(booking.cancelled_at)}`
          : ''}
      </p>

      {!cancelled ? (
        <div className="mt-auto flex gap-2">
          {/* Ink, not lime: viewing a ticket is the primary action on this card, but
              lime is reserved for the one screen-level CTA (claiming an offer). */}
          <Button className="flex-1 uppercase tracking-widest" onClick={() => setQrOpen(true)}>
            View ticket <QrCode />
          </Button>
          <Button
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 /> Cancel
          </Button>
        </div>
      ) : null}

      {/* --- QR dialog ---------------------------------------------------- */}
      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent className="sm:max-w-sm">
          {/* Rule under the title rather than a panel: the dialog is already a
              surface step, so a second fill would flatten the hierarchy. */}
          <DialogHeader className="border-b border-border-strong pb-3">
            <DialogTitle className="heading text-display-md uppercase">Ticket</DialogTitle>
            <DialogDescription>Show this at the venue entrance.</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col items-center gap-3">
            {/* White, not cream, behind the QR, and framed: a scanner wants maximum
                contrast and a clean quiet zone, and white is what a printed ticket
                will be anyway. Fixed square so the layout does not jump when the
                image resolves. */}
            <div className="grid h-[250px] w-[250px] place-items-center border-2 border-border-strong bg-white p-2">
              {qrQuery.isLoading ? (
                <Skeleton className="h-full w-full" />
              ) : qrQuery.isError ? (
                <ErrorState compact error={qrQuery.error} onRetry={() => void qrQuery.refetch()} />
              ) : qrQuery.data?.qr_data_url ? (
                <img
                  src={qrQuery.data.qr_data_url}
                  alt={`QR code for booking ${booking.booking_ref}`}
                  className="h-full w-full object-contain"
                />
              ) : (
                <p className="p-4 text-center text-sm text-muted-foreground">
                  QR code unavailable.
                </p>
              )}
            </div>

            <p className="eyebrow text-center">Scan at entrance</p>
            <p className="font-mono text-sm font-bold tracking-widest">{booking.booking_ref}</p>
            <p className="text-center text-xs text-muted-foreground">
              {booking.event_title} · {formatDate(booking.date)} {formatTime(booking.time)}
            </p>
            <p className="tabular text-center text-sm font-bold">{seatLabels || '—'}</p>
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

/* --- Waitlist ------------------------------------------------------------- */

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

/** Ordering weight per status. An offer is ticking, so it is never below a
 *  settled row no matter when it was joined. */
const WAITLIST_ORDER: Record<WaitlistStatus, number> = {
  offered: 0,
  waiting: 1,
  fulfilled: 2,
  expired: 3,
};

function WaitlistList({
  entries,
  onOfferExpired,
}: {
  entries: WaitlistMineItem[];
  onOfferExpired: () => void;
}) {
  // The server orders by joined_at only. Re-sort so a live offer is the first thing
  // on screen — it is the one row with a deadline attached.
  const sorted = [...entries].sort(
    (a, b) =>
      WAITLIST_ORDER[a.status] - WAITLIST_ORDER[b.status] ||
      new Date(b.joined_at).getTime() - new Date(a.joined_at).getTime()
  );

  return (
    /* Same `minmax(0,1fr)` single-column track as the bookings grid, for the same
       reason: an auto track is sized by its items' min-content and one long
       untruncated title would widen it past a 390px viewport. */
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2">
      {sorted.map((entry) => (
        <WaitlistCard key={entry.id} entry={entry} onOfferExpired={onOfferExpired} />
      ))}
    </div>
  );
}

function WaitlistCard({
  entry,
  onOfferExpired,
}: {
  entry: WaitlistMineItem;
  onOfferExpired: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  /**
   * The offer deadline, which this screen previously dropped on the floor.
   *
   * `offer_expires_at` was being fetched and never rendered, so the only place a
   * customer could see how long they had was the emailed link itself. Same absolute
   * server deadline as OfferPage uses, for the same reason — see useCountdown.
   */
  const countdown = useCountdown({
    expiresAt: entry.status === 'offered' ? entry.offer_expires_at : null,
    // Refetch on expiry so the row flips to `expired` on its own rather than
    // offering a Claim button the server will reject.
    onExpire: onOfferExpired,
  });

  const offerLive = entry.status === 'offered' && Boolean(entry.offer_token) && !countdown.expired;

  const leaveMutation = useMutation({
    mutationFn: () => waitlistApi.leave(entry.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.waitlist.mine() });
      toast.info('You left the waitlist', { description: entry.event_title });
      setConfirmOpen(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Could not leave the waitlist');
      setConfirmOpen(false);
    },
  });

  /**
   * An offer whose window has run out is still `offered` in the database until the
   * sweeper catches up, so `entry.status` alone would keep the row advertising a lime
   * CLAIM state while the body text says the window closed. Collapse that transient
   * disagreement into one status the whole card renders from.
   */
  const effectiveStatus: WaitlistStatus =
    entry.status === 'offered' && countdown.expired ? 'expired' : entry.status;

  const settled = effectiveStatus === 'expired' || effectiveStatus === 'fulfilled';
  const offeredSeat = entry.offered_row_label
    ? `${entry.offered_row_label}${entry.offered_seat_number ?? ''}`
    : null;

  return (
    // Structurally the same block as BookingCard: a waitlist entry is the same kind
    // of object to the customer, so it should not read as a different species of row.
    <Card
      className={cn(
        'relative flex flex-col gap-4 overflow-hidden border-0 bg-card p-4',
        settled && 'opacity-70'
      )}
    >
      {/* Corner status tag, same position as a booking's. Lime only for `offered`:
          that is the one status that needs the customer to do something. */}
      <span
        className={cn(
          'eyebrow absolute right-4 top-4 z-10 flex items-center gap-1 px-2 py-1',
          WAITLIST_TAG[effectiveStatus]
        )}
      >
        {effectiveStatus === 'offered' ? <BellRing className="h-3.5 w-3.5" /> : null}
        {effectiveStatus}
      </span>

      <div className="flex flex-1 flex-col gap-4 sm:flex-row">
        {/* Decorative: the title sits immediately beside it. */}
        <Poster
          src={eventThumb(entry.event_id, 240)}
          alt={`Artwork for ${entry.event_title}`}
          type={entry.event_type}
          decorative
          className="aspect-square w-full shrink-0 sm:h-[120px] sm:w-[120px]"
          sizes="120px"
        />

        <div className="flex min-w-0 flex-1 flex-col justify-between">
          <div className="min-w-0">
            <p className="eyebrow text-muted-foreground">{entry.category}</p>
            {/* pr clears the absolute status tag so long titles never run under it. */}
            <CardTitle className="heading mt-1 truncate pr-24 text-display-md uppercase">
              {entry.event_title}
            </CardTitle>

            <dl className="mt-2 space-y-1 text-sm text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <CalendarDays className="h-4 w-4 shrink-0" />
                <dd className="truncate">
                  {formatDate(entry.date)} · {formatTime(entry.time)}
                </dd>
              </div>
              <div className="flex items-center gap-1.5">
                <MapPin className="h-4 w-4 shrink-0" />
                <dd className="truncate">{entry.venue_name}</dd>
              </div>
            </dl>
          </div>

          {/* Hard-edged strip carrying the entry's operative fact, mirroring the
              booking card's seat strip: a queue position while waiting, the reserved
              seat once one is offered. */}
          <div className="mt-3 flex items-end justify-between gap-3 border border-border-strong bg-background p-2">
            {/* A queue position is only a fact while still waiting — the server sends
                `position: null` for every other status, so keying this on the seat
                instead stops settled rows rendering a bare "Position —". */}
            {offeredSeat ? (
              <div className="min-w-0">
                <p className="eyebrow text-muted-foreground">
                  {/* Past tense once the seat is gone: an expired row is a record of a
                      seat that was held for this customer, not one they still have. */}
                  {settled && effectiveStatus === 'expired' ? 'Offered seat' : 'Your seat'}
                </p>
                <p className="tabular mt-0.5 truncate text-sm font-bold">{offeredSeat}</p>
              </div>
            ) : (
              <div className="min-w-0">
                <p className="eyebrow text-muted-foreground">Position</p>
                <p className="tabular mt-0.5 truncate text-sm font-bold">
                  {entry.position ? `#${entry.position} in queue` : '—'}
                </p>
              </div>
            )}

            {/* The deadline. Digits are aria-live so a screen reader is told when the
                window is nearly up, and urgent turns them red in the final minute. */}
            {offerLive ? (
              <div className="shrink-0 text-right">
                <p className="eyebrow text-muted-foreground">Time left</p>
                <p
                  aria-live={countdown.urgent ? 'assertive' : 'off'}
                  className={cn(
                    'tabular mt-0.5 flex items-center gap-1 text-sm font-bold',
                    countdown.urgent && 'text-destructive'
                  )}
                >
                  <Clock className="h-3.5 w-3.5" />
                  {formatDuration(countdown.remainingMs)}
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Joined {formatTimestamp(entry.joined_at)}
      </p>

      {offerLive && entry.offer_token ? (
        <div className="mt-auto">
          {/* Lime: a time-limited offer is the single most important action available
              on this screen, and the only lime CTA it spends. */}
          <Button variant="lime" className="w-full uppercase tracking-widest" asChild>
            <NavLink to={`/offer?token=${encodeURIComponent(entry.offer_token)}`}>
              Claim seat <Ticket />
            </NavLink>
          </Button>
        </div>
      ) : effectiveStatus === 'waiting' ? (
        <div className="mt-auto">
          <Button
            variant="ghost"
            className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setConfirmOpen(true)}
          >
            <XCircle /> Leave waitlist
          </Button>
        </div>
      ) : effectiveStatus === 'expired' ? (
        <p className="mt-auto border-l-4 border-destructive bg-card-alt p-2 text-xs text-muted-foreground">
          This reservation window closed and the seat passed to the next person waiting.
        </p>
      ) : effectiveStatus === 'fulfilled' ? (
        <p className="mt-auto text-xs text-muted-foreground">
          Claimed — the booking is in your Bookings tab.
        </p>
      ) : null}

      {/* --- Leave confirmation ------------------------------------------- */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave the {entry.category} waitlist?</AlertDialogTitle>
            <AlertDialogDescription>
              {entry.position
                ? `You are #${entry.position} in the queue for ${entry.event_title}. `
                : ''}
              Your place is given up immediately. Rejoining puts you at the back of the queue.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={leaveMutation.isPending}>Stay on it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                // Keep the dialog open until the request settles, so the pending
                // state is visible rather than an instant dismiss.
                e.preventDefault();
                leaveMutation.mutate();
              }}
            >
              {leaveMutation.isPending ? 'Leaving…' : 'Leave waitlist'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
