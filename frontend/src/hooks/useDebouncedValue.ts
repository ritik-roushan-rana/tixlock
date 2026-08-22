import { useEffect, useState } from 'react';

/**
 * Debounce a rapidly changing value.
 *
 * Used for the event search box so typing produces one request after the user
 * pauses, rather than one per keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
