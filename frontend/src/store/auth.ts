import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import { TOKEN_STORAGE_KEY, configureApiSession } from '@/lib/api/client';
import type { User, UserRole } from '@/lib/api/types';

/**
 * Session state.
 *
 * Client-only, so Zustand rather than React Query. The token is additionally
 * mirrored into a standalone localStorage key (`tb-token`) because the Axios
 * request interceptor needs it synchronously, outside React, before any component
 * has rendered.
 */

interface AuthState {
  user: User | null;
  token: string | null;

  signIn: (user: User, token: string) => void;
  signOut: () => void;
  /** Refresh the cached user after /auth/me, without touching the token. */
  setUser: (user: User) => void;
}

function writeToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* private mode — the in-memory token still works for this tab */
  }
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,

      signIn: (user, token) => {
        writeToken(token);
        set({ user, token });
      },

      signOut: () => {
        writeToken(null);
        set({ user: null, token: null });
      },

      setUser: (user) => set({ user }),
    }),
    {
      name: 'tb-auth',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ user: state.user, token: state.token }),
      onRehydrateStorage: () => (state) => {
        // Keep the standalone token key in step with the rehydrated session, in
        // case storage was cleared or written by an older build.
        //
        // Only `state` is touched here. An earlier version called
        // useAuthStore.getState() from this callback, which runs while the store is
        // still being constructed — the reference was in its temporal dead zone, the
        // resulting error was swallowed by zustand's hydration promise, and the
        // hydration flag never flipped. Every guarded route then rendered a spinner
        // forever. Hydration state is now read through zustand's own API below.
        writeToken(state?.token ?? null);
      },
    }
  )
);

/* --- Selectors ----------------------------------------------------------- */

export const selectIsSignedIn = (s: AuthState) => Boolean(s.token && s.user);
export const selectRole = (s: AuthState): UserRole | null => s.user?.role ?? null;

/**
 * Has the persisted session been read from storage yet?
 *
 * Route guards must wait for this before deciding, or a refresh on a protected route
 * bounces the user to login and loses their place. Uses zustand's own hydration API
 * rather than a hand-rolled flag in the store, which is both less code and immune to
 * the construction-order trap described in onRehydrateStorage above.
 *
 * `hasHydrated()` is checked in the initialiser as well as via the subscription,
 * because with synchronous localStorage hydration usually completes before the first
 * effect runs — in which case onFinishHydration would never fire for this listener.
 */
export function useAuthHydrated(): boolean {
  const [hydrated, setHydrated] = useState<boolean>(() => useAuthStore.persist.hasHydrated());

  useEffect(() => {
    const unsubscribe = useAuthStore.persist.onFinishHydration(() => setHydrated(true));
    if (useAuthStore.persist.hasHydrated()) setHydrated(true);
    return unsubscribe;
  }, []);

  return hydrated;
}

/** Where a user should land after signing in, based on their role. */
export function landingPathForRole(role: UserRole): string {
  switch (role) {
    case 'admin':
      return '/admin';
    case 'organiser':
      return '/organiser';
    case 'customer':
    default:
      return '/events';
  }
}

/* --- Wiring -------------------------------------------------------------- */

/**
 * Connect the store to the API client.
 *
 * Called once from main.tsx. This indirection exists to break what would
 * otherwise be an import cycle: the client needs the token, the store needs the
 * client's storage key. Registering callbacks keeps the dependency one-way.
 */
export function wireAuthToApiClient(onSignedOut: () => void) {
  configureApiSession({
    getToken: () => useAuthStore.getState().token ?? null,
    onUnauthorized: () => {
      // Only act if we thought we were signed in, so a 401 on an anonymous
      // request (e.g. an optional-auth seat map) cannot trigger a redirect loop.
      if (useAuthStore.getState().token) {
        useAuthStore.getState().signOut();
        onSignedOut();
      }
    },
  });
}
