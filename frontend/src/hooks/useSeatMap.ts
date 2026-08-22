import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { showsApi, waitlistApi, bookingsApi } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/client';
import { queryKeys } from '@/lib/queryKeys';
import type { SeatMap } from '@/lib/api/types';
import { useAuthStore } from '@/store/auth';
import { useSeatSelectionStore } from '@/store/seatSelection';

/** Seat map for a show. Anonymous-safe; auth adds the held_by_me flags. */
export function useSeatMapQuery(showId: number) {
  return useQuery({
    queryKey: queryKeys.shows.seatMap(showId),
    queryFn: () => showsApi.seatMap(showId),
    enabled: Number.isFinite(showId) && showId > 0,
    // Socket events keep this fresh, so background polling would be wasteful.
    // A moderate staleTime still covers the gap before the socket connects.
    staleTime: 15_000,
  });
}

/** Per-category counts. Drives the sold-out flag that gates the waitlist button. */
export function useAvailabilityQuery(showId: number) {
  return useQuery({
    queryKey: queryKeys.shows.availability(showId),
    queryFn: () => showsApi.availability(showId),
    enabled: Number.isFinite(showId) && showId > 0,
    staleTime: 15_000,
  });
}

/**
 * The caller's live holds on this show.
 *
 * This is what makes a mid-hold page refresh correct: the seat map alone tells us
 * *which* seats are ours, but this endpoint returns the authoritative
 * `hold_expires_at` and a `server_time` to calibrate the countdown against.
 */
export function useMyHoldsQuery(showId: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.shows.myHolds(showId),
    queryFn: () => showsApi.myHolds(showId),
    enabled: enabled && Number.isFinite(showId) && showId > 0,
    staleTime: 5_000,
  });
}

/** Flat list of seats from the nested row structure. */
export function flattenSeats(seatMap: SeatMap | undefined) {
  return seatMap ? seatMap.rows.flatMap((row) => row.seats) : [];
}

/* ---------------------------------------------------------------------------
 * Mutations
 * ------------------------------------------------------------------------- */

export function useHoldSeats(showId: number) {
  const queryClient = useQueryClient();
  const clearSelection = useSeatSelectionStore((s) => s.clear);
  const removeFromSelection = useSeatSelectionStore((s) => s.remove);

  return useMutation({
    mutationFn: (seatIds: number[]) => showsApi.hold(showId, seatIds),

    onSuccess: (result) => {
      // Selection has served its purpose: these seats are now server state, and
      // held_by_me on the refetched map becomes the source of truth.
      clearSelection(showId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.shows.seatMap(showId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.shows.myHolds(showId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.shows.availability(showId) });

      toast.success(
        `${result.seat_ids.length} seat${result.seat_ids.length === 1 ? '' : 's'} held`,
        { description: `Complete your booking within ${result.hold_ttl_minutes} minutes.` }
      );
    },

    onError: (error) => {
      /**
       * A 409 SEATS_UNAVAILABLE means somebody else won the race. The response
       * names exactly which seats were lost, so drop those from the selection and
       * refetch — leaving them selected would let the user retry a request that
       * cannot succeed.
       */
      if (error instanceof ApiError && error.isSeatConflict) {
        const lost = error.unavailableSeatIds;
        if (lost.length > 0) removeFromSelection(showId, lost);
        void queryClient.invalidateQueries({ queryKey: queryKeys.shows.seatMap(showId) });

        toast.error('Those seats just went', {
          description:
            lost.length > 0
              ? `${lost.length} seat${lost.length === 1 ? '' : 's'} were taken while you were choosing. Pick again.`
              : error.message,
        });
        return;
      }

      if (error instanceof ApiError && error.isForbidden) {
        toast.error('Only customer accounts can hold seats', { description: error.message });
        return;
      }

      toast.error(error instanceof Error ? error.message : 'Could not hold those seats');
    },
  });
}

export function useReleaseHold(showId: number) {
  const queryClient = useQueryClient();
  const clearSelection = useSeatSelectionStore((s) => s.clear);

  return useMutation({
    mutationFn: (seatIds?: number[]) => showsApi.releaseHold(showId, seatIds),
    onSuccess: (result) => {
      clearSelection(showId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.shows.seatMap(showId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.shows.myHolds(showId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.shows.availability(showId) });
      if (result.released > 0) toast.info('Your hold was released');
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Could not release your hold'),
  });
}

export function useConfirmBooking(showId: number) {
  const queryClient = useQueryClient();
  const clearSelection = useSeatSelectionStore((s) => s.clear);

  return useMutation({
    mutationFn: (seatIds: number[]) => bookingsApi.create({ show_id: showId, seat_ids: seatIds }),
    onSuccess: () => {
      clearSelection(showId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.shows.seatMap(showId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.shows.myHolds(showId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.shows.availability(showId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.bookings.all });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.isSeatConflict) {
        // Almost always an expired hold. Refetch so the map reflects reality
        // rather than leaving a stale "held by you" state on screen.
        void queryClient.invalidateQueries({ queryKey: queryKeys.shows.seatMap(showId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.shows.myHolds(showId) });
        toast.error('Your hold expired', {
          description: 'The seats were released. Please select them again.',
        });
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Could not complete your booking');
    },
  });
}

export function useJoinWaitlist(showId: number) {
  const queryClient = useQueryClient();
  const isSignedIn = useAuthStore((s) => Boolean(s.token));

  return useMutation({
    mutationFn: (category: string) => waitlistApi.join({ show_id: showId, category }),
    onSuccess: (entry) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.waitlist.mine() });
      toast.success(`You are number ${entry.position ?? 1} on the ${entry.category} waitlist`, {
        description: 'If a seat is released we will email you a link to claim it.',
      });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        // Either already queued, or the category actually still has seats — in the
        // latter case the map is stale, so refresh it.
        if (typeof error.details?.available === 'number') {
          void queryClient.invalidateQueries({ queryKey: queryKeys.shows.seatMap(showId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.shows.availability(showId) });
        }
        toast.error(error.message);
        return;
      }
      if (!isSignedIn) {
        toast.error('Sign in to join the waitlist');
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Could not join the waitlist');
    },
  });
}
