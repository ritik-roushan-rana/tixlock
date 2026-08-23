# TixLock — demo walkthrough

Everything below is already in the database. The sections are independent; each takes a
minute or two.

**App:** https://tixlock-seven.vercel.app · **API:** https://tixlock-api-production.up.railway.app/api/health

Rebuild the dataset at any point. It is destructive and reproducible:

```bash
cd backend && npm run demo
```

---

## Logins

The sign-in screen has one-click buttons for the first four.

| Role | Email | Password | Why this account |
|---|---|---|---|
| Admin | `admin@ticketbooking.local` | `admin12345` | Owns venues and seat layouts |
| Organiser | `organiser@ticketbooking.local` | `organiser123` | Films at Cineplex Andheri |
| Organiser | `promoter@ticketbooking.local` | `organiser123` | Concerts at BKC and the Opera House |
| Customer | `customer@ticketbooking.local` | `customer123` | Booking history including a cancellation |
| Customer | `customer2@ticketbooking.local` | `customer123` | A live checkout hold, and a **fulfilled** waitlist offer |
| Customer | `rohan@ticketbooking.local` | `customer123` | Holds 4 seats in a **sold-out** tier — cancel these |
| Customer | `zoya@ticketbooking.local` | `customer123` | Holds a **live, time-limited** seat offer |
| Customer | `meera@` `ananya@` `vikram@` `dev@` | `customer123` | Fill out queues and booking lists |

Two organisers exist on purpose: each dashboard shows only its own events and revenue.

## What is loaded

| | |
|---|---|
| Venues | 3 — a multiplex screen, an outdoor arena, a 24-seat room |
| Seat layouts | 168 physical seats across 7 categories |
| Events | 7 — 4 movies, 3 concerts, one an unscheduled draft |
| Showings | 12, including one in the past so revenue has history |
| Bookings | 29 confirmed, 2 cancelled, every one with a QR reference |
| Waitlist | 3 waiting, 1 live offer, 1 fulfilled |

Dates are generated relative to the day you rebuild, so nothing goes stale.

---

## 1. Seat map and live status

Sign in as **customer@**, open any event, pick a showing.

The grid is the real per-seat state, not a rendering of counts: available, held by
someone else, booked, and offered to a waitlisted customer are four distinct statuses on
`show_seats`. Open **Interstellar → the 22:00 showing** to see A1–A2 sitting in `held` —
that is customer2 mid-checkout, and you cannot select them.

Open the same showing in a second window and hold a seat in one. It greys out in the
other within a moment, with no reload: that is a Socket.io broadcast, emitted only after
the transaction commits.

## 2. Hold TTL and auto-release

Select two seats and press **Hold**. A countdown starts from the server's deadline rather
than the browser's clock — reload the page and it resumes correctly.

Now abandon it. Come back after the TTL (`HOLD_TTL_MINUTES`, default 10) or watch the
second window: the seats free themselves. A sweeper runs every 15 seconds, but expiry
does not depend on it — every read and every booking attempt treats a lapsed deadline as
free, so a seat is never briefly sellable to nobody.

## 3. Concurrency

Two customers cannot hold or book the same seat. To watch it rather than take it on
trust, from `backend/`:

```bash
./scripts/race-check.sh        # fires simultaneous holds at one seat
```

Exactly one request wins; the rest get `409` naming the seats already taken. The same
property is asserted in `tests/concurrency.test.js`.

## 4. Booking, QR and email

Confirm a held booking. The response carries a reference like `TB-4KQ7WPXR` and a QR code
encoding it. Both appear immediately and again under **My bookings**.

On email: every seeded account uses a `.local` address, which the mailer refuses to hand
to the provider, because reserved domains only ever bounce. **To receive a real email,
register a new account with your own address** and book with it. The confirmation arrives
with the QR inline and attached.

## 5. Waitlist auto-assignment

**Arijit Singh — Alvida World Tour**, first night. Golden Circle is 12/12 booked and three
customers are queued for it (zoya, ananya, vikram, in that order). Anonymously, the tier
shows sold out with a **Join waitlist** action.

Trigger the reassignment yourself:

1. Sign in as **rohan@ticketbooking.local**
2. **My bookings** → cancel the Arijit Singh booking (4 Golden Circle seats)
3. Sign in as **zoya@** → **My bookings → Waitlist**: she has been offered a seat

The seat was never on general sale in between. Cancellation hands each released seat
straight to the head of the FIFO queue inside the same transaction that cancels the
booking, so a passer-by cannot take a seat someone has been waiting for.

Four seats released to three people gives three offers and one seat back on general sale,
because by the fourth the queue is empty. Both organiser and customer views reflect that.

## 6. Time-limited offers

Sign in as **zoya@** → **My bookings → Waitlist**. She already holds an open offer for a
Premium seat at the Opera House, with a deadline (`OFFER_TTL_MINUTES`, default 30).
Follow it to the offer page and complete the booking to see the whole loop close.

The link is single-use and non-transferable: the token is cleared in the same transaction
that redeems it, and it only works for the customer it was issued to.

When an offer lapses the seat cascades to the next person in the queue rather than
quietly returning to sale. That specific case is the one thing in the system that
genuinely needs the scheduler, since no incoming request would ever notice.

**customer2@** shows the finished article: a `fulfilled` queue entry with a real ticket
behind it, from a seat she was offered after someone else cancelled.

## 7. Organiser view

Sign in as **promoter@** for revenue, seats sold and occupancy per event, broken down by
showing and by seat category, plus waitlist depth. Revenue uses the price actually paid at
booking time, so a later price change does not rewrite history.

Compare with **organiser@**: different events, different figures. Their list also carries
**Dune: Part Three**, a listing with no showings — flagged, with an inline **Add showing**
action, and correctly absent from the public browse because nobody can book it.

## 8. Admin view

Sign in as **admin@** for the three venues and their layouts in the grid editor. A layout
locks once showings exist, because sold seats carry the category they were sold under and
there is no honest way to rewrite that after the fact.

---

## Two states have a shelf life

The dataset is static apart from the two things that are meant to move:

- the **live hold** on Interstellar's 22:00 showing expires 10 minutes after a rebuild
- **zoya's** waitlist offer expires 30 minutes after a rebuild

Both then do exactly what they should: the hold releases, the offer cascades to the next
in the queue. Re-run `npm run demo` for a fresh window, or place your own hold — which
demonstrates the mechanism better anyway.
