import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';

import { AppShell } from '@/components/layout/AppShell';
import { FullPageSpinner } from '@/components/common/states';
import { LazyBoundary } from '@/components/common/LazyBoundary';
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

const suspend = (node: React.ReactNode) => (
  <LazyBoundary>
    <Suspense fallback={<FullPageSpinner />}>{node}</Suspense>
  </LazyBoundary>
);

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    errorElement: <RouteErrorBoundary />,
    children: [
      { index: true, element: <Navigate to="/events" replace /> },

      // --- Public -------------------------------------------------------
      { path: 'events', element: suspend(<EventsPage />) },
      { path: 'events/:eventId', element: suspend(<EventDetailPage />) },
      // Seat maps are viewable anonymously; holding a seat requires signing in,
      // which the page prompts for at the point of action.
      { path: 'shows/:showId', element: suspend(<SeatMapPage />) },
      // The offer link arrives by email, so it must render for a visitor with no
      // session. Claiming prompts for sign-in.
      { path: 'offer', element: suspend(<OfferPage />) },

      // --- Auth ---------------------------------------------------------
      {
        element: <RedirectIfSignedIn />,
        children: [
          { path: 'login', element: suspend(<LoginPage />) },
          { path: 'register', element: suspend(<RegisterPage />) },
        ],
      },

      // --- Customer -----------------------------------------------------
      {
        element: <RequireAuth />,
        children: [
          {
            element: <RequireRole roles={['customer']} />,
            children: [{ path: 'bookings', element: suspend(<BookingsPage />) }],
          },
          {
            element: <RequireRole roles={['organiser', 'admin']} />,
            children: [
              { path: 'organiser', element: suspend(<OrganiserPage />) },
              { path: 'organiser/events/:eventId', element: suspend(<OrganiserEventPage />) },
            ],
          },
          {
            element: <RequireRole roles={['admin']} />,
            children: [{ path: 'admin', element: suspend(<AdminPage />) }],
          },
        ],
      },

      { path: '*', element: suspend(<NotFoundPage />) },
    ],
  },
]);
