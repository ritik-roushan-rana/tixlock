# TixLock

Ticket booking for movies and concerts. Customers pick seats from a live seat map, held
seats auto-release if checkout is abandoned, sold-out categories have a waitlist that
reassigns seats automatically when a booking is cancelled, and every confirmed booking
is emailed a QR-code ticket.

**Live app:** https://tixlock-seven.vercel.app
**API:** https://tixlock-api-production.up.railway.app/api/health

| Role | Email | Password |
|---|---|---|
| Admin | `admin@ticketbooking.local` | `admin12345` |
| Organiser | `organiser@ticketbooking.local` | `organiser123` |
| Customer | `customer@ticketbooking.local` | `customer123` |

The sign-in screen has one-click buttons for these. Created by `npm run seed`.

---

## Stack

**Backend** — Node 20 + Express, PostgreSQL via `pg` (pooled), Socket.io, JWT +
bcrypt, `node-cron` for expiry sweeps, `qrcode`, `nodemailer` over the Mailjet HTTPS
API.
**Frontend** — React 18 + Vite + TypeScript, TanStack Query, Zustand, Tailwind,
Radix primitives, Recharts.
**Deployment** — API on Railway, SPA on Vercel, backend tests and deploy via GitHub
Actions.

The two halves deploy independently. The backend is API-only; it does not serve the UI.

---

## Quick start

Requires Node 20+ and PostgreSQL 14+ running locally.

```bash
git clone https://github.com/ritik-roushan-rana/tixlock.git
cd tixlock

# 1. Database
createdb ticket_booking
createdb ticket_booking_test        # for the test suite

# 2. Backend
cd backend
cp .env.example .env                # then set DATABASE_URL and JWT_SECRET
npm install
npm run migrate                     # apply schema
npm run seed                        # demo users + venue with 46 seats
npm start                           # http://localhost:3000

# 3. Frontend (second terminal)
cd ../frontend
cp .env.example .env.local          # VITE_API_URL=http://localhost:3000
npm install
npm run dev                         # http://localhost:5173
```

Open http://localhost:5173. Email needs no configuration in development — with no mail
credentials set, messages are logged to the console instead of sent.

### Scripts

| Where | Command | Does |
|---|---|---|
| backend | `npm start` / `npm run dev` | Run the API (`dev` watches) |
| backend | `npm run migrate` | Apply migrations |
| backend | `npm run migrate:status` | Show applied migrations |
| backend | `npm run migrate:reset` | Drop and rebuild (refuses non-`test` URLs) |
| backend | `npm run seed` | Demo users, venue, seat layout |
| backend | `npm test` | Jest suite against real PostgreSQL |
| frontend | `npm run dev` | Vite dev server |
| frontend | `npm run build` | Typecheck + production build |
| frontend | `npm run typecheck` | `tsc --noEmit` |

---

## Configuration

`backend/.env.example` and `frontend/.env.example` document every variable inline. The
ones that matter:

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | **Required.** TLS auto-enabled for non-local hosts |
| `TEST_DATABASE_URL` | — | Must contain `test`; the reset guard enforces it |
| `JWT_SECRET` | dev fallback | **Required in production**, boot fails without it |
| `HOLD_TTL_MINUTES` | `10` | Checkout hold lifetime |
| `OFFER_TTL_MINUTES` | `30` | Waitlist offer lifetime |
| `SWEEP_CRON` | `*/15 * * * * *` | Expiry sweep, every 15s |
| `SWEEP_ENABLED` | `true` | Set `false` on extra instances |
| `MJ_APIKEY_PUBLIC` / `MJ_APIKEY_PRIVATE` | — | Mailjet Send API v3.1, preferred |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | — | SMTP fallback |
| `MAIL_FROM` | `TixLock <no-reply@…>` | Must be a validated sender |
| `PUBLIC_URL` | `localhost:3000` | Frontend origin, used in offer links |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | see example | Seeded admin |
| `VITE_API_URL` | — | Frontend → API origin, no `/api` suffix |

**Mail delivery order:** both Mailjet keys → its HTTPS API; else `SMTP_HOST` → SMTP;
else a console transport. Railway blocks outbound SMTP on its free plans, so the HTTPS
path is the one that works there. `NODE_ENV=test` always forces the console transport,
and recipients on non-routable domains (`.test`, `.local`, `example.com`) are skipped —
without those guards the suite delivers hundreds of fixture emails to a real provider.

---

## How seat holds work

`show_seats` is the sellable inventory: one row per seat per show, cloned from the
venue's `venue_seats` template when the show is created. Status is
`available | held | booked | offered`.

1. Customer selects seats and `POST /shows/:id/hold` flips them to `held` with
   `hold_expires_at = now() + HOLD_TTL_MINUTES`, computed by PostgreSQL.
