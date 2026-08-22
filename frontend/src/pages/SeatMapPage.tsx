import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, MapPin, Radio, RadioTower } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatDate, formatTime } from '@/lib/datetime';
import { eventTheme } from '@/lib/eventTheme';
import { queryKeys } from '@/lib/queryKeys';
import { waitlistApi } from '@/lib/api/endpoints';
import type { CreateBookingResponse, SeatUpdateReason } from '@/lib/api/types';
import { useAuthStore } from '@/store/auth';
import { MAX_SEATS_PER_BOOKING, useSeatSelectionStore, useSelectedSeatIds } from '@/store/seatSelection';
import {
  flattenSeats,
  useAvailabilityQuery,
  useConfirmBooking,
  useHoldSeats,
  useJoinWaitlist,
  useMyHoldsQuery,
  useReleaseHold,
  useSeatMapQuery,
} from '@/hooks/useSeatMap';
import { useSeatSocket } from '@/hooks/useSeatSocket';
import { useCountdown } from '@/hooks/useCountdown';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/common/states';
import { SeatMapGrid, SeatMapSkeleton } from '@/components/seatmap/SeatMapGrid';
import { SeatCheckoutBar } from '@/components/seatmap/SeatCheckoutBar';
import { AvailabilityPanel } from '@/components/seatmap/AvailabilityPanel';
import { TicketDialog } from '@/components/booking/TicketDialog';

/** Connection indicator. Live updates are an enhancement, never a requirement. */
function LiveIndicator({ status }: { status: 'connecting' | 'live' | 'reconnecting' | 'unavailable' }) {
  // Cobalt for "live" — this is informational status, which is exactly what cobalt
  // is for. Error red only when updates have actually stopped mattering; a
  // reconnecting socket is not a failure, so it stays muted ink.
  const config = {
    live: { label: 'Live', className: 'text-cobalt', icon: RadioTower },
    connecting: { label: 'Connecting', className: 'text-muted-foreground', icon: Radio },
    reconnecting: { label: 'Reconnecting', className: 'text-muted-foreground', icon: Radio },
    unavailable: { label: 'Updates paused', className: 'text-muted-foreground', icon: Radio },
  }[status];
  const Icon = config.icon;

  return (
    <span
      className={cn('eyebrow inline-flex items-center gap-1.5', config.className)}
      aria-live="polite"
      title={
        status === 'live'
          ? 'Seat changes appear instantly'
          : 'Live updates are not connected — refresh to see the latest seats'
      }
    >
      <Icon className={cn('h-3 w-3', status === 'live' && 'animate-pulse')} />
      {config.label}
    </span>
  );
}

