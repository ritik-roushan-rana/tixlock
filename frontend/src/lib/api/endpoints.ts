import { http } from './client';
import type {
  AcceptOfferResponse,
  AuthResponse,
  AvailabilityResponse,
  BookingHistoryItem,
  BookingQrResponse,
  CancelBookingResponse,
  CreateBookingPayload,
  CreateBookingResponse,
  CreateEventPayload,
  CreateShowPayload,
  CreateVenuePayload,
  CreatedShow,
  DashboardSummary,
  DefineLayoutResponse,
  EventAttendee,
  EventDetail,
  EventFilters,
  EventListItem,
  EventReport,
  HealthResponse,
  HoldResponse,
  JoinWaitlistPayload,
  LayoutRowSpec,
  LeaveWaitlistResponse,
  LoginPayload,
  MeResponse,
  MyHoldsResponse,
  RegisterPayload,
  ReleaseHoldResponse,
  SeatMap,
  ShowDetail,
  ShowPricing,
  VenueDetail,
  VenueListItem,
  WaitlistEntry,
  WaitlistMineItem,
  WaitlistOffer,
} from './types';

/**
 * One function per backend endpoint.
 *
 * Every path here was verified against the running API. Responses are unwrapped
 * from their envelope (`{ events: [...] }` -> `EventListItem[]`) so callers work
 * with data rather than transport shapes — except where the envelope carries extra
 * information worth keeping, such as the QR alongside a created booking.
 */

/* --- Auth ---------------------------------------------------------------- */

export const authApi = {
  login: async (payload: LoginPayload): Promise<AuthResponse> => {
    const { data } = await http.post<AuthResponse>('/auth/login', payload);
    return data;
  },

  register: async (payload: RegisterPayload): Promise<AuthResponse> => {
    const { data } = await http.post<AuthResponse>('/auth/register', payload);
    return data;
  },

  me: async (): Promise<MeResponse['user']> => {
    const { data } = await http.get<MeResponse>('/auth/me');
    return data.user;
  },
};

/* --- Venues -------------------------------------------------------------- */

export const venuesApi = {
  /** Readable by any signed-in user, not just admins — organisers need it too. */
  list: async (): Promise<VenueListItem[]> => {
    const { data } = await http.get<{ venues: VenueListItem[] }>('/venues');
    return data.venues;
  },

  get: async (venueId: number): Promise<VenueDetail> => {
    const { data } = await http.get<{ venue: VenueDetail }>(`/venues/${venueId}`);
    return data.venue;
  },

  create: async (payload: CreateVenuePayload): Promise<VenueDetail> => {
    const { data } = await http.post<{ venue: VenueDetail }>('/venues', payload);
    return data.venue;
  },

  update: async (
    venueId: number,
    payload: { name?: string; address?: string }
  ): Promise<VenueDetail> => {
    const { data } = await http.patch<{ venue: VenueDetail }>(`/venues/${venueId}`, payload);
    return data.venue;
  },

  /** PUT — replaces the whole layout, so it is safe to repeat. */
  defineLayout: async (venueId: number, layout: LayoutRowSpec[]): Promise<DefineLayoutResponse> => {
    const { data } = await http.put<DefineLayoutResponse>(`/venues/${venueId}/layout`, { layout });
    return data;
  },
};

/* --- Events and shows ---------------------------------------------------- */

export const eventsApi = {
  list: async (filters: EventFilters = {}): Promise<EventListItem[]> => {
    const params: Record<string, string> = {};
    if (filters.type) params.type = filters.type;
    if (filters.date_from) params.date_from = filters.date_from;
    if (filters.date_to) params.date_to = filters.date_to;
    if (filters.venue_id) params.venue_id = String(filters.venue_id);
    if (filters.organiser_id) params.organiser_id = String(filters.organiser_id);
    if (filters.q) params.q = filters.q;
    if (filters.upcoming) params.upcoming = 'true';

    const { data } = await http.get<{ events: EventListItem[] }>('/events', { params });
    return data.events;
  },

  mine: async (): Promise<EventListItem[]> => {
    const { data } = await http.get<{ events: EventListItem[] }>('/events/mine');
    return data.events;
  },

  get: async (eventId: number): Promise<EventDetail> => {
    const { data } = await http.get<{ event: EventDetail }>(`/events/${eventId}`);
    return data.event;
  },

  create: async (payload: CreateEventPayload): Promise<EventListItem> => {
    const { data } = await http.post<{ event: EventListItem }>('/events', payload);
    return data.event;
  },

  createShow: async (eventId: number, payload: CreateShowPayload): Promise<CreatedShow> => {
    const { data } = await http.post<{ show: CreatedShow }>(`/events/${eventId}/shows`, payload);
    return data.show;
  },

  deleteShow: async (eventId: number, showId: number): Promise<void> => {
    await http.delete(`/events/${eventId}/shows/${showId}`);
  },
};

/* --- Shows, seat maps and holds ------------------------------------------ */

