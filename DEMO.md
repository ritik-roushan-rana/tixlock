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

The sign-in screen has one-click buttons for all four.

| Role | Email | Password | What this account is holding |
|---|---|---|---|
| Admin | `admin@tixlock.com` | `Admin123` | The three venues and their seat layouts |
| Organiser | `organiser@tixlock.com` | `Organiser123` | All five listings — revenue, occupancy, attendees |
| Customer | `customer1@tixlock.com` | `Customer123` | Booking history, a cancellation, a **live seat offer**, and a place in the sold-out queue |
| Customer | `customer2@tixlock.com` | `Customer123` | A **checkout hold in progress**, and a waitlist offer already redeemed |

Six further customers exist to fill the waitlist queues and the organiser's attendee
lists. They are fixtures rather than logins, so they sit on a reserved `.local` domain
where no email can ever be delivered to them.

## What is loaded

| | |
|---|---|
| Venues | 3 — a multiplex screen (68 seats), an arena (76), a 24-seat room |
| Categories | Premium, Gold, Standard at every venue |
| Events | 5 — 3 movies, 2 concerts |
| Showings | 11 across different dates and times, including one in the past |
| Bookings | 36 confirmed, 2 cancelled, every one with a QR reference |
| Revenue | ₹4,58,870 booked, reported per event, showing and category |
| Waitlist | 6 waiting, 1 live offer, 1 fulfilled |

| Event | Venue | Showings | State |
|---|---|---|---|
| Interstellar Re-Release | PVR Icon | 4 | Partly booked, one past showing, one **live hold** |
| Avengers Marathon | PVR Icon | 2 | Partly booked |
| Dune: Part Three | PVR Icon | 2 | Partly booked, first showing at matinee prices |
| Coldplay World Tour | Jio World Garden | 2 | Premium tier **sold out** with a live offer against it |
| Arijit Singh Live | Royal Opera House | 1 | **Completely sold out** — 24/24, six customers queued |

Dates are generated relative to the day you rebuild, so nothing goes stale.

---

## 1. Seat map and live status

Sign in as **customer1@**, open any event, pick a showing.

The grid is the real per-seat state, not a rendering of counts: available, held by someone
else, booked, and offered to a waitlisted customer are four distinct statuses on
`show_seats`. Open **Interstellar Re-Release → the 22:00 showing** to see Premium A1–A2
sitting in `held` — that is customer2 mid-checkout, and you cannot select them.

Open the same showing in a second window and hold a seat in one. It greys out in the other
within a moment and without a reload: that is a Socket.io broadcast, emitted only after the
transaction commits.

## 2. Hold TTL and auto-release

Select two seats and press **Hold**. A countdown starts from the server's deadline rather
than the browser's clock — reload the page and it resumes correctly.

Now abandon it. Come back after the TTL (`HOLD_TTL_MINUTES`, default 10), or watch the
second window: the seats free themselves. A sweeper runs every 15 seconds, but expiry does
not depend on it — every read and every booking attempt treats a lapsed deadline as free,
so a seat is never briefly sellable to nobody.

## 3. Concurrency

Two customers cannot hold or book the same seat. To watch it rather than take it on trust,
from `backend/`:

```bash
./scripts/race-check.sh        # fires simultaneous holds at one seat
```

Exactly one request wins; the rest get `409` naming the seats already taken. The same
property is asserted in `tests/concurrency.test.js`.

## 4. Booking, QR and email

Confirm a held booking. The response carries a reference like `TB-4KQ7WPXR` and a QR code
encoding it. Both appear immediately and again under **My bookings**.

On email: no mailbox exists behind any `@tixlock.com` fixture, so the mailer deliberately
suppresses delivery to them rather than collecting guaranteed bounces. **To see a real
email, register a new account with your own address** and book with it — the confirmation
arrives with the QR inline and attached.

## 5. A completely sold-out event, and automatic reassignment

**Arijit Singh Live** — one showing, 24 seats, every one gone. Premium, Gold and Standard
all read zero, and six customers are queued across the three categories. Anonymously, each
tier shows sold out with a **Join waitlist** action.

Trigger the reassignment yourself:

1. Sign in as **customer1@tixlock.com**
2. **My bookings** → cancel the Arijit Singh Live booking (2 Standard seats)
3. Sign in as **organiser@** → the event's waitlist count moves from 6 waiting to 4
   waiting and 2 offered

Both seats go to the two customers who were queued for Standard, in the order they joined.
Neither was ever on general sale in between: cancellation hands each released seat straight
to the head of the FIFO queue inside the same transaction that cancels the booking, so a
passer-by cannot take a seat someone has been waiting for. The event also stays sold out
throughout, because a released seat becomes `offered`, never `available`.

Cancel a booking in a category with an *empty* queue and the opposite happens — the seat
returns to general sale. customer1's cancelled Dune booking is that case.

## 6. Time-limited offers

Sign in as **customer1@** → **My bookings → Waitlist**. Alongside the queue entry, there is
an open offer for a Premium seat at Coldplay, with a deadline (`OFFER_TTL_MINUTES`, default
30). Follow it to the offer page and complete the booking to close the loop.

The link is single-use and non-transferable: the token is cleared in the same transaction
that redeems it, and it only works for the customer it was issued to.

When an offer lapses, the seat cascades to the next person in the queue rather than quietly
returning to sale. That specific case is the one thing in the system that genuinely needs
the scheduler, since no incoming request would ever notice.

**customer2@** shows the finished article: a `fulfilled` queue entry with a real ticket
behind it, from a seat she was offered after someone else cancelled.

## 7. Organiser view

Sign in as **organiser@** for revenue, seats sold and occupancy per event, broken down by
showing and by seat category, plus waitlist depth and a full attendee list. Revenue uses the
price actually paid at booking time, so a later price change does not rewrite history —
Dune's matinee seats stay at matinee rates.

## 8. Admin view

Sign in as **admin@** for the three venues and their layouts in the grid editor. A layout
locks once showings exist, because sold seats carry the category they were sold under and
there is no honest way to rewrite that after the fact.

---

## Two states have a shelf life

The dataset is static apart from the two things that are meant to move:

- the **live hold** on Interstellar's 22:00 showing expires 10 minutes after a rebuild
- **customer1's** waitlist offer expires 30 minutes after a rebuild

Both then do exactly what they should: the hold releases, the offer cascades to the next
person in the queue. Re-run `npm run demo` for a fresh window, or place your own hold —
which demonstrates the mechanism better anyway.
