import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, LayoutDashboard, LogOut, Moon, Settings, Sun, Ticket, User as UserIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { authApi } from '@/lib/api/endpoints';
import { queryKeys } from '@/lib/queryKeys';
import { useAuthStore, selectIsSignedIn } from '@/store/auth';
import { useThemeStore } from '@/store/theme';
import type { UserRole } from '@/lib/api/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface NavItem {
  to: string;
  label: string;
  icon: typeof CalendarDays;
  /** '*' = visible to everyone, including anonymous visitors. */
  roles: Array<UserRole | '*'>;
}

const NAV: NavItem[] = [
  { to: '/events', label: 'Events', icon: CalendarDays, roles: ['*'] },
  { to: '/bookings', label: 'My tickets', icon: Ticket, roles: ['customer'] },
  { to: '/organiser', label: 'Dashboard', icon: LayoutDashboard, roles: ['organiser', 'admin'] },
  { to: '/admin', label: 'Venues', icon: Settings, roles: ['admin'] },
];

function ThemeToggle() {
  const { theme, toggle } = useThemeStore();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
    >
      {theme === 'dark' ? <Sun /> : <Moon />}
    </Button>
  );
}

function UserMenu() {
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const navigate = useNavigate();

  if (!user) {
    return (
      <div className="flex items-center gap-sm">
        <Button variant="ghost" asChild>
          <NavLink to="/login">Sign in</NavLink>
        </Button>
        {/* Ink, not the mock's lime. Chrome persists across every screen, so a lime
            control here would sit beside the lime CTA each page already spends —
            "Get tickets", "Hold seats", "Claim seat" — and the eye would have no way
            to tell the page's action from the furniture. Lime in this bar is the
            active-section rule and nothing else. */}
        <Button asChild>
          <NavLink to="/register">Get started</NavLink>
        </Button>
      </div>
    );
  }

  const initials = user.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* `outline` gives the trailing control the mock's 1px framed box, which is what
            anchors the right end of the bar. */}
        <Button variant="outline" className="gap-2 pl-1.5">
          {/* Square, not a circle. It was the last `rounded-full` left in the app's
              own markup, and the shape language here is 0px without exceptions. Solid
              ink carrying cream initials reads as the same kind of chip used for event
              type and status elsewhere. */}
          <span className="flex h-6 w-6 items-center justify-center bg-panel text-[11px] font-bold text-panel-foreground">
            {initials || <UserIcon className="h-3 w-3" />}
          </span>
          <span className="hidden max-w-[10rem] truncate sm:inline">{user.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="space-y-1">
          <p className="truncate text-sm">{user.name}</p>
          <p className="truncate text-xs font-normal text-muted-foreground">{user.email}</p>
          <Badge variant="secondary" className="mt-1 capitalize">
            {user.role}
          </Badge>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            signOut();
            navigate('/login', { replace: true });
          }}
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Application chrome: header, navigation, and the routed outlet.
 *
 * Also the place where a persisted session is validated. The store rehydrates a
 * token from localStorage optimistically so the UI is not blocked, then this query
 * confirms it against /auth/me. That matters because the backend re-reads the user
 * row on every request: a deleted user or a changed role must take effect
 * immediately, not whenever the JWT happens to expire. A 401 here is handled by
 * the Axios interceptor, which clears the session.
 */
export function AppShell() {
  const isSignedIn = useAuthStore(selectIsSignedIn);
  const setUser = useAuthStore((s) => s.setUser);
  const role = useAuthStore((s) => s.user?.role ?? null);

  useQuery({
    queryKey: queryKeys.auth.me,
    queryFn: async () => {
      const user = await authApi.me();
      setUser(user);
      return user;
    },
    enabled: isSignedIn,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const visibleNav = NAV.filter(
    (item) => item.roles.includes('*') || (role !== null && item.roles.includes(role))
  );

  return (
    <div className="flex min-h-dvh flex-col">
      {/*
        Flat, opaque, hard-ruled. No blur and no translucency: this system builds
        hierarchy from a solid 1px ink rule and a surface step, and a backdrop-blur
        header would be simulating depth the design explicitly rejects.
      */}
      <header className="sticky top-0 z-40 border-b border-border-strong bg-background">
        {/*
          Three groups on a single baseline: wordmark, links, actions. `justify-between`
          rather than an absolutely centred nav — the link group's width changes with
          role, and a long display name in the account control would slide under an
          absolute nav rather than push it. Drifting slightly off optical centre is the
          cheaper compromise.
        */}
        <div className="container flex h-16 items-center justify-between gap-4">
          <NavLink
            to="/events"
            // 36px Anton, close to the mock's 48px without letting the wordmark crowd
            // the 64px bar. Weight stays 400 — `.heading` pins it, because the mock's
            // `font-black` on a single-weight face only gets you synthetic bold, which
            // smears a condensed design.
            className="heading shrink-0 text-4xl uppercase tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            TixLock
          </NavLink>

          {/* `h-full` on the links, not padding: the active rule has to land on the
              header's own hairline, which only happens if the item spans the full 64px. */}
          <nav className="flex h-full items-center gap-4 md:gap-lg" aria-label="Main navigation">
            {visibleNav.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                // The icon carries the label below md, where the text is hidden, so the
                // accessible name has to come from the attribute in both cases.
                aria-label={label}
                className={({ isActive }) =>
                  cn(
                    'inline-flex h-full items-center px-1 text-body-md transition-colors md:px-sm',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    // 4px lime rule flush with the bottom of the bar marks the current
                    // section. Transparent at the same weight when inactive, so the
                    // label never shifts on navigation.
                    isActive
                      ? 'border-b-4 border-lime font-bold text-foreground'
                      : // Hover resolves to full ink, never to lime. Lime text on cream
                        // is about 1.5:1 — the mock's `hover:text-secondary` would have
                        // made every hovered link effectively invisible.
                        'border-b-4 border-transparent text-muted-foreground hover:text-foreground'
                  )
                }
              >
                <Icon className="h-5 w-5 md:hidden" aria-hidden />
                <span className="hidden md:inline">{label}</span>
              </NavLink>
            ))}
          </nav>

          <div className="flex shrink-0 items-center gap-sm">
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
      </header>

      {/* The "No Edge" rule: content never touches the viewport. `container` supplies
          24px of gutter, widening to 64px from lg up. */}
      <main className="container flex-1 py-lg md:py-xl">
        <Outlet />
      </main>

      <footer className="mt-lg border-t border-border-strong py-6">
        <div className="container flex flex-col gap-1 text-body-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>Live seat maps, held seats and waitlists update in real time.</p>
          <p className="tabular">Seats are held for a limited time at checkout.</p>
        </div>
      </footer>
    </div>
  );
}
