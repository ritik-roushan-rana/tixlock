import { NavLink } from 'react-router-dom';

import { cn } from '@/lib/utils';

/**
 * Shared frame for the sign-in and register screens.
 *
 * The reference (`tixlock_auth/`) is a full-bleed split: a tonal panel on the left
 * carrying the wordmark and an Anton statement, the form on the right. This app's
 * auth routes render *inside* AppShell, so a true edge-to-edge split would mean
 * moving them out of the shell in the router — a structural change, and one that
 * would also strip the header nav off these pages. The split is reproduced inside
 * the content area instead: same two-column editorial structure, same tonal left
 * panel, stacking to one column below `lg`.
 *
 * On mobile the statement panel is dropped entirely rather than stacked above the
 * form. It is atmosphere, and pushing the email field below the fold to make room
 * for it would be a poor trade on a phone.
 */
export function AuthLayout({
  /** Anton statement on the tonal panel. */
  statement,
  /** Supporting copy under the statement. */
  blurb,
  /** Preserved across the Sign in / Register switch so a redirect isn't lost. */
  nextParam,
  children,
}: {
  statement: string;
  blurb: string;
  nextParam: string | null;
  children: React.ReactNode;
}) {
  const withNext = (path: string) =>
    nextParam ? `${path}?next=${encodeURIComponent(nextParam)}` : path;

  return (
    <div className="grid items-stretch gap-8 py-6 lg:grid-cols-2 lg:gap-16 lg:py-12">
      {/* --- Statement panel ---------------------------------------------- */}
      <aside className="hidden flex-col justify-end bg-card p-8 lg:flex xl:p-10">
        <p className="heading text-display-lg">{statement}</p>
        <p className="mt-4 max-w-md text-muted-foreground">{blurb}</p>
      </aside>

      {/* --- Form column --------------------------------------------------- */}
      <div className="mx-auto flex w-full max-w-md flex-col gap-8 lg:mx-0 lg:justify-center">
        {/*
          Route-driven tabs. The reference draws Sign In / Register as a two-tab
          control with an ink underline on the active one; here they are real links,
          because they are real routes. `end` is not needed — the paths don't nest —
          but the active underline comes from NavLink's own state rather than being
          passed in, so neither page has to know which one it is.
        */}
        <nav aria-label="Account" className="grid grid-cols-2">
          {[
            { to: withNext('/login'), label: 'Sign in' },
            { to: withNext('/register'), label: 'Register' },
          ].map(({ to, label }) => (
            <NavLink
              key={label}
              to={to}
              className={({ isActive }) =>
                cn(
                  'border-b-2 pb-3 text-center text-ui-action transition-colors',
                  isActive
                    ? 'border-foreground text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground'
                )
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>

        {children}
      </div>
    </div>
  );
}
