import { useEffect, useRef, useState } from 'react';

/**
 * Countdown driven by an absolute server deadline.
 *
 * ==========================================================================
 * WHY NOT A CLIENT-SIDE TIMER STARTED FROM THE TTL
 * ==========================================================================
 *
 * The naive approach — read `hold_ttl_minutes: 10` and count down from 600
 * seconds — breaks in three ordinary situations:
 *
 *   1. Page refresh mid-hold. A fresh timer restarts at 10:00 while the server
 *      deadline is 4 minutes away, so the user is told they have twice the time
 *      they actually have and their seats vanish while the clock still reads 5:00.
 *   2. Backgrounded tab. Browsers throttle timers in inactive tabs to once a
 *      minute or less, so an interval-based counter silently drifts behind.
 *   3. Device sleep. The interval simply stops; on wake the counter resumes from
 *      where it paused, now arbitrarily far from the truth.
 *
 * So this hook stores the absolute deadline (`hold_expires_at`, an ISO instant
 * produced by PostgreSQL's `now()`) and recomputes the remaining time from
 * `Date.now()` on every tick. Ticks then only drive re-renders; they never
 * accumulate state, so a missed tick costs nothing and the next one is correct.
 *
 * ==========================================================================
 * CLOCK SKEW
 * ==========================================================================
 *
 * `Date.now()` is the *client's* clock, which can be minutes off the server's. The
 * seat map response includes `server_time`, so passing it lets us measure the
 * offset once and subtract it — meaning the countdown reflects the server's view of
 * time, which is the only view that decides whether a hold is still valid.
 */
export interface CountdownResult {
  /** Milliseconds left according to the server's clock, never below zero. */
  remainingMs: number;
  /** True once the deadline has passed. */
  expired: boolean;
  /** True in the final minute, for styling urgency. */
  urgent: boolean;
  /** 0..1 progress through the window, when a total is known. */
  progress: number;
}

export function useCountdown({
  expiresAt,
  serverTime,
  totalMs,
  onExpire,
  tickMs = 500,
}: {
  /** Absolute deadline from the API. Null disables the countdown. */
  expiresAt: string | null | undefined;
  /** `server_time` from the same response, used to correct clock skew. */
  serverTime?: string | null;
  /** Full window length, for the progress ring. Defaults to the initial remainder. */
  totalMs?: number;
  onExpire?: () => void;
  tickMs?: number;
}): CountdownResult {
  const skewRef = useRef(0);
  const firedRef = useRef(false);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  // Measure the offset between the two clocks when a server timestamp arrives.
  // Positive skew means the client clock runs ahead of the server.
  useEffect(() => {
    if (!serverTime) {
      skewRef.current = 0;
      return;
    }
    const server = new Date(serverTime).getTime();
    if (Number.isFinite(server)) skewRef.current = Date.now() - server;
  }, [serverTime]);

  const deadline = expiresAt ? new Date(expiresAt).getTime() : null;

  const compute = (): number => {
    if (deadline === null || !Number.isFinite(deadline)) return 0;
    // Subtracting the skew converts "now" on this device into "now" on the server.
    return Math.max(0, deadline - (Date.now() - skewRef.current));
  };

  const [remainingMs, setRemainingMs] = useState(compute);
  const initialRef = useRef<number | null>(null);

  // Reset the one-shot expiry flag whenever a new deadline arrives, so a second
  // hold in the same session still fires onExpire.
  useEffect(() => {
    firedRef.current = false;
    initialRef.current = null;
    setRemainingMs(compute());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt]);

  useEffect(() => {
    if (deadline === null) {
      setRemainingMs(0);
      return;
    }

    const tick = () => {
      const next = compute();
      setRemainingMs(next);
      if (next <= 0 && !firedRef.current) {
        firedRef.current = true;
        onExpireRef.current?.();
      }
    };

    tick();
    const id = window.setInterval(tick, tickMs);

    // Recompute immediately on wake or tab focus rather than waiting for the next
    // interval, which may have been throttled to a minute or more.
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt, tickMs]);

  if (initialRef.current === null && remainingMs > 0) initialRef.current = remainingMs;
  const total = totalMs ?? initialRef.current ?? 0;

  return {
    remainingMs,
    expired: deadline !== null && remainingMs <= 0,
    urgent: remainingMs > 0 && remainingMs <= 60_000,
    progress: total > 0 ? Math.min(1, Math.max(0, 1 - remainingMs / total)) : 0,
  };
}
