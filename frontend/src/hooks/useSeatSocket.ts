import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';

import { SOCKET_URL } from '@/lib/api/client';
import { queryKeys } from '@/lib/queryKeys';
import type {
  AvailabilityChangedPayload,
  SeatMap,
  SeatsUpdatedPayload,
  SeatUpdateReason,
} from '@/lib/api/types';

export type SocketStatus = 'connecting' | 'live' | 'reconnecting' | 'unavailable';

/**
 * Live seat-map updates for a single show.
 *
 * ==========================================================================
 * PRIVACY BY DESIGN: WHY `seats:updated` HAS NO `held_by`
 * ==========================================================================
 *
 * The backend's `seats:updated` payload deliberately omits the `held_by` column.
 * Every client watching a show sits in the same Socket.io room and receives the
 * identical broadcast, so including the holder's user id would disclose one
 * customer's identity to every other customer looking at that seat map.
 *
 * This is an intentional privacy decision in the backend, NOT an oversight or a
 * missing field. Do not "fix" it by adding `held_by` to the emit payload.
 *
 * The consequence for this client is concrete and worth stating plainly: it is
 * impossible to derive `held_by_me` from a socket event. A broadcast can tell us
 * *that* seat 42 became `held`; it cannot tell us whether we are the holder.
 *
 * The payload does carry `actorId` — the id of the user who caused the change,
 * or null for cron-driven expiry sweeps. That is safe to broadcast because a
 * client only ever compares it against its own id, which it already knows. It
 * gives us just enough to distinguish "I did this" from "someone else did".
 *
 * So the patch strategy is:
 *
 *   1. For seats the viewer does NOT hold, apply the incoming status directly.
 *      No ownership information is required to colour a seat as taken by someone
 *      else, so a targeted cache patch is sufficient and we never refetch.
 *
 *   2. For a seat the viewer DOES currently hold, where the change was caused by
 *      somebody other than the viewer (or by the sweeper), invalidate and refetch
 *      the seat map. Only an authenticated GET /shows/:id/seats can re-establish
 *      `held_by_me` and `my_hold_expires_at` truthfully. This is the one case that
 *      needs a network round trip, and it is rare — it means the viewer's hold was
 *      expired or their seat was reassigned.
 *
 * Everything else is patched in place via setQueryData, so a busy show does not
 * trigger a refetch storm and the grid never blanks out mid-interaction.
 */
export function useSeatSocket({
  showId,
  viewerId,
  enabled = true,
  onSeatChange,
}: {
  showId: number;
  /** The signed-in user's id, or null when browsing anonymously. */
  viewerId: number | null;
  enabled?: boolean;
  /** Notified for each changed seat, so the UI can flash it. */
  onSeatChange?: (seatIds: number[], reason: SeatUpdateReason) => void;
}) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SocketStatus>('connecting');

  // Held in refs so the effect below depends only on showId — re-running it on
  // every render would tear down and rebuild the socket constantly.
  const onSeatChangeRef = useRef(onSeatChange);
  onSeatChangeRef.current = onSeatChange;
  const viewerIdRef = useRef(viewerId);
  viewerIdRef.current = viewerId;

  useEffect(() => {
    if (!enabled || !Number.isFinite(showId)) return;

    // SOCKET_URL is '' for same-origin, which io() handles by using the page origin.
    const socket: Socket = io(SOCKET_URL || '/', {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
    });

    const seatMapKey = queryKeys.shows.seatMap(showId);

    socket.on('connect', () => {
      setStatus('live');
      // The server expects a RAW NUMBER here, not an object. It also auto-leaves
      // any previously joined show room, so one socket only ever watches one show.
      socket.emit('show:join', showId);
    });

    socket.on('disconnect', () => setStatus('reconnecting'));

    /**
     * After several consecutive failures, stop claiming we are "reconnecting" and
     * admit the connection is not coming back. Reconnection continues in the
     * background, but the UI should not imply an imminent recovery — a viewer who
     * knows updates are stale will refresh, which is the correct recovery.
     */
    let failedAttempts = 0;
    const noteFailure = () => {
      failedAttempts += 1;
      setStatus(failedAttempts >= 5 ? 'unavailable' : 'reconnecting');
    };
    socket.io.on('reconnect_attempt', noteFailure);
    socket.on('connect_error', noteFailure);
    socket.on('connect', () => {
      failedAttempts = 0;
    });

    socket.on('seats:updated', (payload: SeatsUpdatedPayload) => {
      // Defensive: the server scopes broadcasts by room, but a stale room
      // membership during reconnection should never corrupt another show's cache.
      if (Number(payload.showId) !== showId) return;

      const current = queryClient.getQueryData<SeatMap>(seatMapKey);
      if (!current) return;

      const incoming = new Map(payload.seats.map((s) => [s.id, s]));
      const causedByViewer =
        payload.actorId !== null && viewerIdRef.current !== null && payload.actorId === viewerIdRef.current;

      // Does this event touch a seat we believe we hold, without us causing it?
      const affectsOurHold = current.rows.some((row) =>
        row.seats.some((seat) => seat.held_by_me && incoming.has(seat.id))
      );

      if (affectsOurHold && !causedByViewer) {
        // See the header comment: only an authenticated refetch can restore
        // held_by_me / my_hold_expires_at correctly.
        void queryClient.invalidateQueries({ queryKey: seatMapKey });
        void queryClient.invalidateQueries({ queryKey: queryKeys.shows.myHolds(showId) });
        onSeatChangeRef.current?.([...incoming.keys()], payload.reason);
        return;
      }

      queryClient.setQueryData<SeatMap>(seatMapKey, (prev) => {
        if (!prev) return prev;

        let changed = false;
        const rows = prev.rows.map((row) => {
          let rowChanged = false;
          const seats = row.seats.map((seat) => {
            const update = incoming.get(seat.id);
            if (!update) return seat;
            if (seat.status === update.status && seat.price === update.price) return seat;

            rowChanged = true;
            return {
              ...seat,
              status: update.status,
              price: update.price,
              // A seat that just became available cannot still be ours. Any other
              // transition leaves held_by_me alone: for our own actions the
              // mutation's own response is authoritative, and the
              // someone-else-touched-our-seat case refetched above.
              held_by_me: update.status === 'available' ? false : seat.held_by_me,
              my_hold_expires_at:
                update.status === 'available' ? null : seat.my_hold_expires_at,
            };
          });

          if (!rowChanged) return row;
          changed = true;
          return { ...row, seats };
        });

        if (!changed) return prev;

        // Keep the summary consistent with the patched rows so the header counts
        // do not drift from the grid.
        const summary = { total: 0, available: 0, held: 0, booked: 0, offered: 0 };
        for (const row of rows) {
          for (const seat of row.seats) {
            summary.total += 1;
            summary[seat.status] += 1;
          }
        }

        return { ...prev, rows, summary };
      });

      onSeatChangeRef.current?.([...incoming.keys()], payload.reason);
    });

    socket.on('availability:changed', (payload: AvailabilityChangedPayload) => {
      if (Number(payload.showId) !== showId) return;
      // Per-category counts are a small, cheap query and the source of the
      // sold-out flag that gates the waitlist button, so refetch rather than
      // trying to recompute it client-side.
      void queryClient.invalidateQueries({ queryKey: queryKeys.shows.availability(showId) });
    });

    return () => {
      // Leave explicitly before closing: the server keeps room membership per
      // socket, and an orderly leave avoids relying on disconnect cleanup.
      socket.emit('show:leave', showId);
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [showId, enabled, queryClient]);

  return { status };
}
