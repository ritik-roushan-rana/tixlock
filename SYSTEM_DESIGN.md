# TixLock — System Design

Node/Express + PostgreSQL (`pg`, pooled) + vanilla JS + Socket.io, one process
serving API, frontend and websocket.

## Seat hold and TTL

`show_seats` is the sellable inventory, stamped out from a venue's `venue_seats`
template at show creation. Each row carries `status`
(`available|held|booked|offered`), `held_by`, `hold_expires_at`.

`POST /shows/:id/hold` sets seats to `held` with
`hold_expires_at = now() + HOLD_TTL_MINUTES` (default 10), computed by PostgreSQL,
never by Node — the app clock is irrelevant.

Expiry is enforced at read and write time, not by the scheduler: every read treats a
lapsed `held`/`offered` as `available`, and every write re-checks
`hold_expires_at > now()` in its own transaction. So if the cron stopped, no seat
would be wrongly withheld and no double-booking would become possible. The sweep is
a tidier, not the source of truth.

## Concurrency prevention

The failure mode designed against is the app-level read-then-write: two requests both
read `available`, both pass the check in JavaScript, both write. Every mutation is
therefore one atomic database check-then-set:

```sql
BEGIN;                                  -- READ COMMITTED (Postgres default)

SELECT ss.id
  FROM show_seats ss
 WHERE ss.id = ANY($1::int[])
   AND ss.show_id = $2
   AND ( ss.status = 'available'
      OR (ss.status IN ('held','offered') AND ss.hold_expires_at < now()) )
 FOR UPDATE;                            -- row locks

-- rows returned <> seats requested  ->  ROLLBACK, 409 + conflicting ids

UPDATE show_seats
   SET status = 'held', held_by = $3,
       hold_expires_at = now() + ($4 || ' minutes')::interval
 WHERE id = ANY($1::int[]);

COMMIT;
```

**Correct at READ COMMITTED.** `FOR UPDATE` locks the returned rows, so a second
transaction targeting the same row blocks instead of reading stale data. When the
first commits, PostgreSQL re-evaluates the second's `WHERE` against the newly
committed row version: the seat is no longer `available`, it drops out, the count
comes up short, and that transaction rolls back with 409. No window exists where both
see `available`.

**Not SERIALIZABLE**, because the exact contended rows are locked explicitly — the
narrower guarantee suffices, with no serialization retries to handle.

**vs optimistic `UPDATE ... WHERE status='available'` + rowcount.** Equally safe: the
database evaluates the predicate as part of the write either way. They differ only
under contention — `FOR UPDATE` blocks then re-checks, the optimistic form fails fast
with 0 rows affected. `FOR UPDATE` wins because the 409 must name the lost seats and
it already has them. Either beats an app-level read-then-write, which has a real
TOCTOU gap between the two round trips.

Seat ids are sorted before locking, so overlapping requests lock in the same order
and cannot deadlock. Booking reuses the shape with a stricter predicate
(`held_by = $caller AND hold_expires_at > now()`); totals are summed from
`show_pricing` in SQL, and no client amount is trusted.

## Waitlist auto-assignment

One function, `placeSeat`, answers "where does this released seat go?" for all three
release paths (cancellation, hold expiry, offer expiry):

```sql
SELECT w.id, w.customer_id FROM waitlist w
 WHERE w.show_id = $1 AND w.category = $2 AND w.status = 'waiting'
 ORDER BY w.joined_at ASC, w.id ASC
 LIMIT 1
 FOR UPDATE OF w SKIP LOCKED;
```

Found → seat becomes `offered` to that customer with a longer window
(`OFFER_TTL_MINUTES`, default 30) and a 32-byte random `offer_token`; email sent after
commit. Not found → `available`. A seat is never set `available` first and then
offered, so a queued category has no instant where a passer-by jumps the queue.

`SKIP LOCKED` matters because cancelling a 3-seat booking releases three seats in one
transaction, each asking for the queue head; skipping means they take the first three
entries in order instead of serialising behind one lock. The `id` tiebreaker is
load-bearing — `now()` is fixed per transaction, so entries can share `joined_at`.

## Time-limited offers

The 15-second sweep expires overdue `offered` seats, marks that entry `expired`, and
calls `placeSeat` again — cascading to the next person, releasing to general sale only
when the queue empties. This is the one part genuinely needing a scheduler: an expired
hold self-corrects because the next reader sees the seat free, but a seat earmarked
for an unresponsive customer needs moving along.

Accepting converts the offer into a normal hold, so standard checkout completes it.
Single use is structural — the token is cleared in the transaction that validates it,
so a replay matches nothing.

## Trade-offs

**Single-instance cron.** Expiry is a `node-cron` job inside the API process, so it
does not scale past one backend process: two instances would double-sweep, and
`SKIP LOCKED` prevents corruption but not duplicate offer emails. At scale this moves
to a distributed scheduler or Redis TTL + pub/sub so instances neither double-sweep
nor miss expiries. Tolerable here only because correctness never depends on the sweep.

**No payment gateway** — bookings are treated as paid on confirmation.

**Waitlists are per-category**, so nobody can wait for one specific seat.

**Post-commit side effects are fire-and-forget.** QR and email failures are logged,
not retried; a booking is never rolled back by a mail problem. Production would use an
outbox table.
