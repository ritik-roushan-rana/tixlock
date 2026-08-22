import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';

import {
  landingPathForRole,
  selectIsSignedIn,
  useAuthHydrated,
  useAuthStore,
} from '@/store/auth';
import type { UserRole } from '@/lib/api/types';
import { EmptyState, FullPageSpinner } from '@/components/common/states';
import { Button } from '@/components/ui/button';

/**
 * Route guards.
 *
 * These are a UX affordance, not a security boundary — the API enforces roles on
 * every request and is the only thing that actually protects data. Their job is to
 * avoid rendering a screen that is guaranteed to 403.
 *
 * All three wait on useAuthHydrated() before deciding. Without that, a refresh on a
 * protected route would evaluate the guard before localStorage had been read, see no
 * session, and redirect a signed-in user to login.
 */

/** Requires any signed-in user. */
export function RequireAuth() {
  const isSignedIn = useAuthStore(selectIsSignedIn);
  const hydrated = useAuthHydrated();
  const location = useLocation();

  if (!hydrated) return <FullPageSpinner />;

  if (!isSignedIn) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }

  return <Outlet />;
}

/** Requires one of the given roles. Assumes RequireAuth is an ancestor. */
export function RequireRole({ roles }: { roles: UserRole[] }) {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthHydrated();
  const location = useLocation();

  if (!hydrated) return <FullPageSpinner />;

  if (!user) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }

  if (!roles.includes(user.role)) {
    return (
      <EmptyState
        icon={<ShieldAlert className="h-5 w-5" />}
        title="This area is not available for your account"
        description={`It requires the ${roles.join(' or ')} role — you are signed in as ${user.role}.`}
        action={
          <Button asChild variant="outline">
            <NavLink to={landingPathForRole(user.role)}>Go to your dashboard</NavLink>
          </Button>
        }
      />
    );
  }

  return <Outlet />;
}

/**
 * Inverse guard for /login and /register: a signed-in user has no reason to see
 * them, so send them to their role's landing page instead.
 */
export function RedirectIfSignedIn() {
  const user = useAuthStore((s) => s.user);
  const isSignedIn = useAuthStore(selectIsSignedIn);
  const hydrated = useAuthHydrated();

  if (!hydrated) return <FullPageSpinner />;
  if (isSignedIn && user) return <Navigate to={landingPathForRole(user.role)} replace />;

  return <Outlet />;
}
