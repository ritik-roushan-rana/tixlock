import { useState } from 'react';
import { NavLink, useLocation, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BellRing, CalendarDays, LogIn, MapPin, Ticket } from 'lucide-react';

import { bookingsApi, waitlistApi } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/client';
import { queryKeys } from '@/lib/queryKeys';
import { formatMoney, toMoneyOrNull } from '@/lib/money';
import { formatDate, formatTime } from '@/lib/datetime';
import type { AcceptOfferResponse, CreateBookingResponse } from '@/lib/api/types';
import { useAuthStore } from '@/store/auth';
import { useCountdown } from '@/hooks/useCountdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/common/states';
import { HoldCountdown } from '@/components/seatmap/HoldCountdown';
import { TicketDialog } from '@/components/booking/TicketDialog';

/**
 * Waitlist offer landing page — reached from the emailed link, /offer?token=…
 *
 * The flow is three steps, each backed by a different server state:
 *   1. Read the offer (public endpoint; the token is the credential, so this
 *      renders even for a visitor with no session).
 *   2. Accept it — single use, and only by the customer it was issued to. This
 *      converts the reservation into an ordinary hold with a fresh 10-minute TTL.
 *   3. Complete the booking through the normal booking endpoint.
 *
 * Both countdowns come from absolute server deadlines: the offer window from
 * `offer_expires_at`, then the checkout window from the accept response's
 * `hold_expires_at`.
 */
