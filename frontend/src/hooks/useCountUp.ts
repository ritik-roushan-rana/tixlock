import { useEffect, useRef, useState } from 'react';

/**
 * Tweens a number towards a target with requestAnimationFrame.
 *
 * Exists so the running total in the checkout bar counts up when a seat is added
 * rather than snapping, which makes the price feel connected to the tap that caused
 * it. Hand-rolled rather than pulling in a spring/animation library: this is ~30
 * lines and the brief explicitly ruled out heavy animation dependencies.
 *
 * Notes on the implementation:
 *  - Tweens from whatever is currently on screen, not from the previous target, so
 *    interrupting mid-animation continues smoothly instead of jumping.
 *  - Rounds to 2dp each frame, because this drives a currency string and a value
 *    like 1299.9999998 would render as an odd intermediate.
 *  - Snaps instantly when the user prefers reduced motion, and when the delta is
 *    trivially small, so a 1-paise change does not schedule 20 frames.
 *  - Cancels on unmount and on every target change to avoid overlapping loops.
 */
export function useCountUp(target: number, durationMs = 420): number {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const displayRef = useRef(target);

  // Kept in a ref so the effect below can read the current on-screen value without
  // listing `display` as a dependency (which would restart the tween every frame).
  displayRef.current = display;

  useEffect(() => {
    const from = displayRef.current;
    const delta = target - from;

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (prefersReducedMotion || Math.abs(delta) < 0.01) {
      setDisplay(target);
      return;
    }

    const start = performance.now();

    const step = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / durationMs);
      // easeOutCubic: quick off the mark, settles gently onto the final value.
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round((from + delta * eased) * 100) / 100);

      if (t < 1) frameRef.current = requestAnimationFrame(step);
    };

    frameRef.current = requestAnimationFrame(step);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [target, durationMs]);

  return display;
}
