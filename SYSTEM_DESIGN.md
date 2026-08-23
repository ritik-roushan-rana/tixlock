# TixLock — System Design

Express + PostgreSQL API on Railway; React 18 + Vite + TypeScript SPA on Vercel, over
HTTP and Socket.io.

## Seat hold and TTL

`show_seats` is the sellable inventory, stamped from the venue's `venue_seats` template at
show creation. Each row carries `status` (`available | held | booked | offered`),
`held_by`, `hold_expires_at`.

`POST /shows/:id/hold` sets seats to `held` with
`hold_expires_at = now() + HOLD_TTL_MINUTES` (default 10), computed by PostgreSQL, not by
Node — the app clock is irrelevant.

Expiry is enforced at read and write time, not by the scheduler: every read treats a
lapsed `held`/`offered` seat as available, and every write re-checks
`hold_expires_at > now()` in its own transaction. If the cron stopped, no seat would be
wrongly withheld and no double-booking would become possible. The sweep is a tidier, not
the source of truth.

## Concurrency prevention

The failure mode designed against is the app-level read-then-write: two requests read
`available`, both pass a JavaScript check, both write. Every mutation is instead one
atomic check-then-set in the database:

```sql
BEGIN;                                  -- READ COMMITTED (Postgres default)
SELECT ss.id FROM show_seats ss
 WHERE ss.id = ANY($1::int[]) AND ss.show_id = $2
   AND ( ss.status = 'available'
      OR (ss.status IN ('held','offered') AND ss.hold_expires_at < now()) )
 FOR UPDATE;                            -- rows short -> ROLLBACK, 409 + lost ids
UPDATE show_seats
   SET status = 'held', held_by = $3,
       hold_expires_at = now() + ($4 || ' minutes')::interval
 WHERE id = ANY($1::int[]);
COMMIT;
```

**Correct at READ COMMITTED.** `FOR UPDATE` locks the returned rows, so a second
transaction on the same row blocks instead of reading stale data. When the first commits,
PostgreSQL re-evaluates the second's `WHERE` against the newly committed row version: the
seat is no longer available, drops out, the count comes up short, and it rolls back with a
409. No window exists where both callers see `available`.

SERIALIZABLE is unnecessary since the contended rows are locked explicitly, avoiding
serialization retries. An optimistic `UPDATE … WHERE status='available'` plus rowcount is
equally safe; `FOR UPDATE` wins because the 409 must name the lost seats and already
holds them.

Seat ids are sorted before locking, so overlapping requests acquire locks in the same
order and cannot deadlock. Booking reuses the shape with a stricter predicate
(`held_by = $caller AND hold_expires_at > now()`). Totals are summed from
`show_pricing` in SQL; no client-supplied amount is trusted.

"At most one *confirmed* booking per seat" is deliberately not a `UNIQUE` constraint: a
seat may be booked, cancelled, then re-booked, so `show_seat_id` cannot be globally
unique, and `UNIQUE` cannot say "only while the parent booking is confirmed". The booking
transaction upholds it instead, with an index on `booking_seats` to audit it by query.

## Waitlist auto-assignment

One function, `placeSeat`, answers "where does this released seat go?" for every release
path — cancellation, explicit release, hold or offer expiry:

```sql
SELECT w.id, w.customer_id FROM waitlist w
 WHERE w.show_id = $1 AND w.category = $2 AND w.status = 'waiting'
 ORDER BY w.joined_at ASC, w.id ASC LIMIT 1
 FOR UPDATE OF w SKIP LOCKED;
```

Queue head found: the seat becomes `offered` to that customer with a longer window
(`OFFER_TTL_MINUTES`, default 30) and a 32-byte `offer_token`, emailed after commit.
Nobody waiting: it returns to general sale. A released seat is never made `available`
first and then offered, so a queued category has no instant where a passer-by jumps in.

`SKIP LOCKED` matters because cancelling a three-seat booking releases three seats in one
transaction, each asking for the queue head; skipping lets them take the first three
entries in order instead of serialising behind one lock. The `id` tiebreaker is
load-bearing: `now()` is fixed per transaction, so entries can share `joined_at`.

## Time-limited offers

The 15-second sweep expires overdue `offered` seats, marks the entry `expired` and calls
`placeSeat` again — cascading to the next person, reaching general sale only when the
queue empties. This is the one part genuinely needing a scheduler: an expired hold
self-corrects because the next reader sees the seat free, but a seat earmarked for an
unresponsive customer must be moved along.

Accepting converts the offer into an ordinary hold, so normal checkout completes it.
Single use is structural: the token is cleared in the transaction that validates it, so a
replay matches nothing.

## Trade-offs

**Single-instance cron.** Expiry is a `node-cron` job inside the API process, so two
instances would double-sweep; `SKIP LOCKED` prevents corruption but not duplicate offer
emails. At scale this needs a distributed scheduler. Tolerable only because correctness
never depends on it.

**No payment gateway** — bookings are treated as paid on confirmation.

**Waitlists are per category**, so nobody can wait for a specific seat.

**Post-commit side effects are fire-and-forget.** QR and email failures are logged, not
retried; a booking is never rolled back by a mail problem. Production wants an outbox
table.
