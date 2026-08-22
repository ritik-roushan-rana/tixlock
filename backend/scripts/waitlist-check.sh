#!/usr/bin/env bash
#
# Manual end-to-end verification of the waitlist loop against a running server.
#
# Walks the exact scenario from the brief:
#   sell out a category -> Alice and Bob join the waitlist -> cancel a booking
#   -> seat is OFFERED to Alice (not released) -> Alice's offer expires
#   -> seat CASCADES to Bob (still not released) -> Bob's offer expires
#   -> queue is empty, so the seat finally returns to general sale
#
# Offer expiry is forced by moving the deadline into the past in the database, then
# waiting for the real cron sweep to notice — so this exercises the scheduled job
# rather than calling the sweep function directly.
#
# Usage:
#   npm start   (in another terminal)
#   ./scripts/waitlist-check.sh
#
# Requires psql on PATH and DATABASE_URL (or the local default) reachable.

set -uo pipefail

BASE="${BASE_URL:-http://localhost:3000}"
PSQL_BIN="${PSQL:-psql}"
DB="${DATABASE_URL:-postgresql://localhost:5432/ticket_booking}"

PASS=0
FAIL=0

command -v curl >/dev/null || { echo "curl is required"; exit 1; }
command -v node >/dev/null || { echo "node is required"; exit 1; }
command -v "${PSQL_BIN}" >/dev/null || {
  echo "psql is required (set PSQL=/path/to/psql if it is not on PATH)"; exit 1;
}

pluck() {
  node -e "
    let raw='';
    process.stdin.on('data', c => raw += c).on('end', () => {
      try { const d = JSON.parse(raw); const out = ($1); process.stdout.write(out == null ? '' : String(out)); }
      catch { process.stdout.write(''); }
    });
  "
}

sql() { "${PSQL_BIN}" "${DB}" -X -A -t -c "$1" 2>/dev/null | tr -d '[:space:]'; }

check() {
  local label="$1" actual="$2" expected="$3"
  if [ "${actual}" = "${expected}" ]; then
    PASS=$((PASS + 1)); printf "  ok    %-54s %s\n" "${label}" "${actual}"
  else
    FAIL=$((FAIL + 1)); printf "  FAIL  %-54s got '%s' want '%s'\n" "${label}" "${actual}" "${expected}"
  fi
}

call() {
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local args=(-s -w '\n%{http_code}' -X "${method}" "${BASE}${path}")
  [ -n "${token}" ] && args+=(-H "Authorization: Bearer ${token}")
  [ -n "${body}" ] && args+=(-H 'Content-Type: application/json' -d "${body}")
  local raw code payload
  raw=$(curl "${args[@]}")
  code=$(printf '%s' "${raw}" | tail -n1)
  payload=$(printf '%s' "${raw}" | sed '$d')
  printf '%s\t%s' "${code}" "${payload}"
}
status_of() { printf '%s' "${1:-}" | cut -f1; }
body_of()   { printf '%s' "${1:-}" | cut -f2-; }

login_or_register() {
  local email="$1" name="$2" r t
  r=$(call POST /api/auth/register "" "{\"name\":\"${name}\",\"email\":\"${email}\",\"password\":\"waitcheck123\"}")
  t=$(body_of "$r" | pluck 'd.token')
  if [ -z "${t}" ]; then
    r=$(call POST /api/auth/login "" "{\"email\":\"${email}\",\"password\":\"waitcheck123\"}")
    t=$(body_of "$r" | pluck 'd.token')
  fi
  printf '%s' "${t}"
}

# Force every live offer past its deadline, then wait for the real cron tick.
expire_offers_and_wait() {
  local who="$1"
  sql "UPDATE show_seats SET hold_expires_at = now() - interval '2 seconds' WHERE status = 'offered';" >/dev/null
  sql "UPDATE waitlist SET offer_expires_at = now() - interval '2 seconds' WHERE status = 'offered';" >/dev/null
  printf "  ... expired %s's offer, waiting for the 15s cron sweep" "${who}"
  for _ in $(seq 1 25); do
    printf "."
    sleep 1
    local stale
    stale=$(sql "SELECT count(*) FROM show_seats WHERE status='offered' AND hold_expires_at < now();")
    [ "${stale}" = "0" ] && { printf " swept\n"; return 0; }
  done
  printf " TIMED OUT\n"
  return 1
}

echo "=== Waitlist loop check: ${BASE} ==="
echo "DB: ${DB}"
echo ""

# --- Setup ------------------------------------------------------------------
echo "Setup"
R=$(call POST /api/auth/login "" '{"email":"admin@ticketbooking.local","password":"admin12345"}')
ADMIN=$(body_of "$R" | pluck 'd.token')
[ -z "${ADMIN}" ] && { echo "  cannot log in as admin — run 'npm run seed' first"; exit 1; }

R=$(call POST /api/auth/login "" '{"email":"organiser@ticketbooking.local","password":"organiser123"}')
ORG=$(body_of "$R" | pluck 'd.token')