2. Other customers see those seats as unavailable immediately, pushed over Socket.io.
3. Abandoned checkout needs no cleanup to stay correct: **every read treats an expired
   hold as available and every write re-checks the expiry**. The 15-second cron only
   tidies rows and emits the socket update.
4. `POST /bookings` converts the caller's own live holds into a booking, prices them
   from `show_pricing` in SQL, then generates the QR and emails it after commit.

Two customers cannot hold the same seat. Each mutation is one transaction that locks the
candidate rows with `SELECT … FOR UPDATE` and re-checks their status inside that lock; if
fewer rows come back than were asked for, it rolls back with `409 SEATS_UNAVAILABLE`
naming the lost seat ids. Booking applies the same shape with a stricter predicate — the
seat must still be `held` by the caller and unexpired — which is what keeps a seat inside
at most one confirmed booking.

## How the waitlist works

When a category is sold out, `POST /waitlist` joins a per-category queue.

One function decides where any released seat goes, for every release path —
cancellation, explicit release, hold expiry, offer expiry:

```
seat released
   ├─ someone waiting in this category?  (oldest first, FOR UPDATE SKIP LOCKED)
   │     yes → status 'offered', 32-byte offer_token, expires in OFFER_TTL_MINUTES
   │           → email with a single-use link
   └─    no  → status 'available', back on public sale
```

The seat is never made `available` first and then offered, so nobody can jump a queue
that has people in it. If the offer is not accepted in time, the sweep marks the entry
`expired` and runs the same logic again, cascading to the next person and reaching
public sale only when the queue empties. Accepting converts the offer into a normal
hold, so checkout is unchanged; the token is cleared in the transaction that validates
it, so it cannot be replayed.

Full reasoning, including the SQL and why `READ COMMITTED` suffices, is in
[SYSTEM_DESIGN.md](SYSTEM_DESIGN.md).

---

## API

Base path `/api`. Auth is `Authorization: Bearer <jwt>`. Errors are
`{ error: { code, message, details? } }`.

### Auth
| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/auth/register` | public | Register (customer or organiser) |
| POST | `/auth/login` | public | Returns `{ user, token }` |
| GET | `/auth/me` | any | Current user, re-read from the database |

### Venues and layouts
| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/venues` | any | List venues |
| GET | `/venues/:id` | any | Venue with seat layout |
| POST | `/venues` | admin | Create venue |
| PATCH | `/venues/:id` | admin | Rename / update address |
| PUT | `/venues/:id/layout` | admin | Replace seat layout and categories |

### Events and shows
| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/events` | public | Browse; filters `type`, `date_from`, `date_to`, `q`, `venue_id`, `upcoming` |
| GET | `/events/:id` | public | Event with shows, pricing, availability |
| GET | `/events/mine` | organiser, admin | Caller's own events |
| POST | `/events` | organiser, admin | Create event |
| POST | `/events/:id/shows` | organiser, admin | Add show + per-category pricing; stamps `show_seats` |
| DELETE | `/events/:eventId/shows/:showId` | organiser, admin | Delete an unsold show |

### Seat map and holds
| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/shows/:id` | public | Show detail + pricing |
| GET | `/shows/:id/seats` | optional auth | Seat map; adds `held_by_me` when signed in |
| GET | `/shows/:id/availability` | public | Per-category counts and `sold_out` |
| POST | `/shows/:id/hold` | customer | Hold seats; `409 SEATS_UNAVAILABLE` on conflict |
| DELETE | `/shows/:id/hold` | customer | Release own holds (routed via the waitlist) |
| GET | `/shows/:id/my-holds` | customer | Own holds + server-derived time left |

### Bookings
| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/bookings` | customer | Confirm held seats; sends QR email |
| GET | `/bookings` | customer | Booking history |
| GET | `/bookings/:id` | owner | Single booking |
| GET | `/bookings/ref/:ref` | any | Look up by reference |
| GET | `/bookings/:id/qr` | owner | QR as a data URL |
| GET | `/bookings/qr/:ref.png` | public | QR as PNG, for email clients |
| POST | `/bookings/:id/cancel` | owner | Cancel; releases seats to the waitlist |

### Waitlist
| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/waitlist` | customer | Join a category queue |
| GET | `/waitlist/mine` | customer | Entries with queue position |
| DELETE | `/waitlist/:id` | customer | Leave while still `waiting` |
| GET | `/waitlist/offers/:token` | public | Inspect an offer without consuming it |
| POST | `/waitlist/offers/:token/accept` | customer | Consume token → normal hold |

