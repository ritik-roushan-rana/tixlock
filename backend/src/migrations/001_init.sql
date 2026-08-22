-- 001_init.sql — initial schema for TixLock.
-- Forward-only. Applied exactly once, inside a transaction, by src/migrations/run.js.

-- ---------------------------------------------------------------------------
-- Enum types
--
-- Every status column in this schema is a native Postgres ENUM. Free-text
-- status columns drift: a typo like 'Booked' or 'availble' inserts happily and
-- then silently fails every WHERE clause that filters on it. With an ENUM the
-- bad write is rejected at the database boundary.
-- ---------------------------------------------------------------------------

CREATE TYPE user_role       AS ENUM ('customer', 'organiser', 'admin');
CREATE TYPE event_type      AS ENUM ('movie', 'concert');
CREATE TYPE booking_status  AS ENUM ('confirmed', 'cancelled');
CREATE TYPE waitlist_status AS ENUM ('waiting', 'offered', 'expired', 'fulfilled');

-- seat_status carries a fourth value, 'offered', beyond the available/held/booked
-- triple. A waitlist offer must be distinguishable from an ordinary customer
-- hold, because the cron sweep treats their expiry differently: an expired hold
-- returns the seat to 'available', whereas an expired offer cascades the seat to
-- the next person in the waitlist queue and only falls back to 'available' when
-- that queue is empty. Overloading 'held' would erase the information the sweep
-- needs to make that decision.
CREATE TYPE seat_status     AS ENUM ('available', 'held', 'booked', 'offered');

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  name          TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role          user_role   NOT NULL DEFAULT 'customer',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Emails are compared case-insensitively at the application layer by lowercasing
-- on write; this index makes the uniqueness guarantee match that behaviour even
-- if a row is inserted by hand.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- ---------------------------------------------------------------------------
-- venues + seat layout template
-- ---------------------------------------------------------------------------

