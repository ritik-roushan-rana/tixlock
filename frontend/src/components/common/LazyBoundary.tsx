import { Component, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ErrorState } from './states';

/**
 * Error boundary for lazily loaded routes.
 *
 * Distinct from the router's errorElement, which catches errors thrown *inside* a
 * rendered route. This catches the case where the dynamic `import()` itself fails —
 * which happens in the real world after a redeploy: the running page holds a
 * reference to a chunk filename that no longer exists on the CDN, so navigating
 * produces a module-load failure rather than a render error.
 *
 * A plain reload fixes it, because it re-fetches index.html and the current hashes.
 * Without this boundary the user sees a blank screen with a console error.
 */
interface State {
  error: Error | null;
}

export class LazyBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[lazy-boundary]', error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const looksLikeChunkFailure =
      /dynamically imported module|Loading chunk|Failed to fetch/i.test(error.message);

    return (
      <div className="py-12">
        <ErrorState
          error={
            looksLikeChunkFailure
              ? new Error(
                  'This page could not be loaded. The app was probably updated while your tab was open — reloading will fix it.'
                )
              : error
          }
        />
        <div className="mt-4 flex justify-center">
          <Button onClick={() => window.location.reload()}>
            <RefreshCw /> Reload
          </Button>
        </div>
      </div>
    );
  }
}
