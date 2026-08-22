import { NavLink } from 'react-router-dom';
import { Compass } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/states';

export default function NotFoundPage() {
  return (
    <div className="mx-auto max-w-lg py-12">
      <EmptyState
        icon={<Compass className="h-5 w-5" />}
        title="Page not found"
        description="That link does not lead anywhere. It may have moved, or never existed."
        action={
          <Button asChild>
            <NavLink to="/events">Browse events</NavLink>
          </Button>
        }
      />
    </div>
  );
}
