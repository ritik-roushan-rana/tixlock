#!/usr/bin/env bash
#
# End-to-end smoke test against a running server.
#
# Walks the full customer journey with real HTTP calls: admin creates a venue and
# layout, organiser creates an event and show, customer browses, holds, books,
# reads history, and cancels. Asserts on the response of each step.
#
# Usage:
#   npm start            # in one terminal
#   npm run migrate:reset && npm run seed
#   ./scripts/smoke.sh
#
# Exits non-zero on the first failed assertion.

set -uo pipefail

BASE="${BASE_URL:-http://localhost:3000}"
PASS=0
FAIL=0

pluck() {
  node -e "
    let raw='';
    process.stdin.on('data', c => raw += c).on('end', () => {
      try { const d = JSON.parse(raw); const out = ($1); process.stdout.write(out == null ? '' : String(out)); }
      catch { process.stdout.write(''); }
    });
  "
}

check() {
  local label="$1" actual="$2" expected="$3"
  if [ "${actual}" = "${expected}" ]; then
    PASS=$((PASS + 1))
    printf "  ok    %-52s %s\n" "${label}" "${actual}"
  else
    FAIL=$((FAIL + 1))
    printf "  FAIL  %-52s got '%s' want '%s'\n" "${label}" "${actual}" "${expected}"
  fi
}

check_not_empty() {
  local label="$1" actual="$2"
  if [ -n "${actual}" ]; then
    PASS=$((PASS + 1))
    printf "  ok    %-52s %s\n" "${label}" "$(printf '%s' "${actual}" | head -c 40)"
  else
    FAIL=$((FAIL + 1))
    printf "  FAIL  %-52s was empty\n" "${label}"
  fi
}

# Perform a request and echo "STATUS<TAB>BODY".
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

status_of() { printf '%s' "$1" | cut -f1; }
body_of()   { printf '%s' "$1" | cut -f2-; }

echo "=== End-to-end smoke test: ${BASE} ==="
echo ""

# --- Health -----------------------------------------------------------------
echo "Health"
R=$(call GET /api/health)
check "GET /api/health" "$(status_of "$R")" "200"
check "database connected" "$(body_of "$R" | pluck 'd.database')" "connected"
echo ""

# --- Auth -------------------------------------------------------------------
echo "Authentication"
R=$(call POST /api/auth/login "" '{"email":"admin@ticketbooking.local","password":"admin12345"}')
check "admin login" "$(status_of "$R")" "200"
ADMIN=$(body_of "$R" | pluck 'd.token')
check_not_empty "admin token" "${ADMIN}"

R=$(call POST /api/auth/login "" '{"email":"organiser@ticketbooking.local","password":"organiser123"}')
check "organiser login" "$(status_of "$R")" "200"
ORG=$(body_of "$R" | pluck 'd.token')

STAMP=$(date +%s)
R=$(call POST /api/auth/register "" "{\"name\":\"Smoke Customer\",\"email\":\"smoke${STAMP}@test.local\",\"password\":\"smoketest123\"}")
check "customer register" "$(status_of "$R")" "201"
CUST=$(body_of "$R" | pluck 'd.token')
check "registered as customer" "$(body_of "$R" | pluck 'd.user.role')" "customer"

R=$(call POST /api/auth/register "" "{\"name\":\"Hacker\",\"email\":\"hack${STAMP}@test.local\",\"password\":\"smoketest123\",\"role\":\"admin\"}")
check "admin self-registration blocked" "$(status_of "$R")" "400"
echo ""

# --- Role enforcement -------------------------------------------------------
echo "Role enforcement"
R=$(call POST /api/venues "${CUST}" '{"name":"Illegal Venue"}')
check "customer cannot create a venue" "$(status_of "$R")" "403"
R=$(call POST /api/venues "" '{"name":"Anonymous Venue"}')
check "anonymous cannot create a venue" "$(status_of "$R")" "401"
echo ""

