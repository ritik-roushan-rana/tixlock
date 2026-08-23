import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';

import {
  landingPathForRole,
  selectIsSignedIn,
  useAuthHydrated,
  useAuthStore,
} from '@/store/auth';
import type { UserRole } from '@/lib/api/types';
import { EmptyState } from '@/components/common/states';
import { AuthPageSkeleton, GenericPageSkeleton } from '@/components/common/pageSkeletons';
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

/**
 * What a guard shows while the persisted session is being read.
 *
 * Hydration normally resolves within the first frame — `hasHydrated()` is checked in
 * the state initialiser for exactly that reason — so this is usually invisible. It
 * still matters: it used to be `FullPageSpinner`, which put a second structure-less
 * phase in front of the chunk-loading one on every protected route, and if hydration
 * ever stalls (it has: see the onRehydrateStorage note in store/auth.ts) this is what
 * the user stares at. A page-shaped shell degrades far better than a bare spinner.
 */
interface GuardProps {
  /** Loading shell matching the routes this guard protects. */
  fallback?: React.ReactNode;
}

/** Requires any signed-in user. */
export function RequireAuth({ fallback }: GuardProps = {}) {
  const isSignedIn = useAuthStore(selectIsSignedIn);
  const hydrated = useAuthHydrated();
  const location = useLocation();

  if (!hydrated) return <>{fallback ?? <GenericPageSkeleton />}</>;

  if (!isSignedIn) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }

  return <Outlet />;
}

/** Requires one of the given roles. Assumes RequireAuth is an ancestor. */
export function RequireRole({ roles, fallback }: { roles: UserRole[] } & GuardProps) {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthHydrated();
  const location = useLocation();

  if (!hydrated) return <>{fallback ?? <GenericPageSkeleton />}</>;

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
export function RedirectIfSignedIn({ fallback }: GuardProps = {}) {
  const user = useAuthStore((s) => s.user);
  const isSignedIn = useAuthStore(selectIsSignedIn);
  const hydrated = useAuthHydrated();

  if (!hydrated) return <>{fallback ?? <AuthPageSkeleton />}</>;
  if (isSignedIn && user) return <Navigate to={landingPathForRole(user.role)} replace />;

  return <Outlet />;
}