export const showsApi = {
  get: async (showId: number): Promise<{ show: ShowDetail; pricing: ShowPricing[] }> => {
    const { data } = await http.get<{ show: ShowDetail; pricing: ShowPricing[] }>(
      `/shows/${showId}`
    );
    return data;
  },

  /**
   * Seat map. Auth is optional: anonymous callers get the map without the
   * `held_by_me` flags, which is what lets a visitor browse before signing up.
   */
  seatMap: async (showId: number): Promise<SeatMap> => {
    const { data } = await http.get<SeatMap>(`/shows/${showId}/seats`);
    return data;
  },

  availability: async (showId: number): Promise<AvailabilityResponse['categories']> => {
    const { data } = await http.get<AvailabilityResponse>(`/shows/${showId}/availability`);
    return data.categories;
  },

  /** Customer role only. All-or-nothing: 409 SEATS_UNAVAILABLE names lost seats. */
  hold: async (showId: number, seatIds: number[]): Promise<HoldResponse> => {
    const { data } = await http.post<HoldResponse>(`/shows/${showId}/hold`, { seat_ids: seatIds });
    return data;
  },

  /** Omit seatIds to release every hold the caller has on this show. */
  releaseHold: async (showId: number, seatIds?: number[]): Promise<ReleaseHoldResponse> => {
    const { data } = await http.delete<ReleaseHoldResponse>(`/shows/${showId}/hold`, {
      data: seatIds ? { seat_ids: seatIds } : {},
    });
    return data;
  },

  /** Restores an in-progress hold (and its true deadline) after a page reload. */
  myHolds: async (showId: number): Promise<MyHoldsResponse> => {
    const { data } = await http.get<MyHoldsResponse>(`/shows/${showId}/my-holds`);
    return data;
  },
};

/* --- Bookings ------------------------------------------------------------ */

export const bookingsApi = {
  /** No amount is sent: the server prices the booking from show_pricing. */
  create: async (payload: CreateBookingPayload): Promise<CreateBookingResponse> => {
    const { data } = await http.post<CreateBookingResponse>('/bookings', payload);
    return data;
  },

  list: async (): Promise<BookingHistoryItem[]> => {
    const { data } = await http.get<{ bookings: BookingHistoryItem[] }>('/bookings');
    return data.bookings;
  },

  get: async (bookingId: number): Promise<BookingHistoryItem> => {
    const { data } = await http.get<{ booking: BookingHistoryItem }>(`/bookings/${bookingId}`);
    return data.booking;
  },

  getByRef: async (ref: string): Promise<BookingHistoryItem> => {
    const { data } = await http.get<{ booking: BookingHistoryItem }>(`/bookings/ref/${ref}`);
    return data.booking;
  },

  qr: async (bookingId: number): Promise<BookingQrResponse> => {
    const { data } = await http.get<BookingQrResponse>(`/bookings/${bookingId}/qr`);
    return data;
  },

  cancel: async (bookingId: number): Promise<CancelBookingResponse> => {
    const { data } = await http.post<CancelBookingResponse>(`/bookings/${bookingId}/cancel`);
    return data;
  },
};

/* --- Waitlist ------------------------------------------------------------ */

export const waitlistApi = {
  /** 409 CONFLICT with details.available if the category still has seats. */
  join: async (payload: JoinWaitlistPayload): Promise<WaitlistEntry> => {
    const { data } = await http.post<{ waitlist: WaitlistEntry }>('/waitlist', payload);
    return data.waitlist;
  },

  mine: async (): Promise<WaitlistMineItem[]> => {
    const { data } = await http.get<{ waitlist: WaitlistMineItem[] }>('/waitlist/mine');
    return data.waitlist;
  },

  leave: async (waitlistId: number): Promise<LeaveWaitlistResponse> => {
    const { data } = await http.delete<LeaveWaitlistResponse>(`/waitlist/${waitlistId}`);
    return data;
  },

  /** Public — the token itself is the credential. Does not consume the offer. */
  getOffer: async (token: string): Promise<WaitlistOffer> => {
    const { data } = await http.get<{ offer: WaitlistOffer }>(
      `/waitlist/offers/${encodeURIComponent(token)}`
    );
    return data.offer;
  },

  /** Single use. Requires the signed-in customer to be the offer's recipient. */
  acceptOffer: async (token: string): Promise<AcceptOfferResponse> => {
    const { data } = await http.post<AcceptOfferResponse>(
      `/waitlist/offers/${encodeURIComponent(token)}/accept`
    );
    return data;
  },
};

/* --- Organiser dashboard ------------------------------------------------- */

export const dashboardApi = {
  summary: async (): Promise<DashboardSummary> => {
    const { data } = await http.get<DashboardSummary>('/dashboard/summary');
    return data;
  },

  eventReport: async (eventId: number): Promise<EventReport> => {
    const { data } = await http.get<EventReport>(`/dashboard/events/${eventId}`);
    return data;
  },

  eventBookings: async (eventId: number, limit = 100): Promise<EventAttendee[]> => {
    const { data } = await http.get<{ bookings: EventAttendee[] }>(
      `/dashboard/events/${eventId}/bookings`,
      { params: { limit } }
    );
    return data.bookings;
  },
};

/* --- System -------------------------------------------------------------- */

export const systemApi = {
  health: async (): Promise<HealthResponse> => {
    const { data } = await http.get<HealthResponse>('/health');
    return data;
  },
};
