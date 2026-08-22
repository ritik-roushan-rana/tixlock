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
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <NavLink to="/login">Sign in</NavLink>
        </Button>
        <Button size="sm" asChild>
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
        <Button variant="ghost" size="sm" className="gap-2 pl-1.5">
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
        <div className="container flex h-16 items-center gap-4">
          <NavLink
            to="/events"
            className="heading shrink-0 text-2xl uppercase tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            TixLock
          </NavLink>

          <nav className="flex items-center gap-1 md:gap-2" aria-label="Main navigation">
            {visibleNav.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  cn(
                    'inline-flex items-center gap-1.5 px-2 py-1.5 text-body-sm transition-colors md:px-3',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isActive
                      ? // Lime underline marks the current section. A 2px rule rather
                        // than a filled pill — the reference's active treatment.
                        'border-b-2 border-lime font-bold text-foreground'
                      : 'border-b-2 border-transparent text-muted-foreground hover:text-foreground'
                  )
                }
              >
                <Icon className="h-4 w-4" aria-hidden />
                <span className="hidden sm:inline">{label}</span>
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1">
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