STAMP=$(date +%s)
OWNER=$(login_or_register "wl-owner-${STAMP}@test.local" "WL Owner")
ALICE=$(login_or_register "wl-alice-${STAMP}@test.local" "WL Alice")
BOB=$(login_or_register "wl-bob-${STAMP}@test.local" "WL Bob")
check_not_empty_tokens=$([ -n "${OWNER}" ] && [ -n "${ALICE}" ] && [ -n "${BOB}" ] && echo yes || echo no)
check "three customer accounts ready" "${check_not_empty_tokens}" "yes"

# A venue with a single Premium seat makes the cascade unambiguous: exactly one
# seat is in play, so there is no chance a second seat masks a wrong decision.
R=$(call POST /api/venues "${ADMIN}" "{\"name\":\"Waitlist Hall ${STAMP}\",\"address\":\"1 Queue Lane\",\"layout\":[{\"row_label\":\"A\",\"seats\":1,\"category\":\"Premium\"},{\"row_label\":\"B\",\"seats\":2,\"category\":\"Standard\"}]}")
check "create venue (1 Premium, 2 Standard)" "$(status_of "$R")" "201"
VENUE=$(body_of "$R" | pluck 'd.venue.id')

R=$(call POST /api/events "${ORG}" "{\"title\":\"Waitlist Test Show ${STAMP}\",\"type\":\"concert\",\"venue_id\":${VENUE}}")
EVENT=$(body_of "$R" | pluck 'd.event.id')
R=$(call POST "/api/events/${EVENT}/shows" "${ORG}" '{"date":"2027-02-14","time":"20:00","pricing":{"Premium":1500,"Standard":600}}')
check "create show" "$(status_of "$R")" "201"
SHOW=$(body_of "$R" | pluck 'd.show.id')

R=$(call GET "/api/shows/${SHOW}/seats")
SEAT=$(body_of "$R" | pluck "(d.rows.flatMap(r=>r.seats).find(s=>s.category==='Premium')||{}).id")
check_not_empty_seat=$([ -n "${SEAT}" ] && echo yes || echo no)
check "found the Premium seat" "${check_not_empty_seat}" "yes"
echo ""

# --- Sell out Premium -------------------------------------------------------
echo "1. Owner books the only Premium seat"
R=$(call POST "/api/shows/${SHOW}/hold" "${OWNER}" "{\"seat_ids\":[${SEAT}]}")
check "hold the seat" "$(status_of "$R")" "201"
R=$(call POST /api/bookings "${OWNER}" "{\"show_id\":${SHOW},\"seat_ids\":[${SEAT}]}")
check "book the seat" "$(status_of "$R")" "201"
BOOKING=$(body_of "$R" | pluck 'd.booking.id')

R=$(call GET "/api/shows/${SHOW}/availability")
check "Premium is sold out" "$(body_of "$R" | pluck "(d.categories.find(c=>c.category==='Premium')||{}).sold_out")" "true"
echo ""

# --- Queue up ---------------------------------------------------------------
echo "2. Alice then Bob join the Premium waitlist"
R=$(call POST /api/waitlist "${ALICE}" "{\"show_id\":${SHOW},\"category\":\"Premium\"}")
check "Alice joins" "$(status_of "$R")" "201"
check "Alice is position 1" "$(body_of "$R" | pluck 'd.waitlist.position')" "1"

R=$(call POST /api/waitlist "${BOB}" "{\"show_id\":${SHOW},\"category\":\"Premium\"}")
check "Bob joins" "$(status_of "$R")" "201"
check "Bob is position 2" "$(body_of "$R" | pluck 'd.waitlist.position')" "2"

R=$(call POST /api/waitlist "${ALICE}" "{\"show_id\":${SHOW},\"category\":\"Premium\"}")
check "Alice cannot join twice" "$(status_of "$R")" "409"
echo ""

# --- Cancel -> offer to Alice ----------------------------------------------
echo "3. Owner cancels — the seat must be OFFERED to Alice, not released"
R=$(call POST "/api/bookings/${BOOKING}/cancel" "${OWNER}")
check "cancel succeeds" "$(status_of "$R")" "200"
check "offered to waitlist" "$(body_of "$R" | pluck 'd.seats_offered_to_waitlist')" "1"
check "released to general sale" "$(body_of "$R" | pluck 'd.seats_released')" "0"

check "seat status is 'offered'" "$(sql "SELECT status FROM show_seats WHERE id=${SEAT};")" "offered"
ALICE_ID=$(sql "SELECT customer_id FROM waitlist WHERE show_id=${SHOW} AND status='offered';")
check "reserved for Alice" "$(sql "SELECT held_by FROM show_seats WHERE id=${SEAT};")" "${ALICE_ID}"
check "Alice's entry is 'offered'" "$(sql "SELECT status FROM waitlist WHERE customer_id=${ALICE_ID};")" "offered"
check "Alice got a single-use token" "$(sql "SELECT CASE WHEN offer_token IS NULL THEN 'none' ELSE 'yes' END FROM waitlist WHERE customer_id=${ALICE_ID};")" "yes"

# The seat must not be grabbable by anyone else while reserved.
R=$(call POST "/api/shows/${SHOW}/hold" "${BOB}" "{\"seat_ids\":[${SEAT}]}")
check "Bob cannot hold Alice's reserved seat" "$(status_of "$R")" "409"
echo ""

