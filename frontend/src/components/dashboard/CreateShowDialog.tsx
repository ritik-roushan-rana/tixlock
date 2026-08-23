import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { CalendarPlus, Loader2 } from 'lucide-react';

import { eventsApi, venuesApi } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/client';
import { queryKeys } from '@/lib/queryKeys';
import { todayIsoDate } from '@/lib/datetime';
import type { EventListItem, PricingMap } from '@/lib/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface FormShape {
  eventId: string;
  date: string;
  time: string;
  /** category name -> price as a string, because inputs hold strings. */
  pricing: Record<string, string>;
}

/**
 * Create a showing.
 *
 * The pricing inputs are generated from the selected event's *venue* categories,
 * fetched on demand. This is not cosmetic: the API requires the pricing map to cover
 * exactly the venue's categories and rejects both missing and unknown ones, so
 * free-text category entry would mostly produce 400s. Deriving the fields from the
 * venue makes the valid input the only input.
 */
export function CreateShowDialog({
  events,
  defaultEventId,
  trigger,
  /**
   * Render the event as fixed context instead of a picker.
   *
   * Used from an event's own page, where the event is already the subject of the
   * screen — asking the organiser to select it again from a dropdown invites picking
   * the wrong one, and reads as though this dialog belongs to the dashboard rather
   * than to the event they are looking at.
   */
  lockEvent = false,
}: {
  events: EventListItem[];
  defaultEventId?: number;
  trigger?: React.ReactNode;
  lockEvent?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const form = useForm<FormShape>({
    defaultValues: {
      eventId: defaultEventId ? String(defaultEventId) : '',
      date: '',
      time: '19:30',
      pricing: {},
    },
  });

  const eventId = Number(form.watch('eventId'));
  const selectedEvent = events.find((event) => event.id === eventId);

  // Only fetch the venue once an event is chosen; its categories drive the form.
  const venueQuery = useQuery({
    queryKey: queryKeys.venues.detail(selectedEvent?.venue_id ?? 0),
    queryFn: () => venuesApi.get(selectedEvent!.venue_id),
    enabled: open && Boolean(selectedEvent?.venue_id),
  });

  const categories = useMemo(() => venueQuery.data?.categories ?? [], [venueQuery.data]);

  // Seed a blank price field per category whenever the category set changes.
  useEffect(() => {
    if (categories.length === 0) return;
    const current = form.getValues('pricing');
    const next: Record<string, string> = {};
    for (const category of categories) next[category] = current[category] ?? '';
    form.setValue('pricing', next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories.join('|')]);

  const mutation = useMutation({
    mutationFn: async (values: FormShape) => {
      const pricing: PricingMap = {};
      for (const [category, raw] of Object.entries(values.pricing)) {
        pricing[category] = Number(raw);
      }
      return eventsApi.createShow(Number(values.eventId), {
        date: values.date,
        time: values.time,
        pricing,
      });
    },
    onSuccess: (show) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.events.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
      toast.success('Showing created', {
        description: `${show.seats_created} seats generated from the venue layout.`,
      });
      form.setValue('date', '');
      setOpen(false);
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        // The server names exactly which categories are missing or unknown.
        const missing = error.details?.missingCategories;
        if (missing?.length) {
          toast.error('Pricing incomplete', { description: `Missing: ${missing.join(', ')}` });
          return;
        }
        toast.error(error.message);
        return;
      }
      toast.error('Could not create the showing');
    },
  });

  const onSubmit = (values: FormShape) => {
    if (!values.eventId) {
      toast.error('Choose an event');
      return;
    }
    if (!values.date) {
      toast.error('Choose a date');
      return;
    }
    const unpriced = Object.entries(values.pricing).filter(
      ([, price]) => price === '' || Number.isNaN(Number(price)) || Number(price) < 0
    );
    if (unpriced.length > 0 || Object.keys(values.pricing).length === 0) {
      toast.error('Every category needs a price', {
        description: unpriced.map(([category]) => category).join(', ') || undefined,
      });
      return;
    }
    mutation.mutate(values);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline">
            <CalendarPlus /> New showing
          </Button>
        )}
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a showing</DialogTitle>
          <DialogDescription>
            Seats are generated automatically from the venue's layout when the showing is created.
          </DialogDescription>
        </DialogHeader>

        <form
          id="create-show-form"
          onSubmit={form.handleSubmit(onSubmit)}
          className="space-y-4"
          noValidate
        >
          {lockEvent ? (
            /* Contextual: the event and its venue are stated, not chosen. Both are
               fixed by where the dialog was opened from. */
            <div className="grid gap-3 border border-border-strong bg-background p-3 sm:grid-cols-2">
              <div className="min-w-0">
                <p className="eyebrow text-muted-foreground">Event</p>
                <p className="truncate text-sm font-semibold">
                  {selectedEvent?.title ?? '—'}
                </p>
              </div>
              <div className="min-w-0">
                <p className="eyebrow text-muted-foreground">Venue</p>
                <p className="truncate text-sm font-semibold">
                  {selectedEvent?.venue_name ?? venueQuery.data?.name ?? '—'}
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="show-event">Event</Label>
              <Select
                value={form.watch('eventId') || undefined}
                onValueChange={(value) => form.setValue('eventId', value)}
              >
                <SelectTrigger id="show-event">
                  <SelectValue placeholder="Choose an event" />
                </SelectTrigger>
                <SelectContent>
                  {events.map((event) => (
                    <SelectItem key={event.id} value={String(event.id)}>
                      {event.title} — {event.venue_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {events.length === 0 ? (
                <p className="text-xs text-warning">Create an event first.</p>
              ) : null}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="show-date">Date</Label>
              <Input
                id="show-date"
                type="date"
                min={todayIsoDate()}
                {...form.register('date')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="show-time">Time</Label>
              <Input id="show-time" type="time" {...form.register('time')} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Price per category</Label>
            {!selectedEvent ? (
              <p className="text-xs text-muted-foreground">
                Pick an event to see its venue's seat categories.
              </p>
            ) : venueQuery.isLoading ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading categories…
              </p>
            ) : categories.length === 0 ? (
              <p className="text-xs text-destructive">
                This venue has no seat layout, so a showing cannot be created.
              </p>
            ) : (
              <div className="space-y-2">
                {categories.map((category) => (
                  <div key={category} className="flex items-center gap-3">
                    <span className="w-28 shrink-0 truncate text-sm text-muted-foreground">
                      {category}
                    </span>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      placeholder="0.00"
                      aria-label={`Price for ${category}`}
                      {...form.register(`pricing.${category}` as const)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="create-show-form"
            loading={mutation.isPending}
            disabled={categories.length === 0}
          >
            Create showing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
