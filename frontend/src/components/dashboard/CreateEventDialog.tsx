import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';

import { eventsApi, venuesApi } from '@/lib/api/endpoints';
import { queryKeys } from '@/lib/queryKeys';
import { EVENT_TYPES } from '@/lib/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const schema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  type: z.enum(['movie', 'concert']),
  venue_id: z.coerce.number().int().positive('Choose a venue'),
  description: z.string().max(2000).optional(),
});

type FormValues = z.infer<typeof schema>;

/**
 * Create an event.
 *
 * The venue picker disables venues with no seat layout. The API rejects those with a
 * 409 anyway — an event at a venue with no seats would generate shows with zero
 * inventory — so surfacing the reason in the option label is clearer than letting
 * the request fail.
 */
export function CreateEventDialog() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const venuesQuery = useQuery({
    queryKey: queryKeys.venues.list(),
    queryFn: venuesApi.list,
    enabled: open,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { title: '', type: 'movie', description: '' },
  });

  const mutation = useMutation({
    mutationFn: eventsApi.create,
    onSuccess: (event) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.events.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
      toast.success(`"${event.title}" created`, {
        description: 'Add a showing to make it bookable.',
      });
      form.reset({ title: '', type: 'movie', description: '' });
      setOpen(false);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Could not create the event'),
  });

  const usableVenues = (venuesQuery.data ?? []).filter((venue) => venue.seat_count > 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> New event
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create an event</DialogTitle>
          <DialogDescription>
            An event holds one or more showings. You add showings and pricing next.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            id="create-event-form"
            onSubmit={form.handleSubmit((values) =>
              mutation.mutate({
                title: values.title,
                type: values.type,
                venue_id: values.venue_id,
                description: values.description || undefined,
              })
            )}
            className="space-y-4"
            noValidate
          >
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title</FormLabel>
                  <FormControl>
                    <Input placeholder="Dune: Part Three" autoFocus {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {EVENT_TYPES.map((type) => (
                          <SelectItem key={type} value={type} className="capitalize">
                            {type}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="venue_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Venue</FormLabel>
                    <Select
                      value={field.value ? String(field.value) : undefined}
                      onValueChange={field.onChange}
                      disabled={venuesQuery.isLoading}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue
                            placeholder={venuesQuery.isLoading ? 'Loading…' : 'Choose a venue'}
                          />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(venuesQuery.data ?? []).map((venue) => (
                          <SelectItem
                            key={venue.id}
                            value={String(venue.id)}
                            disabled={venue.seat_count === 0}
                          >
                            {venue.name}
                            {venue.seat_count === 0
                              ? ' — no seat layout'
                              : ` — ${venue.seat_count} seats`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {usableVenues.length === 0 && !venuesQuery.isLoading ? (
                      <FormDescription className="text-warning">
                        No venue has a seat layout yet. An admin must define one first.
                      </FormDescription>
                    ) : null}
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea rows={3} placeholder="Optional blurb shown to customers." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" form="create-event-form" loading={mutation.isPending}>
            Create event
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
