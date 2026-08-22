import { NavLink } from 'react-router-dom';
import { Armchair, LogIn, Ticket, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatMoney, sumMoney } from '@/lib/money';
import { formatDuration } from '@/lib/datetime';
import type { SeatMapSeat } from '@/lib/api/types';
import { MAX_SEATS_PER_BOOKING } from '@/store/seatSelection';
import { useCountUp } from '@/hooks/useCountUp';
import { Button } from '@/components/ui/button';

/**
 * Sticky checkout bar.
 *
 * Replaces the old sidebar card. Same three mutually exclusive modes, driven by
 * server state rather than local flags:
 *   - nothing chosen          -> guidance
 *   - seats selected          -> "Hold seats" (selection is local only)
 *   - seats held (held_by_me) -> countdown + "Confirm booking" + "Release"
 *
 * Every prop, branch and handler is carried over unchanged from CheckoutPanel; only
 * the layout and styling differ. In particular the subtotal is still computed
 * locally for responsiveness while the amount actually charged is computed by the
 * server from show_pricing — the booking request carries no amount at all. sumMoney
 * works in integer paise so the two cannot disagree by a floating-point rounding
 * error.
 *
 * The bar renders in all states rather than appearing only once seats are chosen,
 * because the signed-out "Sign in to book" call to action has to be reachable before
 * a seat is tapped.
 */