# --- Alice lets it lapse -> cascade to Bob ---------------------------------
echo "4. Alice does nothing — the seat must CASCADE to Bob, not be released"
expire_offers_and_wait "Alice"

check "seat is still 'offered' (not available)" "$(sql "SELECT status FROM show_seats WHERE id=${SEAT};")" "offered"
BOB_ID=$(sql "SELECT customer_id FROM waitlist WHERE show_id=${SHOW} AND status='offered';")
check "now reserved for Bob" "$(sql "SELECT held_by FROM show_seats WHERE id=${SEAT};")" "${BOB_ID}"
check "Bob is not Alice" "$([ "${BOB_ID}" != "${ALICE_ID}" ] && echo yes || echo no)" "yes"
check "Alice's entry is 'expired'" "$(sql "SELECT status FROM waitlist WHERE customer_id=${ALICE_ID};")" "expired"
check "Alice's token was cleared" "$(sql "SELECT CASE WHEN offer_token IS NULL THEN 'cleared' ELSE 'still set' END FROM waitlist WHERE customer_id=${ALICE_ID};")" "cleared"
echo ""

# --- Bob lets it lapse -> queue empty -> released --------------------------
echo "5. Bob does nothing either — queue is now empty, so the seat is released"
expire_offers_and_wait "Bob"

check "seat is finally 'available'" "$(sql "SELECT status FROM show_seats WHERE id=${SEAT};")" "available"
check "held_by cleared" "$(sql "SELECT CASE WHEN held_by IS NULL THEN 'null' ELSE 'set' END FROM show_seats WHERE id=${SEAT};")" "null"
check "hold_expires_at cleared" "$(sql "SELECT CASE WHEN hold_expires_at IS NULL THEN 'null' ELSE 'set' END FROM show_seats WHERE id=${SEAT};")" "null"
check "both entries expired" "$(sql "SELECT count(*) FROM waitlist WHERE show_id=${SHOW} AND status='expired';")" "2"
check "no entries left waiting" "$(sql "SELECT count(*) FROM waitlist WHERE show_id=${SHOW} AND status='waiting';")" "0"
echo ""

# --- The seat is genuinely back on sale ------------------------------------
echo "6. The released seat is bookable again by anyone"
R=$(call POST "/api/shows/${SHOW}/hold" "${BOB}" "{\"seat_ids\":[${SEAT}]}")
check "Bob can now hold it normally" "$(status_of "$R")" "201"
echo ""

# --- Offer acceptance path -------------------------------------------------
echo "7. Offer acceptance is single use"
R=$(call POST /api/bookings "${BOB}" "{\"show_id\":${SHOW},\"seat_ids\":[${SEAT}]}")
BOOKING2=$(body_of "$R" | pluck 'd.booking.id')
check "Bob books the seat" "$(status_of "$R")" "201"

R=$(call POST /api/waitlist "${ALICE}" "{\"show_id\":${SHOW},\"category\":\"Premium\"}")
check "Alice re-joins the waitlist" "$(status_of "$R")" "201"

R=$(call POST "/api/bookings/${BOOKING2}/cancel" "${BOB}")
check "Bob cancels, offering to Alice" "$(body_of "$R" | pluck 'd.seats_offered_to_waitlist')" "1"

TOKEN=$(sql "SELECT offer_token FROM waitlist WHERE show_id=${SHOW} AND status='offered';")
R=$(call GET "/api/waitlist/offers/${TOKEN}")
check "offer link renders without consuming" "$(status_of "$R")" "200"
check "offer still valid" "$(body_of "$R" | pluck 'd.offer.still_valid')" "true"

R=$(call POST "/api/waitlist/offers/${TOKEN}/accept" "${BOB}")
check "wrong customer cannot claim" "$(status_of "$R")" "409"

R=$(call POST "/api/waitlist/offers/${TOKEN}/accept" "${ALICE}")
check "Alice claims the offer" "$(status_of "$R")" "200"
check "seat becomes a normal hold" "$(sql "SELECT status FROM show_seats WHERE id=${SEAT};")" "held"

R=$(call POST "/api/waitlist/offers/${TOKEN}/accept" "${ALICE}")
check "token is single use" "$(status_of "$R")" "409"

R=$(call POST /api/bookings "${ALICE}" "{\"show_id\":${SHOW},\"seat_ids\":[${SEAT}]}")
check "Alice completes the booking" "$(status_of "$R")" "201"
check "Alice's entry is 'fulfilled'" "$(sql "SELECT status FROM waitlist WHERE show_id=${SHOW} AND customer_id=${ALICE_ID} ORDER BY joined_at DESC LIMIT 1;")" "fulfilled"
echo ""

echo "=========================================="
printf "  passed: %s\n" "${PASS}"
printf "  failed: %s\n" "${FAIL}"
echo "=========================================="
[ "${FAIL}" -eq 0 ] && { echo "WAITLIST LOOP PASSED"; exit 0; }
echo "WAITLIST LOOP FAILED"
exit 1
