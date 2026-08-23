/**
 * TypeScript mirrors of the real backend responses.
 *
 * Every shape here was captured from the running API, not inferred from the
 * schema. Where the API is inconsistent that inconsistency is encoded honestly
 * (see `Money`) rather than papered over with a lie that would blow up at runtime.
 */

/* ---------------------------------------------------------------------------
 * Primitives
 * ------------------------------------------------------------------------- */

/**
 * A monetary value as the API actually sends it.
 *
 * Top-level NUMERIC columns arrive as exact decimal strings ("650.00"); the same
 * value nested inside a json_agg arrives as a JavaScript number (650). Normalise
 * with `toMoney()` from '@/lib/money' — never read `.price` straight into UI.
 */
export type Money = string | number;

/** `YYYY-MM-DD`, no timezone. Parse with parseApiDate, never `new Date()`. */
export type ApiDate = string;

/** `HH:MM:SS`, no timezone. */
export type ApiTime = string;

/** ISO-8601 instant with `Z` — safe for `new Date()`. */
export type ApiTimestamp = string;

/* ---------------------------------------------------------------------------
 * Enums — exact values from the Postgres enum types
 * ------------------------------------------------------------------------- */

export type UserRole = 'customer' | 'organiser' | 'admin';
export type EventType = 'movie' | 'concert';
export type BookingStatus = 'confirmed' | 'cancelled';
export type WaitlistStatus = 'waiting' | 'offered' | 'expired' | 'fulfilled';

/**
 * Four values, not three. `offered` is a seat reserved for a waitlisted customer,
 * which the backend's cron sweep must treat differently from an ordinary `held`
 * seat: an expired hold is released, an expired offer cascades to the next person
 * in the queue.
 */
export type SeatStatus = 'available' | 'held' | 'booked' | 'offered';

export const EVENT_TYPES: readonly EventType[] = ['movie', 'concert'] as const;

/* ---------------------------------------------------------------------------
 * Errors
 * ------------------------------------------------------------------------- */

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SEATS_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'DB_UNAVAILABLE'
  | 'TIMEOUT'
  | 'NETWORK';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode | string;
    message: string;
    details?: Record<string, unknown> & {
      /** Present on SEATS_UNAVAILABLE: which seats the caller lost. */
      unavailableSeatIds?: number[];
      /** Present when joining a waitlist for a category that still has seats. */
      available?: number;
      missingCategories?: string[];
      unknownCategories?: string[];
      venueCategories?: string[];
      showCount?: number;
    };
  };
}

/* ---------------------------------------------------------------------------
 * Auth
 * ------------------------------------------------------------------------- */

export interface User {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  created_at: ApiTimestamp;
}

export interface AuthResponse {
  user: User;
  token: string;
}

export interface MeResponse {
  user: User;
}

/** Only these two are self-registerable; `admin` is seeded server-side. */
export type RegisterRole = Extract<UserRole, 'customer' | 'organiser'>;

export interface RegisterPayload {
  name: string;
  email: string;
  password: string;
  role?: RegisterRole;
}

export interface LoginPayload {
  email: string;
  password: string;
}

/* ---------------------------------------------------------------------------
 * Venues
 * ------------------------------------------------------------------------- */

export interface VenueListItem {
  id: number;
  name: string;
  address: string;
  created_by: number;
  created_at: ApiTimestamp;
  seat_count: number;
  category_count: number;
  event_count: number;
}

export interface VenueSeat {
  id: number;
  seat_number: number;
  category: string;
}

export interface VenueRow {
  row_label: string;
  category: string;
  seats: VenueSeat[];
}

export interface VenueDetail {
  id: number;
  name: string;
  address: string;
  created_by: number;
  created_at: ApiTimestamp;
  categories: string[];
  seat_count: number;
  rows: VenueRow[];
  /** True once any show exists for this venue — the layout is then frozen. */
  locked: boolean;
  show_count: number;
}

/** One row of a seat layout definition. */
export interface LayoutRowSpec {
  row_label: string;
  seats: number;
  category: string;
}

export interface CreateVenuePayload {
  name: string;
  address?: string;
  layout?: LayoutRowSpec[];
}

export interface DefineLayoutResponse {
  venue_id: number;
  seats_created: number;
  rows_created: number;
  venue: VenueDetail;
}