export function SeatCheckoutBar({
  selectedSeats,
  heldSeats,
  isSignedIn,
  isCustomer,
  countdown,
  onHold,
  onConfirm,
  onRelease,
  holding,
  confirming,
  releasing,
  signInHref,
}: {
  selectedSeats: SeatMapSeat[];
  heldSeats: SeatMapSeat[];
  isSignedIn: boolean;
  isCustomer: boolean;
  countdown: { remainingMs: number; progress: number; urgent: boolean; expired: boolean };
  onHold: () => void;
  onConfirm: () => void;
  onRelease: () => void;
  holding: boolean;
  confirming: boolean;
  releasing: boolean;
  signInHref: string;
}) {
  const hasHold = heldSeats.length > 0;
  const seats = hasHold ? heldSeats : selectedSeats;
  const subtotal = sumMoney(seats.map((s) => s.price));
  const animatedTotal = useCountUp(subtotal);
  const showCountdown = hasHold && !countdown.expired;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40">
      {/*
        Full-bleed, pinned to the bottom edge. The "No Edge" rule frames *content*;
        a drawer is furniture, and the reference draws it edge to edge. Its contents
        still sit inside `container`, so they line up with the seat map above.
      */}
      <div>
        {/*
          Solid ink panel, square corners, no border and no blur. DESIGN.md calls for
          exactly this for a checkout drawer: "a solid #1A1A1A background with
          #F5F5F0 text to create a high-contrast pop without using shadows". The old
          translucent blurred card is gone for that reason.
        */}
        <div className="pointer-events-auto relative animate-slide-up bg-panel text-panel-foreground">
          {/*
            Elapsed-time bar across the top edge — 8px, solid, square ends, filling
            with cobalt, exactly as the spec describes a progress indicator. It gives
            the ambient sense of a window closing; the digits beside it give the
            precise figure. Only the final minute switches to the error colour, so the
            bar is calm early and urgent late.

            The track is cream and the fill is cobalt, not the other way round. A cream
            fill was tried first and is invisible: the bar sits on the panel's top edge
            against a cream page, so cream-on-cream disappeared at exactly the moment
            the timer mattered least-changed. Cobalt reads at 8.9:1 on the cream track,
            and the depleting bar reveals cream as it goes.
          */}
          {showCountdown ? (
            <div aria-hidden className="absolute inset-x-0 top-0 h-2 bg-background">
              <div
                className={cn(
                  'h-full transition-[width] duration-500 ease-linear',
                  countdown.urgent ? 'bg-destructive' : 'bg-cobalt'
                )}
                style={{ width: `${Math.max(0, 100 - countdown.progress * 100)}%` }}
              />
            </div>
          ) : null}

          <div className="container flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:gap-6 sm:py-5">
            {/* Ring and summary also share a row on mobile, for the same reason. */}
            <div className="flex min-w-0 items-center gap-3 sm:contents">
              {/* --- Countdown ring ------------------------------------------ */}
              {showCountdown ? (
                <CountdownReadout
                  remainingMs={countdown.remainingMs}
                  urgent={countdown.urgent}
                />
              ) : null}

              {/* --- Selection summary --------------------------------------- */}
              <div className="min-w-0 flex-1">
              {seats.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-panel-foreground/70">
                  <Armchair className="h-4 w-4 shrink-0" />
                  Tap a seat on the map to start choosing.
                </p>
              ) : (
                <>
                  <p className="eyebrow text-panel-foreground/70">
                    {hasHold ? 'Seats held for you' : 'Your selection'}
                    <span className="tabular ml-2 normal-case tracking-normal">
                      {seats.length} of {MAX_SEATS_PER_BOOKING}
                    </span>
                  </p>
                  <ul className="mt-2 flex flex-wrap items-center gap-1">
                    {seats.map((seat) => (
                      <li
                        key={seat.id}
                        className={cn(
                          'tabular px-2 py-1 text-[11px] font-bold',
                          // A held seat is lime because that is what the seat itself
                          // is on the map; a merely selected one is a cream outline.
                          // The chips and the grid have to agree or the bar stops
                          // being a readout of the map.
                          hasHold
                            ? 'bg-lime text-lime-foreground'
                            : 'border border-panel-foreground/40 text-panel-foreground'
                        )}
                        title={seat.category}
                      >
                        {seat.row_label}
                        {seat.seat_number}
                      </li>
                    ))}
                  </ul>
                  </>
                )}
              </div>
            </div>

            {/*
              On mobile the total and the action share one row, so the bar stays about
              two rows tall instead of three and stops eating the legend underneath it.
              `sm:contents` dissolves this wrapper at larger sizes so both children go
              back to being direct flex items of the bar.
            */}
            <div className="flex items-center justify-between gap-3 sm:contents">
              {/* --- Total -------------------------------------------------- */}
              {seats.length > 0 ? (
                <div className="shrink-0 text-left sm:text-right">
                  <p className="eyebrow text-panel-foreground/70">Total</p>
                  {/*
                    `key` on the value remounts it whenever the subtotal changes, which
                    replays the bump keyframe. The digits themselves are tweened by
                    useCountUp, so the number rolls rather than snapping.
                  */}
                  <p
                    key={subtotal}
                    className="tabular heading animate-value-bump text-2xl leading-tight"
                  >
                    {formatMoney(animatedTotal)}
                  </p>
                </div>
              ) : null}

              {/* --- Actions ------------------------------------------------ */}
              <div className="shrink-0">
                {/*
                  The single lime action per state — "Sign in to book", "Hold N
                  seats", "Confirm booking" — is the whole point of the bar, so it is
                  the one place on this screen that earns the signal colour. Release
                  is a cream 1px outline: reachable, clearly secondary, and legible on
                  ink (the shared `outline` variant assumes a cream page, so it is
                  inverted here rather than reused).
                */}
                {!isSignedIn ? (
                  <Button asChild variant="lime" size="lg">
                    <NavLink to={signInHref}>
                      <LogIn /> Sign in to book
                    </NavLink>
                  </Button>
                ) : !isCustomer ? (
                  <p className="max-w-xs border-l-4 border-destructive bg-panel-foreground/10 px-3 py-2 text-xs text-panel-foreground">
                    Only customer accounts can book seats. You are signed in with a
                    staff account.
                  </p>
                ) : hasHold ? (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="lg"
                      className="border border-panel-foreground/50 text-panel-foreground hover:bg-panel-foreground/15 hover:text-panel-foreground"
                      onClick={onRelease}
                      loading={releasing}
                    >
                      <Trash2 />
                      <span className="hidden sm:inline">Release my hold</span>
                      <span className="sm:hidden">Release</span>
                    </Button>
                    <Button
                      variant="lime"
                      size="lg"
                      onClick={onConfirm}
                      loading={confirming}
                      disabled={countdown.expired}
                    >
                      <Ticket /> Confirm booking
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="lime"
                    size="lg"
                    onClick={onHold}
                    loading={holding}
                    disabled={selectedSeats.length === 0}
                  >
                    {selectedSeats.length === 0
                      ? 'Hold seats'
                      : `Hold ${selectedSeats.length} seat${selectedSeats.length === 1 ? '' : 's'}`}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Hold deadline readout.
 *
 * Replaces the old SVG progress ring. A ring is a soft, decorative device and it
 * duplicated the 8px bar already running along the top edge of the panel, so what is
 * left is just the thing that carries the information: the digits, large and tabular
 * so they don't jitter as they tick down.
 *
 * Urgency is a solid red block with white text rather than red digits on ink. Red
 * text on this panel measures about 3.4:1, which fails AA; the same red as a fill
 * behind white text is 6.17:1 and passes, and a filled status box is what the spec
 * asks for anyway.
 *
 * The digits stay readable to assistive tech but are not themselves a live region;
 * the sr-only line beside them is, so a screen reader is told once when time is
 * nearly up instead of being read a new value every second.
 */
function CountdownReadout({ remainingMs, urgent }: { remainingMs: number; urgent: boolean }) {
  return (
    <div className="flex shrink-0 items-center gap-3">
      <div className={cn('px-2.5 py-1.5', urgent && 'bg-destructive')}>
        <p
          className={cn(
            'eyebrow',
            urgent ? 'text-destructive-foreground' : 'text-panel-foreground/70'
          )}
        >
          Time left
        </p>
        <p
          className={cn(
            'tabular mt-1 text-xl font-bold leading-none',
            urgent ? 'text-destructive-foreground' : 'text-panel-foreground'
          )}
        >
          {formatDuration(remainingMs)}
        </p>
      </div>
      <p className="sr-only" aria-live="polite">
        {urgent
          ? 'Less than a minute left — complete your booking now.'
          : 'Complete your booking before the timer runs out.'}
      </p>
    </div>
  );
}
