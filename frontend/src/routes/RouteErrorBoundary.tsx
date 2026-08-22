import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom';
import { RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/common/states';

/**
 * Catches render-time errors and unmatched-route responses so a thrown exception
 * shows a recoverable screen instead of a blank page.
 */
export function RouteErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();

  const normalised = isRouteErrorResponse(error)
    ? new Error(`${error.status} ${error.statusText}`)
    : error;

  return (
    <div className="container py-16">
      <ErrorState error={normalised} />
      <div className="mt-4 flex justify-center gap-2">
        <Button variant="outline" onClick={() => navigate('/events', { replace: true })}>
          <RotateCcw /> Back to events
        </Button>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    </div>
  );
}
