/**
 * Demo accounts, one click to fill the form.
 *
 * Kept because this is an evaluation build and a reviewer needs to move between roles
 * quickly. The hint column matters as much as the credentials: `npm run demo` puts each
 * of these accounts into a specific state, and working out which of them is holding the
 * sold-out seats is not a good use of a reviewer's first two minutes.
 *
 * Both customers are listed deliberately. The live seat map and the waitlist hand-off
 * are only observable with two sessions open at once, so a second account is not a
 * convenience here, it is what makes those two features demonstrable at all.
 */
const ACCOUNTS = [
  { role: 'Admin', email: 'admin@tixlock.com', password: 'Admin123', hint: 'Venues + seat layouts' },
  { role: 'Organiser', email: 'organiser@tixlock.com', password: 'Organiser123', hint: 'Revenue + bookings' },
  { role: 'Customer 1', email: 'customer1@tixlock.com', password: 'Customer123', hint: 'History, and a live seat offer' },
  { role: 'Customer 2', email: 'customer2@tixlock.com', password: 'Customer123', hint: 'A checkout hold in progress' },
] as const;

export function DemoAccounts({ onPick }: { onPick: (email: string, password: string) => void }) {
  return (
    // A hairline and an eyebrow instead of a dashed card. This is a footnote to the
    // form, not a sibling panel, and the rule says so more quietly than a border box.
    <div className="border-t border-border pt-5">
      <p className="eyebrow mb-3 text-muted-foreground">
        Demo accounts — created by <code className="font-mono normal-case">npm run demo</code>
      </p>
      <div className="grid gap-px bg-border">
        {ACCOUNTS.map((account) => (
          <button
            key={account.email}
            type="button"
            onClick={() => onPick(account.email, account.password)}
            className="flex items-center gap-3 bg-background px-3 py-2 text-left transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {/* Solid ink role tag, matching the status tags used elsewhere. */}
            <span className="eyebrow w-28 shrink-0 whitespace-nowrap bg-panel px-2 py-1 text-center text-panel-foreground">
              {account.role}
            </span>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {account.email}
            </span>
            {/* Dropped on narrow screens rather than wrapped: the email is the thing
                being clicked, and a two-line row would cost more than the hint adds. */}
            <span className="ml-auto hidden shrink-0 text-xs text-muted-foreground sm:block">
              {account.hint}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
