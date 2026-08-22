import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';

import './index.css';
import { router } from '@/routes';
import { queryClient } from '@/lib/queryClient';
import { wireAuthToApiClient } from '@/store/auth';
import { queryKeys } from '@/lib/queryKeys';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * Connect the auth store to the Axios interceptor before the first render, so any
 * request fired during initial mount already carries the token.
 *
 * On a 401 we clear the cache as well as the session: leaving another user's
 * events/bookings in the React Query cache after a session ends would show stale
 * private data for a moment on the next sign-in.
 */
wireAuthToApiClient(() => {
  queryClient.removeQueries({ queryKey: queryKeys.bookings.all });
  queryClient.removeQueries({ queryKey: queryKeys.waitlist.all });
  queryClient.removeQueries({ queryKey: queryKeys.dashboard.all });
  queryClient.removeQueries({ queryKey: queryKeys.auth.me });

  // Router navigation is not available outside the tree, and a hard redirect is
  // the right response to an invalidated session anyway: it guarantees no stale
  // component state survives. `next` preserves where the user was headed.
  const next = `${window.location.pathname}${window.location.search}`;
  const isOnAuthPage = window.location.pathname.startsWith('/login') || window.location.pathname.startsWith('/register');
  if (!isOnAuthPage) {
    window.location.replace(`/login?next=${encodeURIComponent(next)}&expired=1`);
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>
);