CREATE TABLE venues (
  id         SERIAL PRIMARY KEY,
  name       TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  address    TEXT        NOT NULL DEFAULT '',
  created_by INTEGER     NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX venues_created_by_idx ON venues (created_by);

-- The physical seat layout, defined once per venue by an admin. show_seats rows
-- are stamped out from this template each time a show is created.
CREATE TABLE venue_seats (
  id          SERIAL PRIMARY KEY,
  venue_id    INTEGER NOT NULL REFERENCES venues (id) ON DELETE CASCADE,
  row_label   TEXT    NOT NULL CHECK (length(btrim(row_label)) > 0),
  seat_number INTEGER NOT NULL CHECK (seat_number > 0),
  category    TEXT    NOT NULL CHECK (length(btrim(category)) > 0),

  -- Makes layout generation safe to retry: a repeated identical definition
  -- conflicts instead of silently doubling the venue's seat count.
  CONSTRAINT venue_seats_unique_seat UNIQUE (venue_id, row_label, seat_number)
);

CREATE INDEX venue_seats_venue_idx ON venue_seats (venue_id);

-- ---------------------------------------------------------------------------
-- events, shows, pricing
-- ---------------------------------------------------------------------------

CREATE TABLE events (
  id           SERIAL PRIMARY KEY,
  title        TEXT        NOT NULL CHECK (length(btrim(title)) > 0),
  type         event_type  NOT NULL,
  organiser_id INTEGER     NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  venue_id     INTEGER     NOT NULL REFERENCES venues (id) ON DELETE RESTRICT,
  description  TEXT        NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX events_organiser_idx ON events (organiser_id);
CREATE INDEX events_venue_idx     ON events (venue_id);
CREATE INDEX events_type_idx      ON events (type);

CREATE TABLE shows (
  id         SERIAL PRIMARY KEY,
  event_id   INTEGER     NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  date       DATE        NOT NULL,
  time       TIME        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The same event cannot have two showings at the identical date and time.
  CONSTRAINT shows_unique_slot UNIQUE (event_id, date, time)
);

CREATE INDEX shows_event_idx ON shows (event_id);
CREATE INDEX shows_date_idx  ON shows (date);

CREATE TABLE show_pricing (
  id       SERIAL PRIMARY KEY,
  show_id  INTEGER        NOT NULL REFERENCES shows (id) ON DELETE CASCADE,
  category TEXT           NOT NULL CHECK (length(btrim(category)) > 0),
  price    NUMERIC(10, 2) NOT NULL CHECK (price >= 0),

  CONSTRAINT show_pricing_unique_category UNIQUE (show_id, category)
);

CREATE INDEX show_pricing_show_idx ON show_pricing (show_id);

-- ---------------------------------------------------------------------------
-- show_seats — the contended table
--
-- This is the only table where concurrent writers fight over the same rows, so
-- it carries the constraints and indexes that make that fight cheap and correct.
-- ---------------------------------------------------------------------------

CREATE TABLE show_seats (
  id              SERIAL PRIMARY KEY,
  show_id         INTEGER     NOT NULL REFERENCES shows (id) ON DELETE CASCADE,
  venue_seat_id   INTEGER     NOT NULL REFERENCES venue_seats (id) ON DELETE RESTRICT,
  -- Category is copied from venue_seats rather than joined at read time so the
  -- seat map and pricing lookups stay single-table, and so historical shows keep
  -- the category they were sold under even if the venue is later re-categorised.
  category        TEXT        NOT NULL CHECK (length(btrim(category)) > 0),
  status          seat_status NOT NULL DEFAULT 'available',
  -- held_by/hold_expires_at serve both the 'held' and 'offered' states; `status`
  -- disambiguates which lifecycle the row is in.
  held_by         INTEGER     REFERENCES users (id) ON DELETE SET NULL,
  hold_expires_at TIMESTAMPTZ,

  -- One row per physical seat per show. This is the constraint that makes seat
  -- generation idempotent and prevents a double-generated show from selling the
  -- same physical seat twice.
  CONSTRAINT show_seats_unique_seat UNIQUE (show_id, venue_seat_id),

  -- A transient state must always carry its owner and deadline, and a settled
  -- state must never carry them. Without this, a bug that forgets to clear
  -- hold_expires_at leaves a 'available' seat that the sweeper keeps finding, or
  -- a 'held' seat with a NULL deadline that never expires and is unsellable
  -- forever.
  CONSTRAINT show_seats_hold_fields_consistent CHECK (
    (status IN ('held', 'offered') AND held_by IS NOT NULL AND hold_expires_at IS NOT NULL)
    OR
    (status IN ('available', 'booked') AND held_by IS NULL AND hold_expires_at IS NULL)
  )
);

-- Seat map reads: "every seat for show X", frequently filtered by status.
CREATE INDEX show_seats_show_status_idx ON show_seats (show_id, status);

-- The cron sweep runs every 15 seconds and asks for exactly this: rows in a
-- transient status whose deadline has passed. Without this index each sweep is a
-- full scan of every seat of every show ever created.
CREATE INDEX show_seats_status_expiry_idx ON show_seats (status, hold_expires_at);

CREATE INDEX show_seats_held_by_idx ON show_seats (held_by);

-- ---------------------------------------------------------------------------
-- bookings
-- ---------------------------------------------------------------------------

CREATE TABLE bookings (
  id           SERIAL PRIMARY KEY,
  booking_ref  TEXT           NOT NULL UNIQUE,
  customer_id  INTEGER        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  show_id      INTEGER        NOT NULL REFERENCES shows (id) ON DELETE RESTRICT,
  -- Computed server-side from show_pricing at booking time. Stored rather than
  -- recomputed so that a later price change does not rewrite historical revenue.
  total_amount NUMERIC(10, 2) NOT NULL CHECK (total_amount >= 0),
  status       booking_status NOT NULL DEFAULT 'confirmed',
  cancelled_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ    NOT NULL DEFAULT now(),

  CONSTRAINT bookings_cancelled_at_consistent CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL)
    OR
    (status = 'confirmed' AND cancelled_at IS NULL)
  )
);

