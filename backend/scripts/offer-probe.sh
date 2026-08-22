#!/usr/bin/env bash
#
# Generates a real waitlist offer and prints the GET /api/waitlist/offers/:token
# response, so the offer payload can be inspected against a live server.
#
# Usage:  ./scripts/offer-probe.sh [SHOW_ID]
#
# Requires a running server and a seeded database. Sells out the show's Premium
# category, queues customer2, cancels, and reports the resulting offer.

set -uo pipefail

BASE="${BASE_URL:-http://localhost:3000}"
SHOW="${1:-1}"

pluck() {
  node -e "
    let raw='';
    process.stdin.on('data', c => raw += c).on('end', () => {
      try { const d = JSON.parse(raw); const out = ($1); process.stdout.write(out == null ? '' : (typeof out === 'object' ? JSON.stringify(out, null, 1) : String(out))); }
      catch { process.stdout.write(''); }
    });
  "
}

login() {
  curl -s -X POST "${BASE}/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" | pluck 'd.token'
}

C1=$(login customer@ticketbooking.local customer123)
C2=$(login customer2@ticketbooking.local customer123)
[ -z "${C1}" ] && { echo "cannot log in — run 'npm run seed'"; exit 1; }

echo "1. Selling out Premium on show ${SHOW}"
PREM=$(curl -s "${BASE}/api/shows/${SHOW}/seats" \
  | pluck "d.rows.flatMap(r => r.seats).filter(s => s.category === 'Premium' && s.status === 'available').map(s => s.id)")
[ -z "${PREM}" ] && { echo "   no available Premium seats on show ${SHOW}"; exit 1; }

# The hold endpoint caps at 10 seats per request, so book in batches.
TOTAL=$(node -e "process.stdout.write(String((${PREM}).length))")
for START in $(seq 0 10 $((TOTAL - 1))); do
  BATCH=$(node -e "process.stdout.write(JSON.stringify((${PREM}).slice(${START}, ${START} + 10)))")
  curl -s -X POST "${BASE}/api/shows/${SHOW}/hold" -H "Authorization: Bearer ${C1}" \
    -H 'Content-Type: application/json' -d "{\"seat_ids\":${BATCH}}" -o /dev/null
  curl -s -X POST "${BASE}/api/bookings" -H "Authorization: Bearer ${C1}" \
    -H 'Content-Type: application/json' -d "{\"show_id\":${SHOW},\"seat_ids\":${BATCH}}" -o /dev/null
done
echo "   booked ${TOTAL} Premium seat(s)"

echo "2. customer2 joins the Premium waitlist"
curl -s -X POST "${BASE}/api/waitlist" -H "Authorization: Bearer ${C2}" \
  -H 'Content-Type: application/json' -d "{\"show_id\":${SHOW},\"category\":\"Premium\"}" -o /dev/null

echo "3. customer cancels, which should offer a seat to customer2"
BK=$(curl -s "${BASE}/api/bookings" -H "Authorization: Bearer ${C1}" \
  | pluck "(d.bookings.find(b => b.status === 'confirmed' && b.show_id === ${SHOW}) || {}).id")
curl -s -X POST "${BASE}/api/bookings/${BK}/cancel" -H "Authorization: Bearer ${C1}" -o /dev/null

TOKEN=$(curl -s "${BASE}/api/waitlist/mine" -H "Authorization: Bearer ${C2}" \
  | pluck "(d.waitlist.find(w => w.status === 'offered') || {}).offer_token")
[ -z "${TOKEN}" ] && { echo "   no offer was created"; exit 1; }

echo ""
echo "GET /api/waitlist/offers/<token>"
curl -s "${BASE}/api/waitlist/offers/${TOKEN}" | pluck 'd.offer'
echo ""
