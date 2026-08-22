/**
 * Money normalisation — the single boundary where the API's inconsistent numeric
 * types are made uniform.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 *
 * The backend stores money as PostgreSQL `NUMERIC(10,2)` and deliberately
 * overrides node-postgres' NUMERIC parser so values arrive as exact decimal
 * *strings* rather than being routed through a JavaScript float. That is the
 * right call — but it only applies to top-level columns.
 *
 * Prices nested inside a `json_agg` / `json_build_object` are serialised by
 * PostgreSQL into a `json` column, which the driver parses with `JSON.parse`.
 * That bypasses the custom NUMERIC parser entirely, so those same values arrive
 * as JavaScript *numbers*.
 *
 * Verified against the live API:
 *
 *   GET  /api/shows/:id/seats   rows[].seats[].price   "650.00"   string
 *   POST /api/bookings          booking.seats[].price  "650.00"   string
 *   POST /api/bookings          booking.total_amount   "1300.00"  string
 *   GET  /api/bookings          bookings[].total_amount "1300.00" string
 *   GET  /api/bookings          bookings[].seats[].price   650    number   <--
 *   GET  /api/dashboard/...     shows[].occupancy_pct   "0.0"     string
 *
 * So the same conceptual field has two runtime types depending on which endpoint
 * produced it. Rather than scatter `typeof x === 'string' ? … : …` through the
 * UI, every monetary value is funnelled through `toMoney()` at the API-client
 * boundary and every component consumes a plain `number`.
 *
 * Formatting for display is a separate step (`formatMoney`), so nothing in the
 * app ever does arithmetic on a formatted string.
 */

/** Anything the API might hand us for a money field. */
export type MoneyLike = string | number | null | undefined;

/**
 * Coerce an API money value to a number.
 *
 * Returns 0 for null/undefined/unparseable rather than NaN: a NaN leaking into a
 * total renders as "₹NaN" across the UI, which is far harder to trace back than a
 * zero. Genuinely absent prices are represented by `null` in the API and handled
 * explicitly at the call site where that distinction matters.
 */
export function toMoney(value: MoneyLike): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Same coercion, but preserves "no value" as null so callers can render a dash
 * instead of a misleading ₹0.00. Used for seat prices, which are null when an
 * organiser has not priced a category.
 */
export function toMoneyOrNull(value: MoneyLike): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Display a money value. Accepts raw API values so callers cannot forget toMoney. */
export function formatMoney(value: MoneyLike): string {
  return INR.format(toMoney(value));
}

/** Compact form for chart axes and dense tables: ₹1.2K, ₹3.4L. */
export function formatMoneyCompact(value: MoneyLike): string {
  const n = toMoney(value);
  if (n >= 10_000_000) return `₹${(n / 10_000_000).toFixed(1)}Cr`;
  if (n >= 100_000) return `₹${(n / 100_000).toFixed(1)}L`;
  if (n >= 1_000) return `₹${(n / 1_000).toFixed(1)}K`;
  return `₹${n.toFixed(0)}`;
}

/**
 * Sum money values exactly.
 *
 * Works in integer paise and divides at the end, so adding 0.1 + 0.2 yields 0.30
 * rather than 0.30000000000000004. The server is authoritative for the total that
 * gets charged; this is only for optimistic subtotals in the checkout panel, but
 * a subtotal that disagrees with the server by a rounding error looks like a bug.
 */
export function sumMoney(values: MoneyLike[]): number {
  // Explicit generic: without it TypeScript infers the accumulator as MoneyLike
  // from the array element type rather than from the seed value.
  const paise = values.reduce<number>((acc, v) => acc + Math.round(toMoney(v) * 100), 0);
  return paise / 100;
}

/** Percentages come back as NUMERIC strings too ("0.0", "33.3"). */
export function toPercent(value: MoneyLike): number {
  return toMoney(value);
}