/* ---------------------------------------------------------------------------
 * Events and shows
 * ------------------------------------------------------------------------- */

export interface EventListItem {
  id: number;
  title: string;
  type: EventType;
  organiser_id: number;
  venue_id: number;
  description: string;
  created_at: ApiTimestamp;
  venue_name: string;
  venue_address: string;
  organiser_name: string;
  show_count: number;
  /** Null when the event has no shows. */
  next_show_date: ApiDate | null;
  /** Cheapest priced category across the event's shows. Null when unpriced. */
  from_price: Money | null;
}

export interface ShowPricing {
  category: string;
  price: Money;
}

/** A show as returned inside GET /events/:id. */
export interface EventShow {
  id: number;
  date: ApiDate;
  time: ApiTime;
  created_at: ApiTimestamp;
  total_seats: number;
  /** Counts seats whose hold has lapsed as available, regardless of the cron. */
  available_seats: number;
  booked_seats: number;
  pricing: ShowPricing[];
}

export interface EventDetail extends Omit<EventListItem, 'show_count' | 'next_show_date' | 'from_price'> {
  shows: EventShow[];
}

export interface EventFilters {
  type?: EventType;
  date_from?: ApiDate;
  date_to?: ApiDate;
  venue_id?: number;
  organiser_id?: number;
  q?: string;
  upcoming?: boolean;
}

export interface CreateEventPayload {
  title: string;
  type: EventType;
  venue_id: number;
  description?: string;
}

/** Category name -> price. Must cover exactly the venue's categories. */
export type PricingMap = Record<string, number>;

export interface CreateShowPayload {
  date: ApiDate;
  /** `HH:MM` or `HH:MM:SS`; the server normalises. */
  time: string;
  pricing: PricingMap;
}

export interface CreatedShow {
  id: number;
  event_id: number;
  date: ApiDate;
  time: ApiTime;
  created_at: ApiTimestamp;
  seats_created: number;
  pricing: PricingMap;
}

/** GET /shows/:id */
export interface ShowDetail {
  id: number;
  event_id: number;
  date: ApiDate;
  time: ApiTime;
  created_at: ApiTimestamp;
  event_title: string;
  event_type: EventType;
  organiser_id: number;
  venue_id: number;
  venue_name: string;
  venue_address: string;
}

/* ---------------------------------------------------------------------------
 * Seat map
 * ------------------------------------------------------------------------- */

export interface SeatMapSeat {
  id: number;
  row_label: string;
  seat_number: number;
  category: string;
  /**
   * The *effective* status: the server collapses an expired held/offered seat to
   * `available` at read time, so this is correct even if the cron has not swept.
   */
  status: SeatStatus;
  price: Money | null;
  /** True only for the caller's own live hold. Requires an authenticated request. */
  held_by_me: boolean;
  /** Only populated for the caller's own holds. */
  my_hold_expires_at: ApiTimestamp | null;
}

export interface SeatMapRow {
  row_label: string;
  seats: SeatMapSeat[];
}

export interface SeatMapSummary {
  total: number;
  available: number;
  held: number;
  booked: number;
  offered: number;
}

export interface SeatMap {
  show: {
    id: number;
    date: ApiDate;
    time: ApiTime;
    event: { id: number; title: string; type: EventType };
    venue: { id: number; name: string; address: string };
  };
  pricing: ShowPricing[];
  rows: SeatMapRow[];
  summary: SeatMapSummary;
  /** Server clock at response time — used to correct countdowns for clock skew. */
  server_time: ApiTimestamp;
}

export interface CategoryAvailability {
  category: string;
  price: Money | null;
  total: number;
  available: number;
  booked: number;
  sold_out: boolean;
}

export interface AvailabilityResponse {
  categories: CategoryAvailability[];
}

/* ---------------------------------------------------------------------------
 * Holds
 * ------------------------------------------------------------------------- */

/** Seat shape returned by hold/booking/cancel mutations and socket events. */
export interface SeatDetail {
  id: number;
  show_id: number;
  status: SeatStatus;
  category: string;
  row_label: string;
  seat_number: number;
  price: Money | null;
}

export interface HoldResponse {
  show_id: number;
  seat_ids: number[];
  hold_expires_at: ApiTimestamp;
  hold_ttl_minutes: number;
  seats: SeatDetail[];
}