export default function OfferPage() {
  const [params] = useSearchParams();
  const location = useLocation();
  const token = params.get('token');

  const user = useAuthStore((s) => s.user);
  const isSignedIn = Boolean(useAuthStore((s) => s.token) && user);
  const isCustomer = user?.role === 'customer';

  const [claimed, setClaimed] = useState<AcceptOfferResponse | null>(null);
  const [ticket, setTicket] = useState<CreateBookingResponse | null>(null);

  const offerQuery = useQuery({
    queryKey: queryKeys.waitlist.offer(token ?? ''),
    queryFn: () => waitlistApi.getOffer(token!),
    enabled: Boolean(token),
    retry: false,
    // The offer window is ticking, so do not serve a stale copy.
    staleTime: 0,
  });

  const acceptMutation = useMutation({
    mutationFn: () => waitlistApi.acceptOffer(token!),
    onSuccess: (result) => {
      setClaimed(result);
      toast.success('Seat claimed', {
        description: `Complete your booking within ${result.hold_ttl_minutes} minutes.`,
      });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        // Already used, expired, or issued to a different customer — the message
        // from the server distinguishes these, so surface it verbatim.
        toast.error(error.message);
        void offerQuery.refetch();
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Could not claim this seat');
    },
  });

  const bookMutation = useMutation({
    mutationFn: () =>
      bookingsApi.create({ show_id: claimed!.show_id, seat_ids: claimed!.seat_ids }),
    onSuccess: (result) => setTicket(result),
    onError: (error) => {
      if (error instanceof ApiError && error.isSeatConflict) {
        toast.error('Your hold expired', { description: 'The seat has been passed on.' });
        setClaimed(null);
        void offerQuery.refetch();
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Could not complete your booking');
    },
  });

  const offer = offerQuery.data;

  const offerCountdown = useCountdown({
    expiresAt: claimed ? null : (offer?.offer_expires_at ?? null),
    onExpire: () => void offerQuery.refetch(),
  });

  const holdCountdown = useCountdown({
    expiresAt: claimed?.hold_expires_at ?? null,
    onExpire: () => {
      toast.warning('Your hold expired', { description: 'The seat has been released.' });
      setClaimed(null);
      void offerQuery.refetch();
    },
  });

  /* --- No token --------------------------------------------------------- */
  if (!token) {
    return (
      <div className="mx-auto max-w-lg py-8">
        <EmptyState
          icon={<BellRing className="h-5 w-5" />}
          title="This link is missing its offer token"
          description="Open the link from your email, or check your waitlist status in My tickets."
          action={
            <Button variant="outline" asChild>
              <NavLink to="/bookings">Go to my tickets</NavLink>
            </Button>
          }
        />
      </div>
    );
  }

  /* --- Loading / error -------------------------------------------------- */
  if (offerQuery.isLoading) {
    return (
      <div className="mx-auto max-w-lg space-y-4 py-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  if (offerQuery.isError) {
    const isGone = offerQuery.error instanceof ApiError && offerQuery.error.status === 404;
    return (
      <div className="mx-auto max-w-lg py-8">
        {isGone ? (
          <EmptyState
            icon={<BellRing className="h-5 w-5" />}
            title="This offer is no longer available"
            description="The link may have already been used, or the reservation window closed and the seat passed to the next person waiting."
            action={
              <Button variant="outline" asChild>
                <NavLink to="/bookings">Check my waitlist</NavLink>
              </Button>
            }
          />
        ) : (
          <ErrorState error={offerQuery.error} onRetry={() => void offerQuery.refetch()} />
        )}
      </div>
    );
  }

  if (!offer) return null;

  const price = toMoneyOrNull(offer.seat.price);
  const windowClosed = !offer.still_valid || (!claimed && offerCountdown.expired);

  return (
    <div className="mx-auto max-w-lg space-y-4 py-6 sm:py-10">
      <div className="space-y-1 text-center">
        <span className="mx-auto grid h-10 w-10 place-items-center bg-primary text-primary-foreground">
          <BellRing className="h-5 w-5" />
        </span>
        <h1 className="heading text-display-lg">A seat is reserved for you</h1>
        <p className="text-sm text-muted-foreground">
          You joined the {offer.category} waitlist and a seat has become available.
        </p>
      </div>

      <Card className="border-0 bg-card">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="heading text-display-sm">{offer.show.event_title}</CardTitle>
            {/* Outline: a price tier is a neutral label. `warning` is cobalt, which
                this system spends on "look here", and a category name isn't that. */}
            <Badge variant="outline" className="shrink-0">
              {offer.category}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <dl className="space-y-1.5 text-sm text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <CalendarDays className="h-3.5 w-3.5 shrink-0" />
              <dd>
                {formatDate(offer.show.date)} · {formatTime(offer.show.time)}
              </dd>
            </div>
            <div className="flex items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5 shrink-0" />
              <dd>{offer.show.venue_name}</dd>
            </div>
          </dl>

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Your seat</p>
              <p className="text-lg font-semibold">
                {offer.seat.row_label}
                {offer.seat.seat_number}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Price</p>
              <p className="tabular text-lg font-semibold">
                {price === null ? '—' : formatMoney(price)}
              </p>
            </div>
          </div>

          <Separator />

          {/* --- Step 3: booked -------------------------------------------- */}
          {ticket ? (
            <div className="space-y-3 text-center">
              {/* Lime block, matching TicketDialog's success mark. Green `--success`
                  text is a leftover from the old palette and is not a signal colour
                  in this system. The wording is unchanged — realtime.mjs waits on it. */}
              <p className="eyebrow inline-block bg-lime px-2 py-1 text-lime-foreground">
                Booking confirmed
              </p>
              <p className="font-mono text-lg font-bold tracking-widest">
                {ticket.booking.booking_ref}
              </p>
              <Button asChild variant="outline" className="w-full">
                <NavLink to="/bookings">View my tickets</NavLink>
              </Button>
            </div>
          ) : claimed ? (
            /* --- Step 2: claimed, awaiting payment ----------------------- */
            <div className="space-y-3">
              <HoldCountdown
                remainingMs={holdCountdown.remainingMs}
                progress={holdCountdown.progress}
                urgent={holdCountdown.urgent}
              />
              <Button
                variant="lime"
                className="w-full"
                onClick={() => bookMutation.mutate()}
                loading={bookMutation.isPending}
                disabled={holdCountdown.expired}
              >
                <Ticket /> Confirm booking
              </Button>
            </div>
          ) : windowClosed ? (
            /* --- Window closed ------------------------------------------- */
            <div className="space-y-2 border-l-4 border-destructive bg-card-alt p-3">
              <p className="text-sm font-semibold">This reservation window closed</p>
              <p className="text-xs text-muted-foreground">
                The seat has been passed to the next person waiting.
              </p>
            </div>
          ) : (
            /* --- Step 1: claim -------------------------------------------- */
            <div className="space-y-3">
              <div className="flex items-center justify-between bg-card-alt px-3 py-2">
                <span className="eyebrow text-muted-foreground">Reserved for another</span>
                <span
                  className={`tabular font-bold ${offerCountdown.urgent ? 'text-destructive' : ''}`}
                >
                  {Math.floor(offerCountdown.remainingMs / 60_000)}m
                </span>
              </div>

              {!isSignedIn ? (
                <>
                  <Button asChild variant="lime" className="w-full">
                    <NavLink
                      to={`/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`}
                    >
                      <LogIn /> Sign in to claim
                    </NavLink>
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    The seat stays reserved for you until the timer runs out.
                  </p>
                </>
              ) : !isCustomer ? (
                <p className="border-l-4 border-destructive bg-card-alt px-3 py-2 text-xs">
                  Offers can only be claimed by the customer account they were issued to. You are
                  signed in as {user?.role}.
                </p>
              ) : (
                <>
                  <Button
                    variant="lime"
                    className="w-full"
                    onClick={() => acceptMutation.mutate()}
                    loading={acceptMutation.isPending}
                  >
                    <Ticket /> Claim this seat
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    This link works once. If you do not claim it in time the seat passes to the next
                    person waiting.
                  </p>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <TicketDialog
        booking={ticket?.booking ?? null}
        qrDataUrl={ticket?.qr_data_url ?? null}
        open={ticket !== null}
        onOpenChange={(open) => !open && setTicket(null)}
      />
    </div>
  );
}
