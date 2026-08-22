#!/usr/bin/env bash
#
# Manual concurrency repro: fire N genuinely parallel hold requests at the same
# seat and confirm exactly one succeeds.
#
# This is the curl-based counterpart to tests/concurrency.test.js. It exists
# because "two parallel curl requests" is a claim anyone can verify against a
# running server without a test runner, which makes the concurrency guarantee
# independently checkable.
#
# Usage:
#   ./scripts/race-check.sh [PARALLEL_REQUESTS] [SHOW_ID] [SEAT_ID]
#
# Examples:
#   ./scripts/race-check.sh          # 5 requests, auto-discover show and seat
#   ./scripts/race-check.sh 2        # the brief's "two parallel curl requests"
#   ./scripts/race-check.sh 10 3 42  # 10 requests at show 3, seat 42
#
# Requires: a running server (npm start) with at least one show that has a free
# seat (npm run seed, then create an event + show).

set -uo pipefail

BASE="${BASE_URL:-http://localhost:3000}"
N="${1:-5}"
SHOW_ID="${2:-}"
SEAT_ID="${3:-}"

command -v curl >/dev/null || { echo "curl is required"; exit 1; }
command -v node >/dev/null || { echo "node is required (used to read JSON)"; exit 1; }

# Read a value out of a JSON document on stdin using a JS expression against
# the parsed object `d`. Prints nothing if the path is missing.
pluck() {
  node -e "
    let raw='';
    process.stdin.on('data', c => raw += c).on('end', () => {
      try { const d = JSON.parse(raw); const out = ($1); process.stdout.write(out == null ? '' : String(out)); }
      catch { process.stdout.write(''); }
    });
  "
}

echo "=== Seat hold race check ==="
echo "Target:   ${BASE}"
echo "Requests: ${N}"
echo ""

# --- Sign in N distinct customers -------------------------------------------
# Distinct identities matter: N requests from one account would still be a valid
# race, but different customers prove the winner is one specific user.
echo "1. Preparing ${N} customer accounts"
TOKENS=()
for i in $(seq 1 "${N}"); do
  EMAIL="racer${i}@racecheck.local"
  BODY="{\"name\":\"Racer ${i}\",\"email\":\"${EMAIL}\",\"password\":\"racecheck123\"}"

  TOKEN=$(curl -s -X POST "${BASE}/api/auth/register" \
    -H 'Content-Type: application/json' -d "${BODY}" | pluck 'd.token')

  # Already registered from a previous run: log in instead.
  if [ -z "${TOKEN}" ]; then
    TOKEN=$(curl -s -X POST "${BASE}/api/auth/login" \
      -H 'Content-Type: application/json' \
      -d "{\"email\":\"${EMAIL}\",\"password\":\"racecheck123\"}" | pluck 'd.token')
  fi

  if [ -z "${TOKEN}" ]; then
    echo "   FAILED to get a token for ${EMAIL}. Is the server running at ${BASE}?"
    exit 1
  fi
  TOKENS+=("${TOKEN}")
done
echo "   ${#TOKENS[@]} tokens acquired"

# --- Resolve a show ---------------------------------------------------------
if [ -z "${SHOW_ID}" ]; then
  echo "2. Discovering a show"
  EVENT_ID=$(curl -s "${BASE}/api/events" | pluck 'd.events[0] && d.events[0].id')
  if [ -z "${EVENT_ID}" ]; then
    echo "   No events found. Run 'npm run seed', then create an event and a show."
    exit 1
  fi
  SHOW_ID=$(curl -s "${BASE}/api/events/${EVENT_ID}" | pluck 'd.event.shows[0] && d.event.shows[0].id')
  if [ -z "${SHOW_ID}" ]; then
    echo "   Event ${EVENT_ID} has no shows."
    exit 1
  fi
fi
echo "   show id: ${SHOW_ID}"

# --- Resolve a free seat ----------------------------------------------------
if [ -z "${SEAT_ID}" ]; then
  echo "3. Discovering an available seat"
  SEAT_ID=$(curl -s "${BASE}/api/shows/${SHOW_ID}/seats" \
    | pluck "(d.rows.flatMap(r => r.seats).find(s => s.status === 'available') || {}).id")
  if [ -z "${SEAT_ID}" ]; then
    echo "   No available seats on show ${SHOW_ID}. Every seat is held or booked."
    exit 1
  fi
fi
echo "   seat id: ${SEAT_ID}"
echo ""

# --- Fire the parallel requests ---------------------------------------------
echo "4. Firing ${N} parallel holds at show ${SHOW_ID}, seat ${SEAT_ID}"
WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT

for i in $(seq 1 "${N}"); do
  IDX=$((i - 1))
  # Backgrounded with & so every request is genuinely in flight at once; `wait`
  # below collects them. This is what makes it a real race rather than a
  # sequence of independent calls.
  curl -s -o "${WORK}/body.${i}" -w '%{http_code}' \
    -X POST "${BASE}/api/shows/${SHOW_ID}/hold" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${TOKENS[${IDX}]}" \
    -d "{\"seat_ids\":[${SEAT_ID}]}" > "${WORK}/code.${i}" &
done
wait
echo ""

# --- Report -----------------------------------------------------------------
SUCCESS=0
CONFLICT=0
OTHER=0

echo "5. Results"
for i in $(seq 1 "${N}"); do
  CODE=$(cat "${WORK}/code.${i}" 2>/dev/null || echo "---")
  case "${CODE}" in
    201) SUCCESS=$((SUCCESS + 1)); LABEL="HELD" ;;
    409) CONFLICT=$((CONFLICT + 1)); LABEL="CONFLICT" ;;
    *)   OTHER=$((OTHER + 1)); LABEL="UNEXPECTED" ;;
  esac
  SNIPPET=$(head -c 120 "${WORK}/body.${i}" 2>/dev/null)
  printf "   #%-3s %s %-11s %s\n" "${i}" "${CODE}" "${LABEL}" "${SNIPPET}"
done

echo ""
echo "   ----------------------------------"
printf "   held (201):      %s\n" "${SUCCESS}"
printf "   conflict (409):  %s\n" "${CONFLICT}"
printf "   unexpected:      %s\n" "${OTHER}"
echo "   ----------------------------------"
echo ""

EXPECTED_CONFLICTS=$((N - 1))
if [ "${SUCCESS}" -eq 1 ] && [ "${OTHER}" -eq 0 ] && [ "${CONFLICT}" -eq "${EXPECTED_CONFLICTS}" ]; then
  echo "PASS - exactly one request held seat ${SEAT_ID}; the other ${CONFLICT} were rejected with 409."
  exit 0
fi

echo "FAIL - expected 1 x 201 and ${EXPECTED_CONFLICTS} x 409 with nothing unexpected."
if [ "${SUCCESS}" -eq 0 ]; then
  echo "       0 successes usually means the seat was already taken before the run."
fi
if [ "${SUCCESS}" -gt 1 ]; then
  echo "       MORE THAN ONE SUCCESS IS A REAL CONCURRENCY BUG - the seat was double-sold."
fi
exit 1
