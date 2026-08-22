import { Timer } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/datetime';

/**
 * Hold countdown.
 *
 * The value shown is derived from the server's absolute `hold_expires_at`, not a
 * local timer — see useCountdown for why that distinction matters. The ring is
 * decorative; the digits are the information, and they carry aria-live so a screen
 * reader user is told when time is nearly up without being spammed every second.
 */
export function HoldCountdown({
  remainingMs,
  progress,
  urgent,
  className,
}: {
  remainingMs: number;
  progress: number;
  urgent: boolean;
  className?: string;
}) {
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-end justify-between gap-3">
        <p className="eyebrow flex items-center gap-1.5 text-muted-foreground">
          <Timer className="h-3.5 w-3.5" aria-hidden />
          Seats held for you
        </p>
        {/* Urgency is a solid red block carrying white text, not red digits: the
            red on cream measures 6.17:1 as a fill and the digits stay legible. */}
        <span
          className={cn(
            'tabular text-xl font-bold leading-none',
            urgent && 'bg-destructive px-2 py-1 text-destructive-foreground'
          )}
        >
          {formatDuration(remainingMs)}
        </span>
      </div>

      {/*
        8px, solid, square ends, filling with cobalt — the spec's progress indicator,
        and the same treatment as the seat map's checkout bar so the two countdowns
        read as one mechanism. Replaces the old SVG ring, which was a soft device in a
        system with no soft devices.
      */}
      <div aria-hidden className="h-2 bg-card-alt">
        <div
          className={cn(
            'h-full transition-[width] duration-500 ease-linear',
            urgent ? 'bg-destructive' : 'bg-cobalt'
          )}
          style={{ width: `${Math.max(0, 100 - progress * 100)}%` }}
        />
      </div>

      <p
        className="text-xs text-muted-foreground"
        // Announce only at the coarse level; `polite` plus a short message keeps
        // it from reading out every tick.
        aria-live="polite"
      >
        {urgent
          ? `Less than a minute left — complete your booking now.`
          : `Complete your booking before the timer runs out.`}
      </p>
    </div>
  );
}
