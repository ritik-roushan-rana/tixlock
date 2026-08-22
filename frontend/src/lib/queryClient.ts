import { QueryClient } from '@tanstack/react-query';

import { ApiError } from './api/client';

/**
 * Shared QueryClient.
 *
 * Retry policy is the interesting part: a 4xx from this API is a decision, not a
 * transient fault. Retrying a 409 SEATS_UNAVAILABLE would hammer a contended seat
 * and retrying a 403 would never succeed, so client errors fail immediately and
 * only genuine infrastructure failures are retried.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof ApiError) {
          // Never retry a deliberate rejection.
          if (error.status >= 400 && error.status < 500) return false;
        }
        return failureCount < 2;
      },
    },
    mutations: {
      // Mutations here are seat claims and bookings. Retrying them automatically
      // risks double-submitting a booking, so retries are always explicit.
      retry: false,
    },
  },
});
