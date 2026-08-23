import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';

import { AppShell } from '@/components/layout/AppShell';
import { LazyBoundary } from '@/components/common/LazyBoundary';
import {
  AdminPageSkeleton,
  AuthPageSkeleton,
  BookingsPageSkeleton,
  DashboardSkeleton,
  EventDetailSkeleton,
  EventReportSkeleton,
  EventsPageSkeleton,
  GenericPageSkeleton,
  OfferPageSkeleton,
  SeatMapSkeletonPage,
} from '@/components/common/pageSkeletons';
import { RequireAuth, RequireRole, RedirectIfSignedIn } from './guards';
import { RouteErrorBoundary } from './RouteErrorBoundary';

/**
 * Route table.
 *
 * Everything past the auth pages is code-split. The seat map in particular pulls
 * in socket.io-client, and the organiser dashboard pulls in recharts — neither
 * should be in the bundle a customer downloads just to browse events.
 */

const LoginPage = lazy(() => import('@/pages/LoginPage'));
const RegisterPage = lazy(() => import('@/pages/RegisterPage'));
const EventsPage = lazy(() => import('@/pages/EventsPage'));
const EventDetailPage = lazy(() => import('@/pages/EventDetailPage'));
const SeatMapPage = lazy(() => import('@/pages/SeatMapPage'));
const BookingsPage = lazy(() => import('@/pages/BookingsPage'));
const OfferPage = lazy(() => import('@/pages/OfferPage'));
const OrganiserPage = lazy(() => import('@/pages/OrganiserPage'));
const OrganiserEventPage = lazy(() => import('@/pages/OrganiserEventPage'));
const AdminPage = lazy(() => import('@/pages/AdminPage'));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage'));

/**
 * Wrap a lazy page with its own loading shell.
 *
 * `fallback` is per-route on purpose. Every route used to share `FullPageSpinner`,
 * which is a single muted spinner in a 60dvh box: no layout, no title, no structure.
 * Since `main` is a `flex-1` child of a `min-h-dvh` shell, that fallback let the page
 * background fill the viewport — and on the dark theme that background is #0f100e, so
 * a chunk fetch was indistinguishable from a black screen. Showing the destination's
 * shape instead means navigation always lands on something recognisable.
 */
const suspend = (node: React.ReactNode, fallback: React.ReactNode) => (
  <LazyBoundary>
    <Suspense fallback={fallback}>{node}</Suspense>
  </LazyBoundary>
);

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    errorElement: <RouteErrorBoundary />,
    children: [
      { index: true, element: <Navigate to="/events" replace /> },

      // --- Public -------------------------------------------------------
      { path: 'events', element: suspend(<EventsPage />, <EventsPageSkeleton />) },
      { path: 'events/:eventId', element: suspend(<EventDetailPage />, <EventDetailSkeleton />) },
      // Seat maps are viewable anonymously; holding a seat requires signing in,
      // which the page prompts for at the point of action.
      { path: 'shows/:showId', element: suspend(<SeatMapPage />, <SeatMapSkeletonPage />) },
      // The offer link arrives by email, so it must render for a visitor with no
      // session. Claiming prompts for sign-in.
      { path: 'offer', element: suspend(<OfferPage />, <OfferPageSkeleton />) },

      // --- Auth ---------------------------------------------------------
      {
        element: <RedirectIfSignedIn fallback={<AuthPageSkeleton />} />,
        children: [
          { path: 'login', element: suspend(<LoginPage />, <AuthPageSkeleton />) },
          { path: 'register', element: suspend(<RegisterPage />, <AuthPageSkeleton />) },
        ],
      },

      // --- Customer -----------------------------------------------------
      {
        // Each guard is handed the shell of what it protects, so the hydration frame
        // shows the destination's shape rather than a generic placeholder.
        element: <RequireAuth fallback={<GenericPageSkeleton />} />,
        children: [
          {
            element: <RequireRole roles={['customer']} fallback={<BookingsPageSkeleton />} />,
            children: [
              { path: 'bookings', element: suspend(<BookingsPage />, <BookingsPageSkeleton />) },
            ],
          },
          {
            element: (
              <RequireRole roles={['organiser', 'admin']} fallback={<DashboardSkeleton />} />
            ),
            children: [
              { path: 'organiser', element: suspend(<OrganiserPage />, <DashboardSkeleton />) },
              {
                path: 'organiser/events/:eventId',
                element: suspend(<OrganiserEventPage />, <EventReportSkeleton />),
              },
            ],
          },
          {
            element: <RequireRole roles={['admin']} fallback={<AdminPageSkeleton />} />,
            children: [{ path: 'admin', element: suspend(<AdminPage />, <AdminPageSkeleton />) }],
          },
        ],
      },

      { path: '*', element: suspend(<NotFoundPage />, <GenericPageSkeleton />) },
    ],
  },
]);
