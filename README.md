# TixLock

Seats, locked. Full-stack seat booking for films and live music, built around one hard
requirement: **two customers must never both get the same seat.** Everything else is in
service of that.

**Backend** — Node.js + Express, PostgreSQL via `pg` with a single connection pool,
Socket.io for live seat maps, JWT + bcrypt auth with three roles
(customer / organiser / admin), a `node-cron` sweeper for hold and offer expiry,
`qrcode` for tickets and `nodemailer` for email.

**Frontend** — React 18 + Vite + TypeScript SPA, Tailwind CSS with shadcn/ui
components, React Router, React Query for server state, Zustand for client state,
socket.io-client for live seat updates, react-hook-form + zod for forms, Recharts for
the organiser dashboard.

The two halves deploy independently: the frontend is a static SPA (Vercel), the
backend is an API-only service (Render / Railway).

See [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) for the concurrency argument in detail.

---

## Contents

1. [Quick start](#quick-start)
2. [Configuration](#configuration)
3. [How seat holds work](#how-seat-holds-work-plain-english)
4. [How the waitlist works](#how-the-waitlist-works-plain-english)
5. [Proof it is race-condition-free](#proof-it-is-race-condition-free)
6. [API reference](#api-reference)
7. [Database schema](#database-schema)
8. [Deployment](#deployment)
9. [Troubleshooting](#troubleshooting)
10. [What is not built](#what-is-not-built)

---

## Quick start

Requires Node 18+ and PostgreSQL 13+. You will run two processes: the API on
:3000 and the frontend dev server on :5173.

**1. Backend**

```bash
createdb ticket_booking
createdb ticket_booking_test          # only needed to run the tests

cd backend
npm install
cp .env.example .env                  # defaults work for local Postgres

npm run migrate                       # create the schema
npm run seed                          # load demo accounts + a venue
npm start                             # API on http://localhost:3000
```

**2. Frontend** — in a second terminal:

```bash
cd frontend
npm install
cp .env.example .env.local            # defaults point at http://localhost:3000
npm run dev                           # UI on http://localhost:5173
```

Open <http://localhost:5173>.

> The backend no longer serves the UI. It still has an `express.static` mount over
> `frontend/`, but a Vite project's `index.html` references `/src/main.tsx`, which
> only the dev server can resolve — so <http://localhost:3000> will not render the
> app. Use :5173 in development, and deploy the built SPA separately (see
> [Deployment](#deployment)).

Seeded accounts:

| Role | Email | Password |
|---|---|---|
| Admin | `admin@ticketbooking.local` | `admin12345` |
| Organiser | `organiser@ticketbooking.local` | `organiser123` |
| Customer | `customer@ticketbooking.local` | `customer123` |
| Customer | `customer2@ticketbooking.local` | `customer123` |

The seed also creates a venue, **Grand Auditorium**, with a 46-seat layout
(rows A–B Premium, C–E Standard). Sign in as the organiser to attach an event and a
showing to it, then browse as a customer.

### Scripts

Backend, from `backend/`:

| Command | What it does |
|---|---|
| `npm start` | Run the API + websocket + sweeper |
| `npm run dev` | Same, with `--watch` |
| `npm run migrate` | Apply pending migrations |
| `npm run migrate:status` | List applied / pending migrations |
| `npm run migrate:reset` | Drop and rebuild the schema (refuses in production) |
| `npm run seed` | Create the admin + demo data (idempotent) |
| `npm test` | Full Jest suite against `ticket_booking_test` |
| `./scripts/smoke.sh` | End-to-end API walk against a running server |
| `./scripts/race-check.sh [N]` | Fire N parallel holds at one seat |
| `./scripts/waitlist-check.sh` | Walk the full waitlist cascade loop |
| `./scripts/offer-probe.sh [SHOW]` | Generate a real waitlist offer and print its payload |

The shell scripts need a running server. `waitlist-check.sh` also needs `psql` to
force offer deadlines into the past; if it is not on your `PATH`, pass it explicitly:

```bash
PSQL=/opt/homebrew/opt/postgresql@15/bin/psql ./scripts/waitlist-check.sh
```

Frontend, from `frontend/`:

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on :5173 |
| `npm run build` | Typecheck, then production build to `dist/` |
| `npm run preview` | Serve the built bundle locally |
| `npm run typecheck` | `tsc --noEmit` |
| `node scripts/verify-api-contract.mjs` | Assert every endpoint the client calls matches the live API |

`verify-api-contract.mjs` is the frontend's counterpart to the backend's smoke test:
it walks all 30-odd endpoint/method pairs the typed client declares and checks the
response shapes, which catches a wrong URL or verb that TypeScript cannot see.

---

## Configuration

All configuration is environment-driven. The database is a single
`DATABASE_URL` connection string, which is what Render and Railway inject when you
attach their managed Postgres add-on.

```
postgresql://USER:PASSWORD@HOST:PORT/DATABASE
```

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://localhost:5432/ticket_booking` | Standard connection string |
| `TEST_DATABASE_URL` | `...ticket_booking_test` | Used only by `npm test` |
| `PORT` | `3000` | |
| `JWT_SECRET` | dev fallback | **Required in production** — boot fails without it |
| `JWT_EXPIRES_IN` | `12h` | |
| `BCRYPT_ROUNDS` | `10` | |
| `HOLD_TTL_MINUTES` | `10` | How long a checkout hold lasts |
| `OFFER_TTL_MINUTES` | `30` | How long a waitlist offer lasts |
| `SWEEP_CRON` | `*/15 * * * * *` | Expiry sweep schedule (every 15s) |
| `SWEEP_ENABLED` | `true` | Set `false` on extra instances |
| `PG_POOL_MAX` | `10` | Keep modest on free tiers |
| `PGSSL` | auto | TLS auto-enabled for non-local hosts |
| `MJ_APIKEY_PUBLIC` / `MJ_APIKEY_PRIVATE` | *(empty)* | Mailjet Send API v3.1 — preferred, runs over 443 |
| `SMTP_HOST` | *(empty)* | SMTP fallback, used only when the Mailjet keys are empty |
| `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | | Mailtrap works well for dev |
| `MAIL_FROM` | `TixLock <no-reply@...>` | Must be a validated sender at the provider |
| `PUBLIC_URL` | `http://localhost:3000` | Base URL for waitlist offer links in emails |
| `API_PUBLIC_URL` | Railway domain | This API's own origin; backs the QR image in emails |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | see `.env.example` | Used by `npm run seed` |

`.env.example` documents every variable with inline commentary.

**Email delivery order.** Both Mailjet keys → its HTTPS API; else `SMTP_HOST` → SMTP;
else a console transport. Deploying to Railway means using the HTTPS path: Railway
blocks outbound SMTP on Free/Trial/Hobby plans, so every SMTP port times out there.

**Email is optional in development.** With none of those set, the mailer switches to a
console transport, so the whole application — including waitlist offers — runs end to
end with no provider account. Messages are logged rather than sent.

**Tests never send mail.** `NODE_ENV=test` forces the console transport regardless of
configuration, and outside tests any recipient on a non-routable domain (`.test`,
`.example`, `.invalid`, `.localhost`, `.local`, `example.com`) is skipped. Both guards
exist because the suite once delivered its fixtures for real: 651 sends in two days,
625 of them bouncing off `test.local`, which exhausted the provider allowance and
stopped genuine booking confirmations going out.

---

## How seat holds work (plain English)

**The problem.** A seat map is a shared resource. Two people clicking seat A4 at the
same instant must not both be told they got it.

**The hold.** When you select seats and press *Hold*, those seats are marked `held`
with your user id and a deadline 10 minutes out. Nobody else can take them. A
countdown appears in the checkout panel, driven by the *server's* deadline rather
than a timer counting down in your browser — so backgrounding the tab or sleeping the
laptop cannot make your timer disagree with the server.

**Why the check is safe.** The whole check-and-claim is a single database operation
inside a transaction. The database locks the candidate seat rows, so a second request
for the same seat waits, then re-reads and finds the seat taken. Exactly one request
wins; the other gets a `409` naming which seats it lost, and the UI greys them out.
The losing request holds *nothing* — a request for three seats where one is gone
holds zero, not two.

**Expiry.** A background job runs every 15 seconds, finds holds past their deadline,
frees them, and pushes the change to every open seat map over Socket.io so nobody has
to refresh.

**Expiry does not depend on that job.** Every read treats a hold whose deadline has
passed as already free, and every write re-checks the deadline inside its own
transaction. If the sweeper were switched off, seat maps would still be accurate and
no seat could be double-sold — the job just tidies rows and sends notifications. This
matters because it means correctness never rides on a scheduler firing on time.

**Booking.** Confirming turns your held seats into a booking. The total is computed
on the server from the show's pricing; the request body has no amount field at all, so
a crafted request cannot change what you pay. The booking is committed first, and only
then is the QR code rendered and the confirmation email queued — a slow or broken
mail server can never fail or delay a booking.

---

## How the waitlist works (plain English)

**Joining.** When every seat in a category is gone, you can join that category's
waitlist. You are told your position in the queue. You cannot join a category that
still has seats — buy those instead.

**When a seat frees up.** Whenever a seat stops being sold — someone cancels, or a
hold or offer expires — the system asks one question: *is anyone waiting for this
category?*

- **Yes** → the seat is reserved for whoever has waited longest, for 30 minutes, and
  they get an email with a single-use link to claim it. The seat is never briefly put
  back on general sale first, so nobody can snipe it ahead of the queue.
- **No** → the seat goes back on sale normally.

**If the offer is ignored.** The sweeper notices the 30 minutes has elapsed, marks
that person as having missed their turn, and asks the same question again — so the
seat **cascades to the next person in the queue**. Only when the queue is empty does
the seat return to general sale.

**Claiming.** The emailed link opens a page showing the seat, the price, and a
countdown. Claiming converts it into a normal 10-minute hold and you check out as
usual. The link works exactly once, and only for the person it was issued to — a
forwarded email will not let someone else take the seat.

---

## Proof it is race-condition-free

Three independent checks, all runnable.

### 1. Automated test suite

Real PostgreSQL, no mocks — the guarantee is about database locking semantics, which
a mock cannot reproduce.

```
$ npm test

PASS tests/waitlist.test.js (39.645 s)
PASS tests/booking.test.js (28.428 s)
PASS tests/concurrency.test.js (18.907 s)
PASS tests/dashboard.test.js (17.697 s)
PASS tests/events.test.js (7.274 s)
PASS tests/venues.test.js
PASS tests/realtime.test.js
PASS tests/sweeper.test.js
PASS tests/seatmap.test.js
PASS tests/auth.test.js

Test Suites: 10 passed, 10 total
Tests:       247 passed, 247 total
Time:        126.466 s
```

The concurrency suite fires genuinely parallel requests with `Promise.all`:

```
$ npx jest tests/concurrency.test.js --verbose

  two simultaneous holds on the same seat
    ✓ lets exactly one succeed and rejects the other with 409 (582 ms)
    ✓ tells the loser which seat it lost (553 ms)
  N-way races
    ✓ with 2 parallel requests for one seat, exactly one wins (552 ms)
    ✓ with 5 parallel requests for one seat, exactly one wins (554 ms)
    ✓ with 10 parallel requests for one seat, exactly one wins (557 ms)
    ✓ is repeatable — 10 consecutive 5-way races each produce exactly one winner (582 ms)
    ✓ never oversells: 10 customers racing for 10 distinct seats all succeed (554 ms)
    ✓ 10 customers racing for the same 3 seats: one wins all 3, nine get nothing (557 ms)
  all-or-nothing across a multi-seat request
    ✓ holds nothing when one seat in the set is already taken (553 ms)
    ✓ holds nothing when a seat is already booked (548 ms)
    ✓ rolls back cleanly under partial overlap between two parallel requests (549 ms)
    ✓ does not deadlock when two requests ask for the same seats in opposite order (550 ms)
    ✓ treats a duplicated seat id in one request as a single seat (548 ms)
  hold expiry is enforced by the database, not by the sweeper
    ✓ allows another customer to claim a seat whose hold has lapsed, before any sweep (550 ms)
    ✓ still rejects a seat whose hold is live (551 ms)
    ✓ lets two customers race for an expired seat with exactly one winner (550 ms)
  ...

Tests: 34 passed, 34 total
```

Every test asserts on the resulting database state as well as the HTTP responses —
"exactly one 201" is only half the claim; the seat must also end up owned by precisely
the customer who got it.

Booking is covered the same way: two customers racing to book one held seat, a
double-clicked submit producing exactly one booking, and eight parallel bookings
across eight seats with no overselling.

### 2. Manual parallel curl

`scripts/race-check.sh` registers N customers, then fires N backgrounded `curl`
requests at the same seat simultaneously.

```
$ ./scripts/race-check.sh 5

=== Seat hold race check ===
Target:   http://localhost:3000
Requests: 5
1. Preparing 5 customer accounts
   5 tokens acquired
2. Discovering a show
   show id: 1
3. Discovering an available seat
   seat id: 1
4. Firing 5 parallel holds at show 1, seat 1
5. Results
   #1   201 HELD        {"show_id":1,"seat_ids":[1],"hold_expires_at":"2026-08-20T20:28:54.244Z",...
   #2   409 CONFLICT    {"error":{"code":"SEATS_UNAVAILABLE","message":"One or more selected seats...
   #3   409 CONFLICT    {"error":{"code":"SEATS_UNAVAILABLE","message":"One or more selected seats...
   #4   409 CONFLICT    {"error":{"code":"SEATS_UNAVAILABLE","message":"One or more selected seats...
   #5   409 CONFLICT    {"error":{"code":"SEATS_UNAVAILABLE","message":"One or more selected seats...
   ----------------------------------
   held (201):      1
   conflict (409):  4
   unexpected:      0
   ----------------------------------
PASS - exactly one request held seat 1; the other 4 were rejected with 409.
```

Verified at 2, 5, 10 and 20 concurrent requests. The script exits non-zero if more
than one request ever succeeds.

### 3. Full waitlist cascade, end to end

`scripts/waitlist-check.sh` drives the whole loop against a running server and waits
for the **real** cron sweeper rather than calling the sweep function directly.

```
$ ./scripts/waitlist-check.sh

3. Owner cancels — the seat must be OFFERED to Alice, not released
  ok    cancel succeeds                                        200
  ok    offered to waitlist                                    1
  ok    released to general sale                               0
  ok    seat status is 'offered'                               offered
  ok    reserved for Alice                                     11
  ok    Alice got a single-use token                           yes
  ok    Bob cannot hold Alice's reserved seat                  409
4. Alice does nothing — the seat must CASCADE to Bob, not be released
  ... expired Alice's offer, waiting for the 15s cron sweep......... swept
  ok    seat is still 'offered' (not available)                offered
  ok    now reserved for Bob                                   12
  ok    Alice's entry is 'expired'                             expired
5. Bob does nothing either — queue is now empty, so the seat is released
  ... expired Bob's offer, waiting for the 15s cron sweep............... swept
  ok    seat is finally 'available'                            available
  ok    both entries expired                                   2
7. Offer acceptance is single use
  ok    wrong customer cannot claim                            409
  ok    Alice claims the offer                                 200
  ok    token is single use                                    409
  ok    Alice completes the booking                            201
  ok    Alice's entry is 'fulfilled'                           fulfilled
==========================================
  passed: 42
  failed: 0
==========================================
WAITLIST LOOP PASSED
```

### 4. API smoke test

`scripts/smoke.sh` walks the whole customer journey with real HTTP calls — 46
assertions covering health, auth, the role matrix, venue and layout creation, event
and show creation, browsing, seat maps, holds, booking, history, QR retrieval, and
cross-customer access control. All pass.

---

## API reference

Base path `/api`. Authenticated routes take `Authorization: Bearer <token>`.
Errors are always `{ "error": { "code", "message", "details?" } }`.

| Code | Meaning |
|---|---|
| `400 BAD_REQUEST` | Validation failure |
| `401 UNAUTHORIZED` | Missing / invalid / expired token |
| `403 FORBIDDEN` | Authenticated but wrong role or not the owner |
| `404 NOT_FOUND` | No such resource (also used to hide others' bookings) |
| `409 CONFLICT` | State conflict (already exists, already cancelled) |
| `409 SEATS_UNAVAILABLE` | Seat contention; `details.unavailableSeatIds` lists them |
| `503 DB_UNAVAILABLE` / `TIMEOUT` | Database unreachable or too slow |

### Auth

| Method | Path | Access | Notes |
|---|---|---|---|
| `POST` | `/auth/register` | public | `{ name, email, password, role? }`, role ∈ `customer`\|`organiser`. Returns user + token |
| `POST` | `/auth/login` | public | `{ email, password }` — all roles |
| `GET` | `/auth/me` | any | Current user |

`role: "admin"` is rejected with 400. Admins come from `npm run seed` only.

### Venues and layouts (admin)

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET` | `/venues` | any signed in | Organisers need this to pick a venue |
| `GET` | `/venues/:id` | any signed in | Includes grouped layout, `categories`, `locked` |
| `POST` | `/venues` | admin | `{ name, address?, layout? }` — creates venue and seats in one call |
| `PATCH` | `/venues/:id` | admin | `{ name?, address? }` |
| `PUT` | `/venues/:id/layout` | admin | `{ layout: [{ row_label, seats, category }] }` — replaces the layout |

Layout is idempotent: posting the same 30-seat layout twice leaves 30 seats, not 60.
Once any show exists for a venue the layout is frozen (409) — its `show_seats` were
generated from it, and rewriting it would desynchronise sold tickets.

### Events and shows (organiser)

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET` | `/events` | public | Filters: `type`, `date_from`, `date_to`, `venue_id`, `organiser_id`, `q`, `upcoming` |
| `GET` | `/events/mine` | organiser, admin | Own events |
| `GET` | `/events/:id` | public | Shows with pricing and live availability |
| `POST` | `/events` | organiser, admin | `{ title, type, venue_id, description? }` |
| `POST` | `/events/:id/shows` | owner, admin | `{ date, time, pricing: { Category: price } }` |
| `DELETE` | `/events/:eventId/shows/:showId` | owner, admin | Only if nothing is booked |

Creating a show generates one `show_seats` row per venue seat and inserts pricing in a
single transaction. Pricing must cover exactly the venue's categories — missing or
unknown categories are rejected and nothing is created.

### Seat maps and holds (customer)

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET` | `/shows/:id` | public | Show plus pricing |
| `GET` | `/shows/:id/seats` | public (auth optional) | Seat map; signing in adds `held_by_me` |
| `GET` | `/shows/:id/availability` | public | Per-category counts and `sold_out` |
| `POST` | `/shows/:id/hold` | customer | `{ seat_ids: [...] }` → 201 or 409 |
| `DELETE` | `/shows/:id/hold` | customer | `{ seat_ids? }`, omit to release all |
| `GET` | `/shows/:id/my-holds` | customer | Restores a countdown after a page reload |

The seat map never exposes who holds a seat — only whether it is yours.

### Bookings (customer)

| Method | Path | Access | Notes |
|---|---|---|---|
| `POST` | `/bookings` | customer | `{ show_id, seat_ids }`. Total computed server-side |
| `GET` | `/bookings` | customer | Own history, newest first |
| `GET` | `/bookings/:id` | owner, staff | 404 for other customers |
| `GET` | `/bookings/:id/qr` | owner, staff | Regenerates the ticket QR |
| `GET` | `/bookings/ref/:ref` | any signed in | Resolves a scanned QR payload |
| `POST` | `/bookings/:id/cancel` | owner, admin | Releases seats through the waitlist |

Cancellation responds with `seats_released` and `seats_offered_to_waitlist`.

### Waitlist (customer)

| Method | Path | Access | Notes |
|---|---|---|---|
| `POST` | `/waitlist` | customer | `{ show_id, category }`. 409 if seats remain |
| `GET` | `/waitlist/mine` | customer | Entries with queue positions |
| `DELETE` | `/waitlist/:id` | customer | Leave, while still `waiting` |
| `GET` | `/waitlist/offers/:token` | public | Renders an offer without consuming it |
| `POST` | `/waitlist/offers/:token/accept` | customer | Consumes the token → normal hold |

The read-only offer endpoint needs no session: the token *is* the credential, and it
returns only seat, show and deadline — no customer identity. Accepting requires
auth so the offer can be matched to the right person.

### Organiser dashboard

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET` | `/dashboard/summary` | organiser, admin | All own events with seats sold and revenue |
| `GET` | `/dashboard/events/:id` | owner, admin | Per-show and per-category breakdown |
| `GET` | `/dashboard/events/:id/bookings` | owner, admin | Attendee list, `?limit=` 1–500 |

Revenue counts confirmed bookings only, and reads the price captured at the point of
sale — so re-pricing a show never rewrites past takings.

### System

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Database connectivity and configured TTLs |

### Socket.io

Clients emit `show:join` with a show id and receive:

| Event | Payload |
|---|---|
| `show:joined` | `{ showId }` |
| `seats:updated` | `{ showId, reason, seats[], actorId, at }` |
| `availability:changed` | `{ showId, reason }` |

`reason` is one of `hold`, `release`, `booked`, `cancelled`, `hold-expired`,
`offer-expired`, `offer-accepted`. Broadcasts never include `held_by`.

---

## Database schema

Migrations are forward-only numbered `.sql` files in `backend/src/migrations`, applied
by a small runner that records each filename in `schema_migrations` and runs each file
in its own transaction. It refuses to proceed if an already-applied migration has been
edited.

Full DDL: [`backend/src/migrations/001_init.sql`](backend/src/migrations/001_init.sql).
The parts that carry the correctness guarantees:

```sql
CREATE TYPE user_role       AS ENUM ('customer', 'organiser', 'admin');
CREATE TYPE event_type      AS ENUM ('movie', 'concert');
CREATE TYPE booking_status  AS ENUM ('confirmed', 'cancelled');
CREATE TYPE waitlist_status AS ENUM ('waiting', 'offered', 'expired', 'fulfilled');
CREATE TYPE seat_status     AS ENUM ('available', 'held', 'booked', 'offered');

CREATE TABLE show_seats (
  id              SERIAL PRIMARY KEY,
  show_id         INTEGER     NOT NULL REFERENCES shows (id) ON DELETE CASCADE,
  venue_seat_id   INTEGER     NOT NULL REFERENCES venue_seats (id) ON DELETE RESTRICT,
  category        TEXT        NOT NULL CHECK (length(btrim(category)) > 0),
  status          seat_status NOT NULL DEFAULT 'available',
  held_by         INTEGER     REFERENCES users (id) ON DELETE SET NULL,
  hold_expires_at TIMESTAMPTZ,

  CONSTRAINT show_seats_unique_seat UNIQUE (show_id, venue_seat_id),

  -- A transient state must carry its owner and deadline; a settled state must not.
  CONSTRAINT show_seats_hold_fields_consistent CHECK (
    (status IN ('held','offered') AND held_by IS NOT NULL AND hold_expires_at IS NOT NULL)
    OR
    (status IN ('available','booked') AND held_by IS NULL AND hold_expires_at IS NULL)
  )
);

CREATE INDEX show_seats_show_status_idx   ON show_seats (show_id, status);
CREATE INDEX show_seats_status_expiry_idx ON show_seats (status, hold_expires_at);

CREATE TABLE waitlist (
  id                   SERIAL PRIMARY KEY,
  show_id              INTEGER         NOT NULL REFERENCES shows (id) ON DELETE CASCADE,
  category             TEXT            NOT NULL,
  customer_id          INTEGER         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status               waitlist_status NOT NULL DEFAULT 'waiting',
  joined_at            TIMESTAMPTZ     NOT NULL DEFAULT now(),
  offer_expires_at     TIMESTAMPTZ,
  offer_token          TEXT UNIQUE,
  offered_show_seat_id INTEGER         REFERENCES show_seats (id) ON DELETE SET NULL,

  CONSTRAINT waitlist_offer_fields_consistent CHECK (
    (status = 'offered' AND offer_expires_at IS NOT NULL AND offer_token IS NOT NULL)
    OR
    (status <> 'offered' AND offer_token IS NULL)
  )
);

CREATE INDEX waitlist_fifo_idx ON waitlist (show_id, category, status, joined_at);

-- One active queue entry per customer per (show, category).
CREATE UNIQUE INDEX waitlist_one_active_per_customer_idx
  ON waitlist (show_id, category, customer_id)
  WHERE status IN ('waiting', 'offered');
```

Notes on the design:

- **Every status column is a native enum.** A free-text status column drifts — a typo
  like `'Booked'` inserts happily and then silently fails every filter.
- **`seat_status` has four values, not three.** A waitlist offer must be
  distinguishable from an ordinary hold, because the sweeper treats their expiry
  differently: an expired hold is released, an expired offer cascades to the next
  person in the queue. Overloading `held` would erase the information the sweep needs.
- **The consistency `CHECK` constraints are load-bearing.** They caught two real bugs
  during development, including an attempt to clear an offer token while leaving the
  row marked `offered`.
- **Money is `NUMERIC(10,2)` and never parsed into a JavaScript number.** `booking_seats`
  stores the price paid per seat so historical revenue is stable.
- **All time arithmetic happens in PostgreSQL** via `now()`, so the app server's clock
  is never authoritative.

---

## Deployment

Two independent deployments: the frontend is a static SPA, the backend is an API-only
service. The backend already sends `Access-Control-Allow-Origin: *`, so no CORS
configuration is needed for the split.

### Backend — Render

1. New → Web Service, point at this repo.
2. Root directory `backend`, build `npm install`, start `npm start`.
3. New → PostgreSQL, then attach it to the service. Render injects `DATABASE_URL`
   automatically — do **not** set it manually.
4. Set `JWT_SECRET` (generate with
   `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`) and
   `PUBLIC_URL` — **this must be the deployed frontend URL**, because it is the base
   for the waitlist offer links that go out in emails. With a split deployment that
   is your Vercel URL, not the backend's own.
5. Deploy, then run once in the service shell:
   ```bash
   npm run migrate && npm run seed
   ```

### Backend — Railway

Same shape: add the PostgreSQL plugin (it provides `DATABASE_URL`), set root directory
to `backend`, start command `npm start`, set `JWT_SECRET` and `PUBLIC_URL`, then run
`npm run migrate` once.

### Frontend — Vercel

1. New Project → import this repo, set **Root Directory** to `frontend`.
2. Framework preset Vite; build and output settings come from `frontend/vercel.json`.
3. Set one environment variable:
   ```
   VITE_API_URL = https://your-backend.onrender.com
   ```
   `VITE_SOCKET_URL` is optional — it defaults to `VITE_API_URL`, which is correct
   because the backend serves the websocket on the same origin as the API.
4. Deploy.

`vercel.json` supplies the SPA rewrite that makes deep links work: without it a
refresh on `/shows/12` or on an emailed `/offer?token=…` link would 404, since only
`index.html` exists on disk.

Both `VITE_*` variables are baked into the bundle at build time and are visible to
anyone who views source, so never put a secret in them. Changing either requires a
redeploy, not just a restart.

TLS is enabled automatically for non-local database hosts, so no extra SSL flags are
needed. Override with `PGSSL=true|false` if detection is wrong for your provider.

**Scaling caveat:** the expiry sweeper is a single-instance cron job. If you run more
than one instance, set `SWEEP_ENABLED=false` on all but one, otherwise they will
double-sweep and can send duplicate offer emails. See the trade-offs section of
SYSTEM_DESIGN.md.

---

## Troubleshooting

**`cannot reach the database` on boot.**
Check `DATABASE_URL` and that Postgres is accepting connections
(`pg_isready -h localhost`). The server deliberately fails fast at boot rather than
serving 500s from every endpoint.

**Connections dropping after the app has been idle — the big free-tier gotcha.**
Free-tier managed Postgres on Render, Railway and Neon closes idle connections
without warning, and some providers idle the whole database after inactivity. `pg`
surfaces this as an `error` event on an idle pooled client; if nothing is listening,
Node treats it as an unhandled `'error'` event and **kills the process**.

`src/config/db.js` handles it:

```js
pool.on('error', (err) => {
  console.error('[db] idle client error (connection will be replaced):', err.message);
});
```

By the time this fires, `pg` has already removed the dead client from the pool, so the
next checkout transparently dials a fresh connection. Not crashing is the whole fix.
If you see `[db] idle client error` in the logs followed by requests succeeding
normally, that is this mechanism working as intended.

Related: keep `PG_POOL_MAX` low (default 10). Free tiers cap total connections
sharply, and a pool larger than your allowance will fail at checkout under load.

**`relation "users" does not exist`.**
Migrations have not run. `npm run migrate`.

**`Migration 001_init.sql was modified after it was applied`.**
An already-applied migration file was edited. In development, `npm run migrate:reset`.
In production, add a new migration instead — history is forward-only.

**Tests fail with `Refusing to reset a database whose URL does not contain "test"`.**
Safety guard. Point `TEST_DATABASE_URL` at a dedicated test database.

**Emails are not arriving.** Read the boot line first — it names the transport in use:
`[mail] Mailjet HTTPS API transport ready`, `[mail] SMTP transport ready (host:port)`,
or the console fallback. Then check the per-send lines:

| Log line | Meaning |
|---|---|
| `[mail] (not sent) to=…` | Console transport. Nothing is configured; intentional in dev |
| `[mail] (skipped, unroutable domain) to=…` | Recipient is on a reserved domain that cannot receive mail |
| `[mail] failed to send "…" to …: <reason>` | The provider refused it. The reason is verbatim from them |
| `[mail] sent to=… id=…` | The provider accepted it |

An accepted message can still go undelivered — quota exhaustion and suppression
happen after acceptance — so if the log says `sent` and no mail arrives, the answer is
in the provider's own event log rather than here. For Mailjet that is Statistics →
Messages, or `GET /v3/messages`. Check the sender in `MAIL_FROM` is validated and the
daily cap (200 on the free tier) is not spent.

Email failures never affect bookings: mail is a post-commit side effect and the mailer
never throws.

**Seats look stuck as held.**
Check the sweeper is running — the boot log prints `[sweep] scheduled "*/15 * * * * *"`.
Even if it is stopped, seat maps stay accurate because expired holds are treated as
available at read time; the rows just are not tidied up.

**A seat map is not updating live.**
Confirm `/socket.io/socket.io.js` returns 200 and the header shows `● Live`. The page
still works without websockets; it just will not auto-refresh.

**`403` from a route you expect to work.**
Roles are enforced server-side and the user row is re-read on every request, so a role
change takes effect immediately. Sign out and back in if you changed a role directly
in the database.

**The UI does not load at <http://localhost:3000>.**
Expected. The backend is API-only now; the frontend runs on :5173 in development. The
`express.static` mount over `frontend/` still exists but a Vite project's `index.html`
points at `/src/main.tsx`, which only the dev server can compile.

**Frontend shows "Cannot reach the server".**
Check `VITE_API_URL` in `frontend/.env.local` and that the API answers
`curl localhost:3000/api/health`. Vite only reads env files at startup, so restart the
dev server after editing one. Note the value must not include a `/api` suffix — the
client appends that itself.

**Seat map says "Updates paused".**
The websocket could not connect after several attempts. The page still works, it just
will not update by itself; refresh to see current seats. Confirm
`VITE_SOCKET_URL` (or `VITE_API_URL`) points at the backend origin, and that nothing
between you and it is stripping websocket upgrades.

**Deep links 404 after deploying the frontend.**
The SPA rewrite is missing. On Vercel it comes from `frontend/vercel.json`; on any
other host, route every non-asset path to `index.html`.

---

## What is not built

Deliberate scope limits, to keep the concurrency surface small and thoroughly tested:

- **No payment gateway.** Bookings are treated as paid on confirmation.
- **No refunds** — cancellation releases seats but does not move money.
- **Waitlists are per-category**, so you cannot wait for one specific seat.
- **No general-admission events**; every event is seated.
- **No password reset**, ticket transfer, or internationalisation.
- **Offer emails are not retried** if SMTP fails; the failure is logged. A production
  system would use an outbox table with retries.

## Project layout

```
backend/
  src/
    config/       env.js, db.js (single pg.Pool, DATE/NUMERIC type parsers)
    migrations/   001_init.sql, run.js
    middleware/   auth.js (JWT + requireRole), error.js
    lib/          errors.js, validate.js
    routes/       auth, venues, events, shows, holds, bookings, waitlist, dashboard
    services/     authService, venueService, eventService, seatService,
                  holdService, bookingService, waitlistService,
                  dashboardService, qrService, mailer
    jobs/         sweeper.js       (node-cron, every 15s)
    realtime/     io.js            (Socket.io rooms)
    scripts/      seed.js
    app.js  server.js
  tests/          10 suites, 247 tests
  scripts/        smoke.sh, race-check.sh, waitlist-check.sh

frontend/
  src/
    lib/
      api/client.ts     Axios instance, ApiError, JWT interceptor, 401 handling
      api/endpoints.ts  One typed function per backend endpoint
      api/types.ts      TypeScript mirrors of the real API responses
      money.ts          toMoney() — normalises the API's string|number money
      datetime.ts       Timezone-safe parsing of bare date/time strings
      queryKeys.ts      Centralised React Query keys
      queryClient.ts    Retry policy (never retries a 4xx)
    store/              auth, seatSelection, theme (Zustand)
    hooks/
      useSeatSocket.ts  Socket.io subscription + targeted cache patching
      useCountdown.ts   Countdown driven by the server's absolute deadline
      useSeatMap.ts     Seat map queries, hold/book/release/waitlist mutations
    components/
      ui/               shadcn/ui primitives
      seatmap/          Seat, SeatMapGrid, CheckoutPanel, HoldCountdown
      dashboard/        Recharts charts, create event/show dialogs
      admin/            Visual seat layout editor
      common/           Empty / error / loading states, lazy boundary
    pages/              One file per route
    routes/             Route table + role guards
  scripts/              verify-api-contract.mjs
  vercel.json           SPA rewrite + asset caching
```

### Frontend notes

Two API quirks the frontend has to absorb, both documented in the code:

- **Money arrives as two types.** Top-level `NUMERIC` columns are exact decimal
  strings (`"650.00"`), but the same value nested in a `json_agg` arrives as a number
  (`650`) because that path bypasses the driver's NUMERIC parser. Everything monetary
  goes through `toMoney()` in `lib/money.ts`.
- **Dates are bare strings, not instants.** `new Date('2026-09-18')` parses as *UTC*
  midnight and renders as the previous day west of UTC — the same class of bug the
  backend's DATE parser override exists to prevent. `lib/datetime.ts` builds Dates
  from explicit local components instead.

Live seat updates patch only the affected seats via `queryClient.setQueryData`. The
one case that triggers a refetch is a change to a seat you hold that you did not
cause: as noted under [Socket.io](#socketio), `seats:updated` deliberately omits
`held_by` so one customer's identity is never broadcast to everyone watching, which
means the event cannot tell you whether a hold is still yours. Only an authenticated
`GET /shows/:id/seats` can. `useSeatSocket.ts` documents this in full.