export interface ReleaseHoldResponse {
  released: number;
  seat_ids: number[];
}

export interface MyHoldSeat {
  id: number;
  category: string;
  status: SeatStatus;
  hold_expires_at: ApiTimestamp;
  row_label: string;
  seat_number: number;
  price: Money | null;
}

export interface MyHoldsResponse {
  seats: MyHoldSeat[];
  /** Null when the caller holds nothing. */
  hold_expires_at: ApiTimestamp | null;
  server_time: ApiTimestamp;
}

/* ---------------------------------------------------------------------------
 * Bookings
 * ------------------------------------------------------------------------- */

/** Seat inside a booking. NOTE: `price` is a string here but a number in history. */
export interface BookingSeat {
  id: number;
  row_label: string;
  seat_number: number;
  category: string;
  price: Money;
}

/** POST /bookings — booking.show is a flattened summary, no event_id. */
export interface CreatedBooking {
  id: number;
  booking_ref: string;
  customer_id: number;
  show_id: number;
  total_amount: Money;
  status: BookingStatus;
  cancelled_at: ApiTimestamp | null;
  created_at: ApiTimestamp;
  seats: BookingSeat[];
  show: {
    id: number;
    date: ApiDate;
    time: ApiTime;
    event_title: string;
    venue_name: string;
  };
}

export interface CreateBookingResponse {
  booking: CreatedBooking;
  /** PNG data URL encoding only the booking_ref. Null if generation failed. */
  qr_data_url: string | null;
}

/**
 * GET /bookings and GET /bookings/:id — a flatter shape than CreatedBooking, with
 * event/venue fields hoisted to the top level and `event_id` present.
 */
export interface BookingHistoryItem {
  id: number;
  booking_ref: string;
  customer_id: number;
  show_id: number;
  total_amount: Money;
  status: BookingStatus;
  created_at: ApiTimestamp;
  cancelled_at: ApiTimestamp | null;
  date: ApiDate;
  time: ApiTime;
  event_id: number;
  event_title: string;
  event_type: EventType;
  venue_name: string;
  venue_address: string;
  seats: BookingSeat[];
}

export interface CreateBookingPayload {
  show_id: number;
  seat_ids: number[];
}

export interface CancelBookingResponse {
  booking_ref: string;
  status: 'cancelled';
  /** Seats returned to general sale because no one was waiting. */
  seats_released: number;
  /** Seats handed straight to a waitlisted customer instead. */
  seats_offered_to_waitlist: number;
  seats: Array<{
    id: number;
    row_label: string;
    seat_number: number;
    category: string;
    status: SeatStatus;
  }>;
}

export interface BookingQrResponse {
  booking_ref: string;
  qr_data_url: string | null;
}

/* ---------------------------------------------------------------------------
 * Waitlist
 * ------------------------------------------------------------------------- */

export interface WaitlistEntry {
  id: number;
  show_id: number;
  category: string;
  status: WaitlistStatus;
  joined_at: ApiTimestamp;
  /** 1-based queue position. Null unless status is `waiting`. */
  position: number | null;
}

export interface WaitlistMineItem {
  id: number;
  show_id: number;
  category: string;
  status: WaitlistStatus;
  joined_at: ApiTimestamp;
  offer_expires_at: ApiTimestamp | null;
  /** Present only while an offer is live; this is the single-use claim token. */
  offer_token: string | null;
  date: ApiDate;
  time: ApiTime;
  event_id: number;
  event_title: string;
  event_type: EventType;
  venue_name: string;
  position: number | null;
  offered_row_label: string | null;
  offered_seat_number: number | null;
  offered_show_seat_id: number | null;
}

export interface JoinWaitlistPayload {
  show_id: number;
  category: string;
}

/** GET /waitlist/offers/:token — public; carries no customer identity. */
export interface WaitlistOffer {
  category: string;
  offer_expires_at: ApiTimestamp;
  still_valid: boolean;
  show: {
    id: number;
    date: ApiDate;
    time: ApiTime;
    event_title: string;
    venue_name: string;
  };
  seat: {
    id: number;
    row_label: string;
    seat_number: number;
    price: Money | null;
  };
}