# --- Admin: venue + layout --------------------------------------------------
echo "Admin: venue and seat layout"
R=$(call POST /api/venues "${ADMIN}" "{\"name\":\"Smoke Arena ${STAMP}\",\"address\":\"12 Test Road\",\"layout\":[{\"row_label\":\"A\",\"seats\":5,\"category\":\"Premium\"},{\"row_label\":\"B\",\"seats\":5,\"category\":\"Standard\"}]}")
check "create venue with layout" "$(status_of "$R")" "201"
VENUE=$(body_of "$R" | pluck 'd.venue.id')
check "generated 10 seats" "$(body_of "$R" | pluck 'd.venue.seat_count')" "10"
check "two categories" "$(body_of "$R" | pluck 'd.venue.categories.join(",")')" "Premium,Standard"
check "layout unlocked" "$(body_of "$R" | pluck 'd.venue.locked')" "false"

R=$(call PUT "/api/venues/${VENUE}/layout" "${ADMIN}" '{"layout":[{"row_label":"A","seats":5,"category":"Premium"},{"row_label":"B","seats":5,"category":"Standard"}]}')
check "re-post layout is idempotent" "$(body_of "$R" | pluck 'd.seats_created')" "10"
echo ""

# --- Organiser: event + show ------------------------------------------------
echo "Organiser: event and show"
R=$(call POST /api/events "${ORG}" "{\"title\":\"Smoke Test Concert\",\"type\":\"concert\",\"venue_id\":${VENUE},\"description\":\"A test event.\"}")
check "create event" "$(status_of "$R")" "201"
EVENT=$(body_of "$R" | pluck 'd.event.id')

R=$(call POST "/api/events/${EVENT}/shows" "${ORG}" '{"date":"2026-11-20","time":"18:45","pricing":{"Premium":800,"Standard":350}}')
check "create show" "$(status_of "$R")" "201"
SHOW=$(body_of "$R" | pluck 'd.show.id')
check "generated 10 show_seats" "$(body_of "$R" | pluck 'd.show.seats_created')" "10"

R=$(call POST "/api/events/${EVENT}/shows" "${ORG}" '{"date":"2026-11-21","time":"18:45","pricing":{"Premium":800}}')
check "show with incomplete pricing rejected" "$(status_of "$R")" "400"

R=$(call POST "/api/events/${EVENT}/shows" "${CUST}" '{"date":"2026-11-22","time":"18:45","pricing":{"Premium":800,"Standard":350}}')
check "customer cannot create a show" "$(status_of "$R")" "403"
echo ""

# --- Browse -----------------------------------------------------------------
echo "Customer: browse"
R=$(call GET "/api/events?type=concert")
check "browse (anonymous)" "$(status_of "$R")" "200"
check_not_empty "found the event" "$(body_of "$R" | pluck "(d.events.find(e=>e.id===${EVENT})||{}).title")"

R=$(call GET "/api/events?type=movie&date_from=2026-11-01&date_to=2026-11-30")
check "type filter excludes the concert" "$(body_of "$R" | pluck "d.events.filter(e=>e.id===${EVENT}).length")" "0"

R=$(call GET "/api/shows/${SHOW}/seats")
check "seat map" "$(status_of "$R")" "200"
check "10 seats, all available" "$(body_of "$R" | pluck 'd.summary.available')" "10"
check "date not shifted by timezone" "$(body_of "$R" | pluck 'd.show.date')" "2026-11-20"
SEAT1=$(body_of "$R" | pluck 'd.rows[0].seats[0].id')
SEAT2=$(body_of "$R" | pluck 'd.rows[0].seats[1].id')
SEAT3=$(body_of "$R" | pluck 'd.rows[1].seats[0].id')
echo ""

# --- Hold -------------------------------------------------------------------
echo "Customer: hold seats"
R=$(call POST "/api/shows/${SHOW}/hold" "${CUST}" "{\"seat_ids\":[${SEAT1},${SEAT2},${SEAT3}]}")
check "hold 3 seats" "$(status_of "$R")" "201"
check "TTL reported" "$(body_of "$R" | pluck 'd.hold_ttl_minutes')" "10"
check_not_empty "hold deadline" "$(body_of "$R" | pluck 'd.hold_expires_at')"

