import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, Loader2, RefreshCw, WifiOff } from 'lucide-react';

import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Shared empty / error / loading presentation.
 *
 * Every data-fetching view in the app routes through these three, so a failed
 * request never renders as a blank panel and an empty result never looks like a
 * bug. Consistency matters more than novelty here.
 */

/* --- Empty --------------------------------------------------------------- */

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    // Flat tonal block, no dashed outline. The surface step is what defines the
    // area; a dashed border on top of it is decoration doing a job already done.
    <Card className={cn('border-0 bg-card', className)}>
      <CardContent className="flex flex-col items-center justify-center gap-4 px-6 py-14 text-center">
        {/* Square icon block, not a circle — 0px radius throughout. */}
        <div className="grid h-11 w-11 place-items-center bg-card-alt text-foreground">
          {icon ?? <Inbox className="h-5 w-5" />}
        </div>
        <div className="space-y-1">
          <p className="heading text-display-sm">{title}</p>
          {description ? (
            <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </CardContent>
    </Card>
  );
}

/* --- Error --------------------------------------------------------------- */

/**
 * Turn a thrown value into a title/description pair.
 *
 * The distinction that matters to a user is "the server said no" versus "I could
 * not reach the server" — the first needs them to change something, the second
 * needs them to retry.
 */
function describeError(error: unknown): { title: string; description: string; offline: boolean } {
  if (error instanceof ApiError) {
    if (error.code === 'NETWORK') {
      return {
        title: 'Cannot reach the server',
        description:
          'The API did not respond. Check your connection, and that the backend is running.',
        offline: true,
      };
    }
    if (error.code === 'TIMEOUT') {
      return {
        title: 'The server took too long',
        description: 'The request timed out. Please try again.',
        offline: true,
      };
    }
    if (error.status === 403) {
      return {
        title: 'Not allowed',
        description: error.message,
        offline: false,
      };
    }
    if (error.status === 404) {
      return { title: 'Not found', description: error.message, offline: false };
    }
    if (error.status >= 500) {
      return {
        title: 'Something went wrong on the server',
        description: error.message,
        offline: false,
      };
    }
    return { title: 'Request failed', description: error.message, offline: false };
  }

  return {
    title: 'Something went wrong',
    description: error instanceof Error ? error.message : 'An unexpected error occurred.',
    offline: false,
  };
}

export function ErrorState({
  error,
  onRetry,
  className,
  compact = false,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
  compact?: boolean;
}) {
  const { title, description, offline } = describeError(error);

  if (compact) {
    return (
      <div
        role="alert"
        className={cn(
          // A 4px error-red left edge on a tonal block, rather than a red-tinted
          // wash with same-hue text. Ink copy on cream reads at 12.95:1; the red is
          // spent on the edge and the icon, where it is a marker and not a
          // legibility problem.
          'flex flex-wrap items-center gap-3 border-l-4 border-destructive bg-card px-3 py-2 text-sm',
          className
        )}
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
        <span>{description}</span>
        {onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry} className="ml-auto">
            <RefreshCw /> Retry
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <Card className={cn('border-0 border-l-4 border-destructive bg-card', className)} role="alert">
      <CardContent className="flex flex-col items-center justify-center gap-4 px-6 py-14 text-center">
        {/* Solid red block carrying a white glyph: 6.17:1, versus the 10%-wash-plus-
            red-icon it replaces, which was under 3:1 against the card. */}
        <div className="grid h-11 w-11 place-items-center bg-destructive text-destructive-foreground">
          {offline ? <WifiOff className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
        </div>
        <div className="space-y-1">
          <p className="heading text-display-sm">{title}</p>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">{description}</p>
        </div>
        {onRetry ? (
          <Button variant="outline" onClick={onRetry}>
            <RefreshCw /> Try again
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* --- Loading ------------------------------------------------------------- */

export function CenteredSpinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span>{label}…</span>
    </div>
  );
}

/** Full-viewport spinner for the initial route-level suspense boundary. */
export function FullPageSpinner() {
  return (
    <div className="flex min-h-[60dvh] items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
