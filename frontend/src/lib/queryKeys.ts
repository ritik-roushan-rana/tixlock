import type { EventFilters } from './api/types';

/**
 * Centralised React Query keys.
 *
 * Kept in one place because the seat map's socket handler reaches into the cache
 * with `queryClient.setQueryData(...)` to patch individual seats. A key typo there
 * fails silently — the patch writes to a cache entry nobody reads, and the UI just
 * stops updating. Defining keys once removes that whole class of bug.
 */
export const queryKeys = {
  health: ['health'] as const,

  auth: {
    me: ['auth', 'me'] as const,
  },

  venues: {
    all: ['venues'] as const,
    list: () => [...queryKeys.venues.all, 'list'] as const,
    detail: (venueId: number) => [...queryKeys.venues.all, 'detail', venueId] as const,
  },

  events: {
    all: ['events'] as const,
    list: (filters: EventFilters = {}) => [...queryKeys.events.all, 'list', filters] as const,
    mine: () => [...queryKeys.events.all, 'mine'] as const,
    detail: (eventId: number) => [...queryKeys.events.all, 'detail', eventId] as const,
  },

  shows: {
    all: ['shows'] as const,
    detail: (showId: number) => [...queryKeys.shows.all, 'detail', showId] as const,
    /** The seat map — patched in place by socket events. */
    seatMap: (showId: number) => [...queryKeys.shows.all, 'seatMap', showId] as const,
    availability: (showId: number) => [...queryKeys.shows.all, 'availability', showId] as const,
    myHolds: (showId: number) => [...queryKeys.shows.all, 'myHolds', showId] as const,
  },

  bookings: {
    all: ['bookings'] as const,
    list: () => [...queryKeys.bookings.all, 'list'] as const,
    detail: (bookingId: number) => [...queryKeys.bookings.all, 'detail', bookingId] as const,
    qr: (bookingId: number) => [...queryKeys.bookings.all, 'qr', bookingId] as const,
  },

  waitlist: {
    all: ['waitlist'] as const,
    mine: () => [...queryKeys.waitlist.all, 'mine'] as const,
    offer: (token: string) => [...queryKeys.waitlist.all, 'offer', token] as const,
  },

  dashboard: {
    all: ['dashboard'] as const,
    summary: () => [...queryKeys.dashboard.all, 'summary'] as const,
    eventReport: (eventId: number) => [...queryKeys.dashboard.all, 'event', eventId] as const,
    eventBookings: (eventId: number) =>
      [...queryKeys.dashboard.all, 'event', eventId, 'bookings'] as const,
  },
} as const;