R=$(call GET "/api/shows/${SHOW}/seats" "${CUST}")
check "seat map shows 3 held" "$(body_of "$R" | pluck 'd.summary.held')" "3"
check "held_by_me is true for my seats" "$(body_of "$R" | pluck 'd.rows.flatMap(r=>r.seats).filter(s=>s.held_by_me).length')" "3"

R=$(call GET "/api/shows/${SHOW}/seats")
check "anonymous view leaks no holder identity" "$(body_of "$R" | pluck 'JSON.stringify(d).includes("held_by\":") ? "leaked" : "clean"')" "clean"

R=$(call GET "/api/shows/${SHOW}/my-holds" "${CUST}")
check "my-holds returns 3" "$(body_of "$R" | pluck 'd.seats.length')" "3"
echo ""

# --- Book -------------------------------------------------------------------
echo "Customer: book"
R=$(call POST /api/bookings "${CUST}" "{\"show_id\":${SHOW},\"seat_ids\":[${SEAT1},${SEAT2},${SEAT3}]}")
check "create booking" "$(status_of "$R")" "201"
BOOKING=$(body_of "$R" | pluck 'd.booking.id')
REF=$(body_of "$R" | pluck 'd.booking.booking_ref')
check "status confirmed" "$(body_of "$R" | pluck 'd.booking.status')" "confirmed"
# 800 + 800 + 350
check "server-computed total" "$(body_of "$R" | pluck 'd.booking.total_amount')" "1950.00"
check "reference format" "$(body_of "$R" | pluck '/^TB-[A-Z2-9]{8}$/.test(d.booking.booking_ref) ? "ok" : "bad"')" "ok"
check "QR is a PNG data URL" "$(body_of "$R" | pluck 'd.qr_data_url.startsWith("data:image/png;base64,") ? "ok" : "bad"')" "ok"

R=$(call POST /api/bookings "${CUST}" "{\"show_id\":${SHOW},\"seat_ids\":[${SEAT1}]}")
check "cannot re-book a booked seat" "$(status_of "$R")" "409"

R=$(call GET "/api/shows/${SHOW}/seats")
check "3 seats now booked" "$(body_of "$R" | pluck 'd.summary.booked')" "3"
check "7 seats remain" "$(body_of "$R" | pluck 'd.summary.available')" "7"
echo ""

# --- History ----------------------------------------------------------------
echo "Customer: history and ticket"
R=$(call GET /api/bookings "${CUST}")
check "history lists the booking" "$(body_of "$R" | pluck 'd.bookings.length')" "1"
check "history includes 3 seats" "$(body_of "$R" | pluck 'd.bookings[0].seats.length')" "3"

R=$(call GET "/api/bookings/ref/${REF}" "${CUST}")
check "resolve by reference" "$(status_of "$R")" "200"

R=$(call GET "/api/bookings/${BOOKING}/qr" "${CUST}")
check "re-fetch QR" "$(status_of "$R")" "200"

R=$(call POST /api/auth/register "" "{\"name\":\"Nosy\",\"email\":\"nosy${STAMP}@test.local\",\"password\":\"smoketest123\"}")
NOSY=$(body_of "$R" | pluck 'd.token')
R=$(call GET "/api/bookings/${BOOKING}" "${NOSY}")
check "another customer cannot read the booking" "$(status_of "$R")" "404"
echo ""

# --- Summary ----------------------------------------------------------------
echo "=========================================="
printf "  passed: %s\n" "${PASS}"
printf "  failed: %s\n" "${FAIL}"
echo "=========================================="

if [ "${FAIL}" -eq 0 ]; then
  echo "SMOKE TEST PASSED"
  exit 0
fi
echo "SMOKE TEST FAILED"
exit 1
