/**
 * Date and time helpers.
 *
 * ============================================================================
 * WHY THESE DO NOT USE `new Date(apiValue)` DIRECTLY
 * ============================================================================
 *
 * The backend returns `date` as a bare `YYYY-MM-DD` string and `time` as
 * `HH:MM:SS`, with no timezone. That is deliberate: it overrides node-postgres'
 * DATE parser precisely because the default turned a DATE into a local-midnight
 * `Date`, which then serialised to UTC and shifted the calendar day backwards for
 * any timezone east of UTC — a show on the 15th was served as the 14th.
 *
 * `new Date('2026-09-18')` re-introduces exactly that bug on the client: the ES
 * spec parses a bare date-only string as **UTC** midnight, so in a UTC-negative
 * timezone `toLocaleDateString()` renders the previous day.
 *
 * Every helper here therefore builds a Date from explicit local components, so a
 * show date renders as the date the organiser typed, in every timezone.
 *
 * Timestamps (`created_at`, `hold_expires_at`, `server_time`) are different: they
 * are genuine ISO-8601 instants with a `Z`, so `new Date()` is correct for those.
 */

/** Parse a `YYYY-MM-DD` API date into a Date at local midnight. */
export function parseApiDate(dateStr: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr ?? '');
  if (!match) return null;
  const [, y, m, d] = match;
  // Month is 0-indexed. Constructing from components keeps it local, not UTC.
  return new Date(Number(y), Number(m) - 1, Number(d));
}

/** Parse `YYYY-MM-DD` + `HH:MM:SS` into a single local Date. */
export function parseApiDateTime(dateStr: string, timeStr?: string): Date | null {
  const base = parseApiDate(dateStr);
  if (!base) return null;
  if (!timeStr) return base;

  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(timeStr);
  if (!match) return base;
  base.setHours(Number(match[1]), Number(match[2]), Number(match[3] ?? 0), 0);
  return base;
}

/** "Fri, 18 Sep 2026" */
export function formatDate(dateStr: string): string {
  const d = parseApiDate(dateStr);
  if (!d) return dateStr ?? '';
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** "18 Sep" — for dense lists. */
export function formatDateShort(dateStr: string): string {
  const d = parseApiDate(dateStr);
  if (!d) return dateStr ?? '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** `HH:MM:SS` -> "8:30 pm" */
export function formatTime(timeStr: string): string {
  const match = /^(\d{2}):(\d{2})/.exec(timeStr ?? '');
  if (!match) return timeStr ?? '';
  const d = new Date();
  d.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function formatDateTime(dateStr: string, timeStr: string): string {
  return `${formatDate(dateStr)} · ${formatTime(timeStr)}`;
}

/** ISO instant -> "18 Sep 2026, 8:30 pm". Safe to use new Date() here. */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Is this show date/time in the past? */
export function isPast(dateStr: string, timeStr?: string): boolean {
  const d = parseApiDateTime(dateStr, timeStr);
  return d ? d.getTime() < Date.now() : false;
}

/** Milliseconds -> "9:58", clamped at zero. Used by the hold countdown. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Today as `YYYY-MM-DD` in local time, for date-input defaults and min values. */
export function todayIsoDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
