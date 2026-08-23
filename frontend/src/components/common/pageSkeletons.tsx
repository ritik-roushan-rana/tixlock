import { ArrowLeft } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';

/**
 * Route-level loading shells, used as the Suspense fallback while a page's chunk
 * downloads.
 *
 * Why these exist: every route previously fell back to `FullPageSpinner`, a single
 * 24px muted spinner centred in a 60dvh box. It is not blank, but it carries no
 * layout, no title and no structure, and `main` stretches to fill a `min-h-dvh`
 * shell — so on the dark theme, whose `--background` is #0f100e, a chunk fetch looks
 * exactly like a black screen. The fix is to show the page's *shape* immediately and
 * let the real content replace it.
 *
 * Two rules govern this file:
 *
 *  1. **Self-contained.** A Suspense fallback renders before the page's chunk has
 *     loaded, so it must live in the initial bundle. Importing the real
 *     `EventCardSkeleton` would drag `EventCard` — and with it Poster, posters,
 *     eventTheme, money, datetime — into that bundle, making every route slower to
 *     fix a perceived-speed problem. So the geometry is duplicated here deliberately,
 *     built only from `Skeleton` and one icon.
 *  2. **Geometry matches the real page.** Each block mirrors the container, grid
 *     tracks and aspect ratios of the page it stands in for, so the swap from
 *     skeleton to content does not move anything.
 *
 * Announced via `role="status"` with a screen-reader label, because `Skeleton` itself
 * is `aria-hidden` — without this, a non-visual user gets silence during navigation.
 */

function Shell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" className="space-y-md">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** Matches the `BackLink` on the detail pages, so the row does not appear late. */
function BackLinkSkeleton() {
  return (
    <span className="eyebrow inline-flex items-center gap-1.5 text-muted-foreground">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      Back
    </span>
  );
}

/** Events browse: filter block, heading, hero, then the card grid. */
export function EventsPageSkeleton() {
  return (
    <Shell label="Loading events">
      <div className="space-y-lg md:space-y-xl">
        {/* Hero. 60/70vh to match FeaturedEvent. */}
        <Skeleton className="h-[60vh] w-full md:h-[70vh]" />

        {/* Filter block: the tonal section, chip row and date row. */}
        <section className="bg-card p-2">
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-9 w-16" />
            <Skeleton className="h-9 w-20" />
            <Skeleton className="h-9 w-24" />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-card-alt pt-2">
            <Skeleton className="h-9 w-[9rem]" />
            <Skeleton className="h-9 w-[9rem]" />
          </div>
        </section>

        <section className="space-y-md">
          <Skeleton className="h-10 w-56" />
          <div className="grid grid-cols-[minmax(0,1fr)] gap-lg md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i}>
                {/* 4:5 artwork, then title, meta and the status strip. */}
                <Skeleton className="mb-2 aspect-[4/5] w-full" />
                <div className="space-y-2">
                  <Skeleton className="h-7 w-4/5" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-3 w-28" />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </Shell>
  );
}

/**
 * Event detail: two columns, 16/10 hero, title, meta, and the sticky booking panel.
 * Mirrors EventDetailPage's own loading branch so the two are indistinguishable.
 */
export function EventDetailSkeleton() {
  return (
    <Shell label="Loading event">
      <BackLinkSkeleton />
      <div className="grid gap-lg lg:grid-cols-[1fr_22rem]">
        <div className="space-y-md">
          <Skeleton className="aspect-[16/10] w-full" />
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-7 w-24" />
          </div>
          <Skeleton className="h-16 w-4/5" />
          <div className="flex flex-wrap gap-lg">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-32" />
          </div>
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <div className="space-y-md">
          <div className="bg-card p-4">
            <Skeleton className="mb-3 h-4 w-28" />
            <div className="space-y-2">
              <Skeleton className="h-[3.5rem] w-full" />
              <Skeleton className="h-[3.5rem] w-full" />
              <Skeleton className="h-[3.5rem] w-3/4" />
            </div>
          </div>
          <div className="bg-card p-4">
            <Skeleton className="mb-2 h-4 w-20" />
            <Skeleton className="aspect-[4/3] w-full" />
          </div>
        </div>
      </div>
    </Shell>
  );
}