/** Accepting converts the offer into an ordinary hold. */
export interface AcceptOfferResponse {
  show_id: number;
  seat_ids: number[];
  category: string;
  hold_expires_at: ApiTimestamp;
  hold_ttl_minutes: number;
  seats: SeatDetail[];
}

export interface LeaveWaitlistResponse {
  removed: boolean;
}

/* ---------------------------------------------------------------------------
 * Organiser dashboard
 * ------------------------------------------------------------------------- */

export interface DashboardEventRow {
  id: number;
  title: string;
  type: EventType;
  created_at: ApiTimestamp;
  venue_id: number;
  venue_name: string;
  show_count: number;
  total_seats: number;
  booked_seats: number;
  available_seats: number;
  /** Live holds and offers — not yet sold, not currently sellable. */
  pending_seats: number;
  bookings_confirmed: number;
  bookings_cancelled: number;
  /** Confirmed bookings only. */
  revenue: Money;
  cancelled_value: Money;
  waitlist_waiting: number;
  waitlist_offered: number;
}

export interface DashboardTotals {
  events: number;
  shows: number;
  seats_sold: number;
  bookings: number;
  revenue: Money;
}

export interface DashboardSummary {
  events: DashboardEventRow[];
  totals: DashboardTotals;
}

export interface EventReportShow {
  id: number;
  date: ApiDate;
  time: ApiTime;
  total_seats: number;
  booked_seats: number;
  available_seats: number;
  held_seats: number;
  offered_seats: number;
  bookings_confirmed: number;
  bookings_cancelled: number;
  revenue: Money;
  /** NUMERIC string, e.g. "33.3". */
  occupancy_pct: Money;
}

/** Aggregated across every show of the event, not per show. */
export interface EventReportCategory {
  category: string;
  total_seats: number;
  booked_seats: number;
  revenue: Money;
}

export interface EventReportWaitlist {
  category: string;
  waiting: number;
  offered: number;
  fulfilled: number;
  expired: number;
}

export interface EventReport {
  event: {
    id: number;
    title: string;
    type: EventType;
    organiser_id: number;
    venue_id: number;
  };
  shows: EventReportShow[];
  categories: EventReportCategory[];
  waitlist: EventReportWaitlist[];
  totals: Omit<DashboardTotals, 'events'>;
}

export interface EventAttendee {
  id: number;
  booking_ref: string;
  status: BookingStatus;
  total_amount: Money;
  created_at: ApiTimestamp;
  cancelled_at: ApiTimestamp | null;
  customer_name: string;
  customer_email: string;
  date: ApiDate;
  time: ApiTime;
  seat_count: number;
  /** Pre-joined seat labels, e.g. "A1, A2". Null when a booking has no seats. */
  seats: string | null;
}

/* ---------------------------------------------------------------------------
 * Health
 * ------------------------------------------------------------------------- */

export interface HealthResponse {
  status: 'ok' | 'degraded';
  database: 'connected' | 'unreachable';
  holdTtlMinutes: number;
  offerTtlMinutes: number;
}

/* ---------------------------------------------------------------------------
 * Socket.io
 * ------------------------------------------------------------------------- */

/** Why a seat changed. Enumerated from every emit call site in the backend. */
export type SeatUpdateReason =
  | 'hold'
  | 'release'
  | 'booked'
  | 'cancelled'
  | 'hold-expired'
  | 'offer-expired'
  | 'offer-accepted'
  | 'change';

/**
 * `seats:updated` payload.
 *
 * PRIVACY BY DESIGN: this payload intentionally omits `held_by`. Every viewer of a
 * show receives the same broadcast, so including the holder's user id would leak
 * one customer's identity to everyone else watching. This is a deliberate design
 * decision in the backend, not an oversight — see the note in useSeatSocket.ts for
 * how the client compensates.
 */
export interface SeatsUpdatedPayload {
  showId: number;
  reason: SeatUpdateReason;
  seats: Array<{
    id: number;
    status: SeatStatus;
    row_label: string;
    seat_number: number;
    category: string;
    price: Money | null;
  }>;
  /** The user who caused the change. Null for cron-driven expiry sweeps. */
  actorId: number | null;
  at: ApiTimestamp;
}

export interface AvailabilityChangedPayload {
  showId: number;
  reason: SeatUpdateReason;
}

export interface ShowJoinedPayload {
  showId: number;
}