CREATE INDEX bookings_customer_idx ON bookings (customer_id, created_at DESC);
CREATE INDEX bookings_show_idx     ON bookings (show_id);
CREATE INDEX bookings_status_idx   ON bookings (status);

CREATE TABLE booking_seats (
  id            SERIAL PRIMARY KEY,
  booking_id    INTEGER        NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  show_seat_id  INTEGER        NOT NULL REFERENCES show_seats (id) ON DELETE RESTRICT,
  -- Price paid for this specific seat, captured at booking time.
  price         NUMERIC(10, 2) NOT NULL CHECK (price >= 0),

  -- A given seat can appear at most once within a booking.
  CONSTRAINT booking_seats_unique_seat UNIQUE (booking_id, show_seat_id)
);

CREATE INDEX booking_seats_booking_idx ON booking_seats (booking_id);
CREATE INDEX booking_seats_seat_idx    ON booking_seats (show_seat_id);

-- A seat may be booked, cancelled, then re-booked by someone else, so
-- (show_seat_id) cannot be globally unique. What must hold is that a seat is
-- part of at most one *confirmed* booking at a time. A plain UNIQUE constraint
-- can't express "only when the parent booking is confirmed", so this is enforced
-- transactionally by the booking path holding a FOR UPDATE lock on the seat row
-- and requiring status='held' by the caller. The index below supports the audit
-- query that verifies the invariant.
CREATE INDEX booking_seats_confirmed_lookup_idx ON booking_seats (show_seat_id, booking_id);

-- ---------------------------------------------------------------------------
-- waitlist
-- ---------------------------------------------------------------------------

CREATE TABLE waitlist (
  id                  SERIAL PRIMARY KEY,
  show_id             INTEGER         NOT NULL REFERENCES shows (id) ON DELETE CASCADE,
  category            TEXT            NOT NULL CHECK (length(btrim(category)) > 0),
  customer_id         INTEGER         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status              waitlist_status NOT NULL DEFAULT 'waiting',
  joined_at           TIMESTAMPTZ     NOT NULL DEFAULT now(),
  offer_expires_at    TIMESTAMPTZ,
  -- Random single-use token backing the emailed "complete your booking" link.
  -- Cleared when the offer is consumed or expires, which is what makes the link
  -- single-use rather than merely time-limited.
  offer_token         TEXT UNIQUE,
  -- Which seat was offered, so an accepted offer knows what to book and an
  -- expired offer knows what to cascade.
  offered_show_seat_id INTEGER        REFERENCES show_seats (id) ON DELETE SET NULL,

  CONSTRAINT waitlist_offer_fields_consistent CHECK (
    (status = 'offered' AND offer_expires_at IS NOT NULL AND offer_token IS NOT NULL)
    OR
    (status <> 'offered' AND offer_token IS NULL)
  )
);

-- The FIFO lookup the waitlist runs on every seat release:
--   WHERE show_id = $1 AND category = $2 AND status = 'waiting'
--   ORDER BY joined_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
-- Column order matches the predicate then the sort, so Postgres satisfies the
-- whole thing from the index without a sort step.
CREATE INDEX waitlist_fifo_idx ON waitlist (show_id, category, status, joined_at);

CREATE INDEX waitlist_customer_idx ON waitlist (customer_id);

-- Supports the sweeper's expired-offer scan.
CREATE INDEX waitlist_offer_expiry_idx ON waitlist (status, offer_expires_at);

-- One active queue entry per customer per (show, category). A customer who has
-- already been served ('fulfilled') or timed out ('expired') may join again, so
-- the uniqueness only covers the two active states.
CREATE UNIQUE INDEX waitlist_one_active_per_customer_idx
  ON waitlist (show_id, category, customer_id)
  WHERE status IN ('waiting', 'offered');
