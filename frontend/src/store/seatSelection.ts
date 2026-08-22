import { create } from 'zustand';

/**
 * Seat selection — client-only state, so Zustand rather than React Query.
 *
 * "Selected" is purely local intent: seats the user has tapped but not yet asked
 * the server to hold. Once a hold succeeds the seats are server state and the seat
 * map's `held_by_me` flag becomes the source of truth, so selection is cleared.
 * Keeping those two concepts apart is what stops the UI from showing a seat as
 * "yours" when the server never agreed.
 *
 * Keyed by show id so navigating between two shows does not leak a selection from
 * one into the other.
 */

interface SeatSelectionState {
  /** showId -> selected seat ids */
  byShow: Record<number, number[]>;

  toggle: (showId: number, seatId: number, maxSeats: number) => 'added' | 'removed' | 'at-limit';
  clear: (showId: number) => void;
  set: (showId: number, seatIds: number[]) => void;
  remove: (showId: number, seatIds: number[]) => void;
}

export const useSeatSelectionStore = create<SeatSelectionState>()((set, get) => ({
  byShow: {},

  toggle: (showId, seatId, maxSeats) => {
    const current = get().byShow[showId] ?? [];

    if (current.includes(seatId)) {
      set((state) => ({
        byShow: { ...state.byShow, [showId]: current.filter((id) => id !== seatId) },
      }));
      return 'removed';
    }

    // The backend caps a hold request at 10 seat ids, so refuse locally rather
    // than letting the user build a selection the API will reject.
    if (current.length >= maxSeats) return 'at-limit';

    set((state) => ({ byShow: { ...state.byShow, [showId]: [...current, seatId] } }));
    return 'added';
  },

  clear: (showId) =>
    set((state) => {
      const { [showId]: _discarded, ...rest } = state.byShow;
      return { byShow: rest };
    }),

  set: (showId, seatIds) =>
    set((state) => ({ byShow: { ...state.byShow, [showId]: [...seatIds] } })),

  remove: (showId, seatIds) =>
    set((state) => {
      const drop = new Set(seatIds);
      const current = state.byShow[showId] ?? [];
      return { byShow: { ...state.byShow, [showId]: current.filter((id) => !drop.has(id)) } };
    }),
}));

/** Stable empty array so selectors do not return a new reference each render. */
const EMPTY: number[] = [];

export const useSelectedSeatIds = (showId: number): number[] =>
  useSeatSelectionStore((s) => s.byShow[showId] ?? EMPTY);

/** Maximum seats per hold/booking request, enforced by the backend. */
export const MAX_SEATS_PER_BOOKING = 10;
