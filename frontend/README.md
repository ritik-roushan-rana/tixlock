# Frontend

React 18 + Vite + TypeScript SPA for TixLock. Talks to the
Express/PostgreSQL backend in `../backend` over HTTP and Socket.io.

```bash
npm install
cp .env.example .env.local     # defaults point at http://localhost:3000
npm run dev                    # http://localhost:5173
```

The backend must be running separately (`cd ../backend && npm start`).

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on :5173 |
| `npm run build` | Typecheck, then production build to `dist/` |
| `npm run preview` | Serve the built bundle locally |
| `npm run typecheck` | `tsc --noEmit` |

## Stack

| Concern | Choice |
|---|---|
| Build | Vite 5 |
| UI | Tailwind CSS 3 + shadcn/ui (Radix primitives, copied into `components/ui`) |
| Routing | React Router 6, code-split per route |
| Server state | React Query 5 |
| Client state | Zustand (auth, seat selection, theme) |
| Realtime | socket.io-client |
| Forms | react-hook-form + zod |
| HTTP | Axios with a JWT interceptor |
| Charts | Recharts |
| Toasts | Sonner |

## Layout

```
src/
  lib/
    api/client.ts       Axios instance, ApiError, JWT interceptor, 401 handling
    api/endpoints.ts    One function per backend endpoint
    api/types.ts        TypeScript mirrors of the real API responses
    money.ts            toMoney() — normalises the API's string|number money
    datetime.ts         Timezone-safe parsing of the API's bare date/time strings
    queryKeys.ts        Centralised React Query keys
  store/                auth, seatSelection, theme (Zustand)
  hooks/
    useSeatSocket.ts    Socket.io subscription + cache patching
    useCountdown.ts     Server-deadline-driven countdown
    useSeatMap.ts       Seat map queries and hold/book/cancel mutations
  components/
    ui/                 shadcn/ui primitives
    seatmap/            Seat, SeatMapGrid, CheckoutPanel, HoldCountdown
    dashboard/          Charts and create dialogs
    admin/              Visual seat layout editor
  pages/                One file per route
  routes/               Route table and role guards
```

## Two things worth knowing before editing

**Money arrives as two different types.** Top-level `NUMERIC` columns are exact
decimal strings (`"650.00"`); the same value nested inside a `json_agg` arrives as
a number (`650`). Everything monetary goes through `toMoney()` from
`lib/money.ts` — see the comment block there for the full explanation.

**Dates are bare strings, not instants.** The API sends `date` as `YYYY-MM-DD`
with no timezone. `new Date('2026-09-18')` parses that as *UTC* midnight, which
renders as the previous day west of UTC. Use the helpers in `lib/datetime.ts`,
which build Dates from explicit local components.

See the repository root `README.md` for the full setup, and `SYSTEM_DESIGN.md`
for the seat-hold and waitlist mechanics.
