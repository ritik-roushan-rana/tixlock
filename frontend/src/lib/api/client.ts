import axios, { AxiosError, type AxiosInstance } from 'axios';

import type { ApiErrorBody, ApiErrorCode } from './types';

/**
 * Axios instance plus the app's error model.
 *
 * Two responsibilities:
 *  1. Attach the JWT to every request from a single place.
 *  2. Normalise every failure into an ApiError, so callers never have to reason
 *     about Axios' error shape or guess whether `err.response` exists.
 */

/**
 * Base URL.
 *
 * VITE_API_URL points at the backend origin (e.g. https://api.example.com). When
 * unset we fall back to a relative '' so requests go to the current origin — which
 * works both behind the Vite dev proxy and in a same-origin deployment.
 */
const RAW_BASE = import.meta.env.VITE_API_URL ?? '';
export const API_BASE_URL = RAW_BASE.replace(/\/$/, '');

/** Socket URL defaults to the API origin, since the backend serves both. */
export const SOCKET_URL = (import.meta.env.VITE_SOCKET_URL ?? API_BASE_URL).replace(/\/$/, '');

export const TOKEN_STORAGE_KEY = 'tb-token';

/* ---------------------------------------------------------------------------
 * Error model
 * ------------------------------------------------------------------------- */

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | string;
  readonly details?: ApiErrorBody['error']['details'];

  constructor(
    status: number,
    code: ApiErrorCode | string,
    message: string,
    details?: ApiErrorBody['error']['details']
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Seat contention — the one error the seat map handles programmatically. */
  get isSeatConflict(): boolean {
    return this.code === 'SEATS_UNAVAILABLE';
  }

  /** Seat ids the caller lost, when this is a seat conflict. */
  get unavailableSeatIds(): number[] {
    return this.details?.unavailableSeatIds ?? [];
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/* ---------------------------------------------------------------------------
 * Session hooks
 *
 * The client must read the token and react to a 401 without importing the auth
 * store — that would create a cycle (store -> api -> store). Instead the store
 * registers callbacks here at startup.
 * ------------------------------------------------------------------------- */

let getToken: () => string | null = () => {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
};

let onUnauthorized: () => void = () => {};

export function configureApiSession(handlers: {
  getToken?: () => string | null;
  onUnauthorized?: () => void;
}) {
  if (handlers.getToken) getToken = handlers.getToken;
  if (handlers.onUnauthorized) onUnauthorized = handlers.onUnauthorized;
}

/* ---------------------------------------------------------------------------
 * Instance
 * ------------------------------------------------------------------------- */

export const http: AxiosInstance = axios.create({
  baseURL: `${API_BASE_URL}/api`,
  timeout: 20_000,
  headers: { 'Content-Type': 'application/json' },
});

http.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

http.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiErrorBody>) => {
    // No response at all: DNS failure, connection refused, CORS block, timeout.
    if (!error.response) {
      const isTimeout = error.code === 'ECONNABORTED';
      return Promise.reject(
        new ApiError(
          0,
          isTimeout ? 'TIMEOUT' : 'NETWORK',
          isTimeout
            ? 'The server took too long to respond. Please try again.'
            : 'Could not reach the server. Check your connection and that the API is running.'
        )
      );
    }

    const { status, data } = error.response;
    const body = data?.error;

    /**
     * A 401 means the token is missing, expired or belongs to a deleted user — the
     * backend re-reads the user row on every request, so this is authoritative.
     * Clearing the session here (rather than in each caller) is what guarantees the
     * app can never sit in a half-authenticated state.
     *
     * Login and register are excluded: a 401 there means "wrong password", which is
     * a form error to display, not a session to tear down.
     */
    const url = error.config?.url ?? '';
    const isAuthAttempt = url.includes('/auth/login') || url.includes('/auth/register');
    if (status === 401 && !isAuthAttempt) {
      onUnauthorized();
    }

    return Promise.reject(
      new ApiError(
        status,
        body?.code ?? 'INTERNAL_ERROR',
        body?.message ?? `Request failed with status ${status}`,
        body?.details
      )
    );
  }
);

/** Narrow an unknown caught value to ApiError. */
export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** Best-effort human-readable message from any thrown value. */
export function errorMessage(err: unknown): string {
  if (isApiError(err)) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