/**
 * Seat map: header, then the grid card beside the checkout column.
 *
 * The seat grid placeholder is a real row/seat lattice rather than one big block, so
 * the shape of the auditorium is visible before the data arrives and the swap does
 * not reflow.
 */
export function SeatMapSkeletonPage() {
  return (
    <Shell label="Loading seat map">
      <BackLinkSkeleton />
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-4 w-56" />
      <div className="grid gap-lg lg:grid-cols-[1fr_20rem]">
        <div className="bg-card p-4">
          {/* Stage slab, then eight rows of seats. */}
          <Skeleton className="mx-auto mb-6 h-6 w-40" />
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, row) => (
              <div key={row} className="flex items-center justify-center gap-1.5">
                <Skeleton className="mr-2 h-4 w-4" />
                {Array.from({ length: 12 }).map((_, seat) => (
                  <Skeleton key={seat} className="h-7 w-7" />
                ))}
              </div>
            ))}
          </div>
          {/* Legend. */}
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-20" />
            ))}
          </div>
        </div>
        <div className="space-y-md">
          <div className="bg-card p-4">
            <Skeleton className="mb-3 h-4 w-32" />
            <div className="space-y-2">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-2/3" />
            </div>
          </div>
          <Skeleton className="h-28 w-full" />
        </div>
      </div>
    </Shell>
  );
}

/** My tickets: heading, tab row, then the two-column card grid. */
export function BookingsPageSkeleton() {
  return (
    <Shell label="Loading your tickets">
      <div className="mb-lg flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div className="space-y-2">
          <Skeleton className="h-12 w-64" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-10 w-28" />
          <Skeleton className="h-10 w-28" />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-52 w-full" />
        ))}
      </div>
    </Shell>
  );
}

/** Organiser dashboard: heading, stat row, charts, then the events table. */
export function DashboardSkeleton() {
  return (
    <Shell label="Loading dashboard">
      <Skeleton className="h-10 w-56" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-card p-4">
            <Skeleton className="mb-3 h-3 w-24" />
            <Skeleton className="h-7 w-24" />
          </div>
        ))}
      </div>
      <div className="grid gap-lg lg:grid-cols-2">
        <Skeleton className="h-80 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
      <div className="bg-card p-4">
        <Skeleton className="mb-3 h-4 w-40" />
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </Shell>
  );
}

/** Per-event organiser report. */
export function EventReportSkeleton() {
  return (
    <Shell label="Loading event report">
      <BackLinkSkeleton />
      <Skeleton className="h-8 w-72" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </Shell>
  );
}

/** Admin venues: heading, then the venue rows. */
export function AdminPageSkeleton() {
  return (
    <Shell label="Loading venues">
      <div className="flex items-end justify-between gap-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-10 w-32" />
      </div>
      <div className="bg-card p-4">
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    </Shell>
  );
}

/** Waitlist offer claim page. */
export function OfferPageSkeleton() {
  return (
    <Shell label="Loading your offer">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="h-72 w-full" />
    </Shell>
  );
}

/** Sign in / register: the centred auth card. */
export function AuthPageSkeleton() {
  return (
    <Shell label="Loading">
      <div className="mx-auto w-full max-w-md space-y-4 py-lg">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-4 w-64" />
        <div className="bg-card p-4 space-y-3">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      </div>
    </Shell>
  );
}

/**
 * Generic fallback for routes with no meaningful shape of their own (404).
 * Deliberately still structural rather than a bare spinner.
 */
export function GenericPageSkeleton() {
  return (
    <Shell label="Loading">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-4 w-2/3 max-w-md" />
    </Shell>
  );
}