export default function SeatMapPage() {
  const { showId: showIdParam } = useParams<{ showId: string }>();
  const showId = Number(showIdParam);
  const location = useLocation();

  const user = useAuthStore((s) => s.user);
  const isSignedIn = Boolean(useAuthStore((s) => s.token) && user);
  const isCustomer = user?.role === 'customer';

  const selectedIds = useSelectedSeatIds(showId);
  const toggleSeat = useSeatSelectionStore((s) => s.toggle);
  const clearSelection = useSeatSelectionStore((s) => s.clear);

  const seatMapQuery = useSeatMapQuery(showId);
  const availabilityQuery = useAvailabilityQuery(showId);
  const myHoldsQuery = useMyHoldsQuery(showId, isSignedIn && isCustomer);

  const holdMutation = useHoldSeats(showId);
  const releaseMutation = useReleaseHold(showId);
  const bookingMutation = useConfirmBooking(showId);
  const waitlistMutation = useJoinWaitlist(showId);

  const [ticket, setTicket] = useState<CreateBookingResponse | null>(null);
  const [joiningCategory, setJoiningCategory] = useState<string | null>(null);

  /**
   * Seats changed by a socket event, so they can animate once.
   *
   * Held in state (not a ref) because the animation is rendered, and cleared on a
   * timer so the class does not stick and block a later animation on the same seat.
   */
  const [recentlyChanged, setRecentlyChanged] = useState<Set<number>>(new Set());
  const clearTimerRef = useRef<number | null>(null);

  const handleSeatChange = useCallback((seatIds: number[], _reason: SeatUpdateReason) => {
    setRecentlyChanged(new Set(seatIds));
    if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current);
    clearTimerRef.current = window.setTimeout(() => setRecentlyChanged(new Set()), 400);
  }, []);

  useEffect(
    () => () => {
      if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current);
    },
    []
  );

  // One socket per seat-map view, torn down on unmount by the hook.
  const { status: socketStatus } = useSeatSocket({
    showId,
    viewerId: user?.id ?? null,
    enabled: Number.isFinite(showId) && showId > 0,
    onSeatChange: handleSeatChange,
  });

  const seatMap = seatMapQuery.data;
  const allSeats = useMemo(() => flattenSeats(seatMap), [seatMap]);

  const selectedSeats = useMemo(
    () => selectedIds.map((id) => allSeats.find((s) => s.id === id)).filter((s) => s !== undefined),
    [selectedIds, allSeats]
  );

  /** Seats the server says are ours. Authoritative — not derived from selection. */
  const heldSeats = useMemo(() => allSeats.filter((seat) => seat.held_by_me), [allSeats]);

  /**
   * Countdown source.
   *
   * Prefer /my-holds, which is the endpoint whose whole purpose is returning the
   * true deadline plus a server_time to calibrate against. Fall back to the seat
   * map's my_hold_expires_at so an anonymous-to-signed-in transition still shows a
   * timer before the holds query settles.
   */
  const holdExpiresAt =
    myHoldsQuery.data?.hold_expires_at ??
    heldSeats.find((seat) => seat.my_hold_expires_at)?.my_hold_expires_at ??
    null;

  const serverTime = myHoldsQuery.data?.server_time ?? seatMap?.server_time ?? null;

  const countdown = useCountdown({
    expiresAt: holdExpiresAt,
    serverTime,
    onExpire: () => {
      // The server has already released these seats; refetch so the UI agrees.
      toast.warning('Your hold expired', { description: 'The seats have been released.' });
      clearSelection(showId);
      void seatMapQuery.refetch();
      void myHoldsQuery.refetch();
    },
  });

  /** The viewer's waitlist entries, to show queue position on sold-out categories. */
  const myWaitlistQuery = useQuery({
    queryKey: queryKeys.waitlist.mine(),
    queryFn: waitlistApi.mine,
    enabled: isSignedIn && isCustomer,
    staleTime: 30_000,
  });

  const myWaitlistForShow = useMemo(
    () => (myWaitlistQuery.data ?? []).filter((entry) => entry.show_id === showId),
    [myWaitlistQuery.data, showId]
  );

  const handleSelectSeat = (seatId: number) => {
    // While a hold exists the selection is fixed: changing it would desynchronise
    // the held rows in the database from what the checkout panel shows.
    if (heldSeats.length > 0) {
      toast.info('You already have seats held', {
        description: 'Release your hold to choose different seats.',
      });
      return;
    }

    const result = toggleSeat(showId, seatId, MAX_SEATS_PER_BOOKING);
    if (result === 'at-limit') {
      toast.warning(`You can book up to ${MAX_SEATS_PER_BOOKING} seats at once`);
    }
  };

  const handleConfirm = async () => {
    const seatIds = heldSeats.map((seat) => seat.id);
    if (seatIds.length === 0) return;
    const result = await bookingMutation.mutateAsync(seatIds).catch(() => null);
    if (result) setTicket(result);
  };

  const handleJoinWaitlist = async (category: string) => {
    setJoiningCategory(category);
    try {
      await waitlistMutation.mutateAsync(category);
      await myWaitlistQuery.refetch();
    } catch {
      /* toast handled in the mutation */
    } finally {
      setJoiningCategory(null);
    }
  };

  const signInHref = `/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`;

  /* --- Invalid id ------------------------------------------------------- */
  if (!Number.isFinite(showId) || showId <= 0) {
    return (
      <ErrorState
        error={new Error('That show link is not valid.')}
        onRetry={() => window.history.back()}
      />
    );
  }

  /* --- Error ------------------------------------------------------------ */
  if (seatMapQuery.isError) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorState error={seatMapQuery.error} onRetry={() => void seatMapQuery.refetch()} />
      </div>
    );
  }

  /* --- Loading ---------------------------------------------------------- */
  if (seatMapQuery.isLoading || !seatMap) {
    return (
      <div className="space-y-6">
        <BackLink />
        <div className="space-y-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <Card className="border-0 bg-card">
            <CardContent className="p-4 sm:p-7">
              <SeatMapSkeleton />
            </CardContent>
          </Card>
          <div className="space-y-4">
            <Skeleton className="h-64" />
            <Skeleton className="h-40" />
          </div>
        </div>
      </div>
    );
  }

  const { show, summary } = seatMap;
  const theme = eventTheme(show.event.type);

  return (
    /* Bottom padding clears the fixed checkout bar so the last row of seats and the
       legend are never trapped underneath it. */
    <div className="space-y-6 pb-44 sm:pb-32">
      <BackLink to={`/events/${show.event.id}`} label="Back to event" />

      {/* --- Header ---------------------------------------------------------
          Type, not photography. The old version stacked a backdrop image under
          three gradients and a coloured wash; this system has none of those, and on
          a seat-picking screen the artwork was competing with the one thing the page
          exists for. What is left is an editorial title block: eyebrow row, Anton
          title, meta line, and the counts as a hard-edged readout. */}
      <header className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className={cn('eyebrow px-2 py-1', theme.chip)}>{theme.label}</span>
          <LiveIndicator status={socketStatus} />
        </div>

        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
          <div className="min-w-0 space-y-2">
            <h1 className="heading-xl text-display-lg">{show.event.title}</h1>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">
                {formatDate(show.date)} · {formatTime(show.time)}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5" />
                {show.venue.name}
              </span>
            </p>
          </div>

          {/*
            Counts read value-then-label, and that order is load-bearing:
            scripts/e2e/realtime.mjs matches /(\d+)\s*AVAILABLE/i against the page
            text to prove a socket patch moved the summary. Don't invert it.
          */}
          <div className="tabular flex gap-6">
            <Stat label="Available" value={summary.available} />
            <Stat label="Held" value={summary.held + summary.offered} />
            <Stat label="Booked" value={summary.booked} />
          </div>
        </div>
      </header>

      {/* --- Body -----------------------------------------------------------
          The single-column case needs an explicit `minmax(0,1fr)` too. Below `lg`
          this was a bare `grid`, whose implicit auto track is sized by its items'
          min-content — and the seat grid's min-content is the full uncompressed
          auditorium, so the track pushed the page ~22px wider than a 390px
          viewport and put a horizontal scrollbar on the whole document. The seat
          map is *supposed* to scroll sideways, but inside its own container. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* Flat tonal block — no gradient, no border, no shadow. The card area is
            defined by the surface step alone, which is how sectioning works here. */}
        <Card className="border-0 bg-card">
          <CardContent className="p-4 sm:p-7">
            <SeatMapGrid
              seatMap={seatMap}
              selectedIds={selectedIds}
              recentlyChanged={recentlyChanged}
              onSelectSeat={handleSelectSeat}
            />
          </CardContent>
        </Card>

        <AvailabilityPanel
          categories={availabilityQuery.data}
          loading={availabilityQuery.isLoading}
          myWaitlist={myWaitlistForShow}
          canJoin={isSignedIn && isCustomer}
          joiningCategory={joiningCategory}
          onJoin={handleJoinWaitlist}
        />
      </div>

      {/* Checkout is a fixed bar, so it sits outside the page flow. */}
      <SeatCheckoutBar
        selectedSeats={selectedSeats}
        heldSeats={heldSeats}
        isSignedIn={isSignedIn}
        isCustomer={isCustomer}
        countdown={countdown}
        onHold={() => holdMutation.mutate(selectedIds)}
        onConfirm={handleConfirm}
        onRelease={() => releaseMutation.mutate(undefined)}
        holding={holdMutation.isPending}
        confirming={bookingMutation.isPending}
        releasing={releaseMutation.isPending}
        signInHref={signInHref}
      />

      <TicketDialog
        booking={ticket?.booking ?? null}
        qrDataUrl={ticket?.qr_data_url ?? null}
        open={ticket !== null}
        onOpenChange={(open) => !open && setTicket(null)}
      />
    </div>
  );
}

/**
 * One summary count.
 *
 * Monochrome by design. These were previously tinted green / amber / grey, which
 * implied "held" is a warning and "booked" is disabled — neither is true, they are
 * just three counts of the same thing. Hierarchy comes from the Anton figure being
 * large and the label small, and the signal colours stay free to mean something.
 *
 * Value first, then label: realtime.mjs reads /(\d+)\s*AVAILABLE/i off the rendered
 * text, so this order is part of the contract.
 */
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="heading text-display-sm">{value}</p>
      <p className="eyebrow mt-1 text-muted-foreground">{label}</p>
    </div>
  );
}

function BackLink({ to = '/events', label = 'Back to events' }: { to?: string; label?: string }) {
  return (
    <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
      <NavLink to={to}>
        <ArrowLeft /> {label}
      </NavLink>
    </Button>
  );
}
