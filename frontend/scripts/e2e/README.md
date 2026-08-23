# End-to-end browser checks

Three scripts that drive the **built** SPA in a real headless Chrome against a running
backend. They exist because the other checks in this repo each miss something:

| Check | Catches | Misses |
|---|---|---|
| `tsc --noEmit` | type errors | anything at runtime |
| `npm run build` | bundling errors | anything at runtime |
| `scripts/verify-api-contract.mjs` | wrong URLs, verbs, response shapes | whether the UI renders |
| `journey.mjs` / `realtime.mjs` | mount failures, broken flows, dead realtime | how any of it *looks* |
| **`design-system.mjs`** | contrast, overflow, radius, shadow, tap-target regressions | — |

A bundle can typecheck and build cleanly and still throw on mount. These scripts are
what proved the app actually works.

And a green behavioural run still says nothing about the visual system: `journey.mjs`
passed 39/39 while two mobile screens carried a horizontal scrollbar and three text
elements sat below AA contrast. `design-system.mjs` is what closes that gap.

## Why they are not wired into `npm test`

They need `puppeteer-core` (79 packages) and a local Chrome install. Forcing that on
everyone who clones the repo is a poor trade for a check that only matters before a
release, so the dependency is deliberately not in `package.json`.

## Running them

```bash
# 1. Backend on :3000, with a seeded database
cd ../../backend && npm run migrate:reset && npm run seed && npm start

# 2. Build and serve the frontend on :4173
cd ../frontend && npm run build && npx vite preview --port 4173

# 3. Install the runner (once) and go
npm i -D puppeteer-core
node scripts/e2e/journey.mjs
node scripts/e2e/realtime.mjs
node scripts/e2e/design-system.mjs
node scripts/e2e/image-performance.mjs
node scripts/e2e/loading-ux.mjs
```

`journey.mjs` expects at least one event with a 46-seat show, which
`backend/npm run seed` plus one organiser-created show provides. `realtime.mjs`
creates its own throwaway show, so it needs no particular fixture.

Set `APP_URL` to point at a different origin (defaults to `http://localhost:4173`).
Both exit non-zero on failure.

## What each covers

**`journey.mjs`** — 38 assertions across the whole product:
anonymous browse, event detail, seat grid rendering (asserts exactly 46 seats),
customer sign-in and role redirect, seat selection, hold with a server-derived
countdown, booking with QR, booking history, organiser dashboard including Recharts
surfaces, per-event report, admin venue page and layout editor, client-side role
refusal, mobile seat-map scrolling and tap-target size, theme toggle, and a check that
no console errors or failed requests occurred.

**`realtime.mjs`** — 17 assertions on the two things a single page cannot show:

1. **Live updates between two clients.** One tab watches a seat map; a different
   customer holds a seat entirely out of band via the API. The watcher must see the
   seat flip to `taken` — and then back to `available` on release — *without*
   navigating or reloading. This is what proves the Socket.io subscription and the
   `setQueryData` patching work rather than just compiling.
2. **The waitlist offer link.** Sells out a category, queues a second customer,
   cancels a booking to trigger a real offer, opens the emailed `/offer?token=…` link
   in the browser, claims it, books it, and confirms the token is rejected on replay.

**`loading-ux.mjs`** — 25 assertions that navigation never lands on a blank or black
screen. Samples the DOM *and* averaged screenshot luminance every ~120ms *during* each
transition, rather than checking the settled state, across slow 4G, 1.5s latency, a
3s-stalled API, and a cold organiser dashboard. Runs in dark theme on purpose: that is
the only theme where an empty `main` reads as black. Also asserts the 377 kB chart
library loads as a separate async chunk after the dashboard layout paints.

**`image-performance.mjs`** — 37 assertions on the event artwork path: content paints
before the hero image, the reserved box shifts nothing (CLS attributable to the image),
`srcSet` narrows what a 390px viewport downloads, a hover-warmed hero is not fetched
twice, failures fall back to the category glyph, and a revisit is served from cache.

**`design-system.mjs`** — walks 18 screen/viewport combinations (every route, in the
role that can reach it, at 1440px and 390px) and enforces the five rules from
`tixlock_core/DESIGN.md`: no box-shadows, 0px radius, at most one lime *actionable*
element per screen, WCAG AA contrast against the composited background, and no
horizontal document overflow with tap targets >= 24px.

Two design decisions inside it are worth knowing before you tighten it:

- **Contrast is measured against the rendered background**, composited up the ancestor
  chain, not against the token a class names. That is the only way to catch a
  translucent fill or a `--muted-foreground` that passes on cream but fails on the
  darkest surface in the ladder.
- **Text over a photograph or an absolutely positioned SVG is reported, not failed.**
  The hero title and the seat map's stage label are deliberately reversed out over
  media that a static check cannot sample, so they print under `over-media` for a human
  to confirm on a screenshot. Everything else is a hard failure.

Pass `--shots` to also write full-page PNGs to `_shots/` for that human pass.

**`hero-contrast.mjs`** — closes the `over-media` gap for the case that matters. Event
artwork renders in full colour, so the hero's white Anton title is legible only because
of the scrim gradient under it. This hides the text, captures the band it occupied, and
measures contrast against every pixel behind it, reporting the worst case rather than an
average. It is what proved the scrim alone is sufficient after the `multiply` blend was
removed — and what showed the original scrim left only a 2% margin.

## Two harness gotchas worth knowing

Both cost real debugging time, so they are recorded here rather than rediscovered:

- **Never wait on `networkidle2`.** The seat map holds an open Socket.io connection by
  design, so the network is never idle and the wait always times out. These scripts
  use `domcontentloaded` plus explicit content assertions.
- **Do not fill the login form by writing to `input.value`.** That updates the DOM but
  not react-hook-form's internal state, so validation still sees empty fields and the
  submit never fires. The scripts click the demo-account buttons instead, which call
  `form.setValue()` inside the app.