### Dashboard and system
| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/dashboard/summary` | organiser, admin | Totals and revenue |
| GET | `/dashboard/events/:id` | organiser, admin | Per-event bookings and revenue |
| GET | `/dashboard/events/:id/bookings` | organiser, admin | Attendee list |
| GET | `/health` | public | Status, DB, TTLs, active mail transport |

### Socket.io
Client joins room `show:<id>` and receives:

| Event | Payload | When |
|---|---|---|
| `seats:updated` | `{ show_id, seats[] }` | Hold, release, book, cancel, sweep |
| `availability:changed` | `{ show_id, categories[] }` | Category counts change |

---

## Database schema

PostgreSQL, one migration (`backend/src/migrations/001_init.sql`). Enums:
`user_role`, `event_type`, `seat_status`, `booking_status`, `waitlist_status`.

| Table | Key columns | Notes |
|---|---|---|
| `users` | `email` unique, `password_hash`, `role` | Case-insensitive unique index on `lower(email)` |
| `venues` | `name`, `address`, `created_by` | Admin-owned |
| `venue_seats` | `venue_id`, `row_label`, `seat_number`, `category` | Layout template; unique per venue+row+number |
| `events` | `title`, `type`, `organiser_id`, `venue_id` | |
| `shows` | `event_id`, `date`, `time` | Unique per event+date+time |
| `show_pricing` | `show_id`, `category`, `price` | Unique per show+category |
| `show_seats` | `show_id`, `venue_seat_id`, `status`, `held_by`, `hold_expires_at` | The inventory. Unique per show+seat; CHECK keeps hold fields consistent with status |
| `bookings` | `booking_ref` unique, `customer_id`, `show_id`, `total_amount`, `status` | CHECK ties `cancelled_at` to status |
| `booking_seats` | `booking_id`, `show_seat_id`, `price` | Unique per booking+seat. A seat can be re-booked after cancellation, so `show_seat_id` is *not* globally unique; "at most one confirmed booking per seat" is held by the booking transaction, with an index here to audit it |
| `waitlist` | `show_id`, `category`, `customer_id`, `status`, `joined_at`, `offer_token` unique, `offer_expires_at`, `offered_show_seat_id` | Queue ordered by `(joined_at, id)` |

Money is `NUMERIC(10,2)` and travels as a string, never a float. Dates are `DATE`/`TIME`
and are returned exactly as stored, with no timezone shifting.

---

## Tests

```bash
cd backend && npm test          # 265 tests, 10 suites
```

Runs against a real PostgreSQL database (`TEST_DATABASE_URL`), not a mock — the
correctness argument here is entirely about row locking and transaction semantics, which
a mocked client cannot exercise. `tests/globalSetup.js` rebuilds the schema once per run
and refuses any URL without `test` in it.

Coverage includes concurrent hold and booking attempts on the same seat, TTL expiry and
the sweeper, waitlist offer/expiry/cascade, role guards, QR generation, and post-commit
email behaviour.

Optional browser checks (need a local Chrome and `npm i -D puppeteer-core`, deliberately
not a dependency) live in `frontend/scripts/e2e/` — a full user journey, realtime and
waitlist over sockets, a design-system audit, and image loading performance. See
`frontend/scripts/e2e/README.md`.

---

## Deployment

**Backend — Railway.** New service from this repo, root directory `backend`, start
`npm start`. Add the PostgreSQL plugin; it injects `DATABASE_URL`. Set `JWT_SECRET`,
`PUBLIC_URL` (the Vercel origin) and the Mailjet keys. Run `npm run migrate` once.

**Frontend — Vercel.** Root directory `frontend`, framework Vite, build `npm run build`,
output `dist`. Set `VITE_API_URL` to the Railway origin, without a `/api` suffix.

**CI — GitHub Actions.** `.github/workflows/deploy-backend.yml` runs the backend suite
against a PostgreSQL service container on pushes touching `backend/**`, then deploys to
Railway and polls `/api/health` until it reports healthy. Needs a `RAILWAY_API_TOKEN`
repo secret.

---

## Layout

```
backend/
  src/
    routes/        HTTP layer, validation, role guards
    services/      business logic and all SQL
    middleware/    auth, error handling
    realtime/      Socket.io setup and emitters
    jobs/          hold and offer expiry sweeper
    migrations/    001_init.sql + runner
    scripts/       seed
    config/        env and pool
  tests/           Jest, 10 suites
  scripts/         shell probes for races and the waitlist cascade
frontend/
  src/
    pages/         one per route, lazy loaded
    components/    seatmap, events, dashboard, admin, ui primitives
    hooks/         seat map, sockets, countdowns
    lib/           api client, query keys, formatting
    store/         auth, seat selection, theme
  scripts/e2e/     browser verification
.github/workflows/ CI and deploy
SYSTEM_DESIGN.md   design write-up
```

## Not built

No payment gateway (bookings are treated as paid), no seat-specific waitlists (per
category only), no email retry queue, and expiry runs on a single instance — see the
trade-offs in [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md).
