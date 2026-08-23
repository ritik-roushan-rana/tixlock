import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Loader2, Plus } from 'lucide-react';

import { eventsApi, venuesApi } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/client';
import { queryKeys } from '@/lib/queryKeys';
import { todayIsoDate } from '@/lib/datetime';
import { EVENT_TYPES, type EventType, type PricingMap } from '@/lib/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
  title: string;
  type: EventType;
  venueId: string;
  description: string;
  date: string;
  time: string;
  /** category name -> price as a string, because inputs hold strings. */
  pricing: Record<string, string>;
}

const TYPE_LABEL: Record<EventType, string> = { movie: 'Movie', concert: 'Concert / Event' };

/**
 * Create an event — the organiser's whole first-run flow in one form.
 *
 * This used to create only the event row, leaving "New showing" as a separate top-level
 * action the organiser had to find and complete before anything was bookable. That
 * exposed an internal distinction as a workflow step: a showing is a domain concept, a
 * *listing* is what an organiser sets out to publish. Worse, the two halves lived on
 * different screens, so the natural reading was that the job was finished after step
 * one, and the event sat unbookable.
 *
 * So the form now collects the date, time and per-category pricing too, and the API
 * creates the event, its first showing, that showing's seats and its pricing in one
 * transaction. The event/showing split is untouched underneath — additional showings
 * are added later from the event's own page, which is where that relationship belongs
 * and becomes visible.
 *
 * Pricing fields are generated from the chosen venue's real categories, never typed
 * freely: the API requires the map to cover exactly those categories and rejects both
 * gaps and inventions, so deriving the fields makes the valid input the only input.
 */
export function CreateEventDialog({ trigger }: { trigger?: React.ReactNode } = {}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const form = useForm<FormShape>({
    defaultValues: {
      title: '',
      type: 'movie',
      venueId: '',
      description: '',
      date: '',
      time: '19:30',
      pricing: {},
    },
  });

  const venuesQuery = useQuery({
    queryKey: queryKeys.venues.list(),
    queryFn: venuesApi.list,
    enabled: open,
  });

  const venueId = Number(form.watch('venueId'));
  const selectedVenue = (venuesQuery.data ?? []).find((venue) => venue.id === venueId);

  // The layout — and therefore the category list — only exists on the venue detail.
  const venueDetailQuery = useQuery({
    queryKey: queryKeys.venues.detail(venueId || 0),
    queryFn: () => venuesApi.get(venueId),
    enabled: open && venueId > 0,
  });

  const categories = useMemo(() => venueDetailQuery.data?.categories ?? [], [venueDetailQuery.data]);

  // Seed one blank price field per category whenever the venue changes.
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
      for (const [category, raw] of Object.entries(values.pricing)) pricing[category] = Number(raw);

      return eventsApi.create({
        title: values.title.trim(),
        type: values.type,
        venue_id: Number(values.venueId),
        description: values.description.trim() || undefined,
        first_show: { date: values.date, time: values.time, pricing },
      });
    },
    onSuccess: ({ event, show }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.events.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
      // Says what actually happened, so the organiser knows the listing is live rather
      // than guessing whether another step is owed. The two cases must not be conflated:
      // claiming "bookable" for an event with no showing would be a lie.
      if (show) {
        toast.success(`"${event.title}" is now bookable`, {
          description: `First showing added — ${show.seats_created} seats generated from the venue layout.`,
        });
      } else {
        toast.success(`"${event.title}" created`, {
          description: 'Add a showing to make it bookable.',
        });
      }
      form.reset({
        title: '',
        type: 'movie',
        venueId: '',
        description: '',
        date: '',
        time: '19:30',
        pricing: {},
      });
      setOpen(false);
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        const missing = error.details?.missingCategories;
        if (missing?.length) {
          toast.error('Pricing incomplete', { description: `Missing: ${missing.join(', ')}` });
          return;
        }
        toast.error(error.message);
        return;
      }
      toast.error('Could not create the event');
    },
  });

  const onSubmit = (values: FormShape) => {
    if (!values.title.trim()) return toast.error('Give the event a title');
    if (!values.venueId) return toast.error('Choose a venue');
    if (!values.date) return toast.error('Choose a date for the first showing');
    if (categories.length === 0) {
      return toast.error('That venue has no seat layout, so nothing can be scheduled there');
    }
    const unpriced = Object.entries(values.pricing).filter(
      ([, price]) => price === '' || Number.isNaN(Number(price)) || Number(price) < 0
    );
    if (unpriced.length > 0) {
      return toast.error('Every category needs a price', {
        description: unpriced.map(([category]) => category).join(', '),
      });
    }
    mutation.mutate(values);
  };

  const usableVenues = (venuesQuery.data ?? []).filter((venue) => venue.seat_count > 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <Plus /> New event
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create new event</DialogTitle>
          <DialogDescription>
            Sets up the listing and its first showing. Seats are generated from the venue's
            layout, and you can add more showings afterwards.
          </DialogDescription>
        </DialogHeader>

        <form id="create-event-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="event-title">Title</Label>
            <Input id="event-title" placeholder="Dune: Part Three" autoFocus {...form.register('title')} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="event-type">Type</Label>
              <Select
                value={form.watch('type')}
                onValueChange={(value) => form.setValue('type', value as EventType)}
              >
                <SelectTrigger id="event-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {TYPE_LABEL[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="event-venue">Venue</Label>
              <Select
                value={form.watch('venueId') || undefined}
                onValueChange={(value) => form.setValue('venueId', value)}
                disabled={venuesQuery.isLoading}
              >
                <SelectTrigger id="event-venue">
                  <SelectValue placeholder={venuesQuery.isLoading ? 'Loading…' : 'Choose a venue'} />
                </SelectTrigger>
                <SelectContent>
                  {(venuesQuery.data ?? []).map((venue) => (
                    /* A venue with no layout is shown but not selectable: the API
                       refuses it anyway, and naming the reason beats a failed submit. */
                    <SelectItem
                      key={venue.id}
                      value={String(venue.id)}
                      disabled={venue.seat_count === 0}
                    >
                      {venue.name}
                      {venue.seat_count === 0 ? ' — no seat layout' : ` — ${venue.seat_count} seats`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {usableVenues.length === 0 && !venuesQuery.isLoading ? (
                <p className="text-xs text-warning">
                  No venue has a seat layout yet. An admin must configure one first.
                </p>
              ) : null}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="event-description">Description</Label>
            <Textarea
              id="event-description"
              rows={2}
              placeholder="Optional blurb shown to customers."
              {...form.register('description')}
            />
          </div>

          {/* --- First showing ------------------------------------------------
              Same form, because a listing without a date is not something a
              customer can act on. Additional showings live on the event page. */}
          <div className="border-t border-border pt-4">
            <p className="eyebrow mb-3 text-muted-foreground">First showing</p>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="event-date">Date</Label>
                <Input id="event-date" type="date" min={todayIsoDate()} {...form.register('date')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="event-time">Time</Label>
                <Input id="event-time" type="time" {...form.register('time')} />
              </div>
            </div>

            <div className="mt-4 space-y-2">
              <Label>Price per category</Label>
              {!selectedVenue ? (
                <p className="text-xs text-muted-foreground">
                  Pick a venue to see its seat categories.
                </p>
              ) : venueDetailQuery.isLoading ? (
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
          </div>
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="create-event-form"
            loading={mutation.isPending}
            disabled={categories.length === 0}
          >
            Create event
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
