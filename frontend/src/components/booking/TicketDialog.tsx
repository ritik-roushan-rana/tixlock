import { CheckCircle2, Download } from 'lucide-react';
import { NavLink } from 'react-router-dom';

import { formatMoney } from '@/lib/money';
import { formatDate, formatTime } from '@/lib/datetime';
import type { CreatedBooking } from '@/lib/api/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Booking confirmation with the QR ticket.
 *
 * The QR encodes only the booking reference — no name, email or seat list. A QR
 * gets printed and shown to a stranger at a door, so anything in it is effectively
 * public; the reference is a lookup key against the authoritative record instead.
 */
export function TicketDialog({
  booking,
  qrDataUrl,
  open,
  onOpenChange,
}: {
  booking: CreatedBooking | null;
  qrDataUrl: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!booking) return null;

  const seatLabels = booking.seats
    .map((seat) => `${seat.row_label}${seat.seat_number}`)
    .join(', ');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {/* --- Success mark + headline -------------------------------------
            The reference opens with a lime square holding a single tick, then an
            Anton headline. Lime is spent here rather than on a button because on
            this screen the outcome *is* the most important thing — there is no
            competing action left to take. A tick in a square, not a circle: the
            shape language is 0px radius throughout. */}
        <DialogHeader className="items-center text-center">
          <div className="grid h-12 w-12 place-items-center bg-lime">
            <CheckCircle2 className="h-6 w-6 text-lime-foreground" aria-hidden />
          </div>
          {/* Copy kept as "Booking confirmed": it is the accessible name for the
              dialog, and scripts/e2e/journey.mjs waits on this string to prove the
              booking went through. */}
          <DialogTitle className="heading text-display-md">Booking confirmed</DialogTitle>
          <DialogDescription>
            A confirmation email with your ticket is on its way.
          </DialogDescription>
        </DialogHeader>

        {/* --- The ticket -------------------------------------------------
            One tonal block, no border and no shadow, split into details and a QR
            panel exactly as the reference lays it out. The QR sits on white rather
            than the block's cream, because a scanner wants maximum contrast and
            white is also what a printed ticket will be. */}
        <div className="grid gap-6 bg-card p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:p-6">
          <div className="min-w-0 space-y-4">
            <div>
              <p className="eyebrow text-muted-foreground">Event</p>
              <p className="heading mt-1 text-display-sm">{booking.show.event_title}</p>
            </div>

            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div className="min-w-0">
                <dt className="eyebrow text-muted-foreground">Date &amp; time</dt>
                <dd className="mt-1 font-semibold">{formatDate(booking.show.date)}</dd>
                <dd className="text-muted-foreground">{formatTime(booking.show.time)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="eyebrow text-muted-foreground">Venue</dt>
                <dd className="mt-1 truncate font-semibold">{booking.show.venue_name}</dd>
              </div>
            </dl>

            <dl className="space-y-4 border-t border-border pt-4 text-sm">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  <dt className="eyebrow text-muted-foreground">
                    Seats ({booking.seats.length})
                  </dt>
                  <dd className="tabular mt-1 font-semibold">{seatLabels}</dd>
                </div>
                {/* Status tag: solid ink fill, square, caps — as specified. */}
                <span className="eyebrow bg-panel px-2 py-1 text-panel-foreground">Confirmed</span>
              </div>

              <div className="flex items-end justify-between gap-3">
                <dt className="eyebrow text-muted-foreground">Total paid</dt>
                <dd className="tabular heading text-display-sm">
                  {formatMoney(booking.total_amount)}
                </dd>
              </div>
            </dl>
          </div>

          {/* --- QR ------------------------------------------------------- */}
          <div className="flex flex-col items-center gap-3 sm:w-44">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt={`QR code for booking ${booking.booking_ref}`}
                className="h-40 w-40 bg-white p-2"
              />
            ) : null}
            <p className="eyebrow text-muted-foreground">Scan at entry</p>
            {/*
              The reference has no reference number on the ticket face, but this one
              needs it: the QR encodes only this string, so if a scanner fails at the
              door it is the sole fallback that gets someone in. Monospaced and widely
              tracked so it can be read aloud or typed without transcription errors.
            */}
            <p className="font-mono text-sm font-bold tracking-widest">{booking.booking_ref}</p>
          </div>
        </div>

        <DialogFooter>
          {qrDataUrl ? (
            <Button variant="outline" asChild>
              <a href={qrDataUrl} download={`${booking.booking_ref}.png`}>
                <Download /> Save QR
              </a>
            </Button>
          ) : null}
          <Button asChild>
            <NavLink to="/bookings">View my tickets</NavLink>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
