import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, Lock, Pencil, Plus, Save, X } from 'lucide-react';

import { venuesApi } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/client';
import { queryKeys } from '@/lib/queryKeys';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { EmptyState, ErrorState } from '@/components/common/states';
import {
  SeatLayoutEditor,
  makeRow,
  toLayoutPayload,
  validateLayout,
  type EditorRow,
} from '@/components/admin/SeatLayoutEditor';

const DEFAULT_ROWS: EditorRow[] = [
  makeRow({ row_label: 'A', seats: 8, category: 'Premium' }),
  makeRow({ row_label: 'B', seats: 10, category: 'Standard' }),
];

/**
 * Admin: venues and seat layouts.
 *
 * The important behaviour here is the layout lock. Once a venue has any show, its
 * `venue_seats` have been stamped into `show_seats` and the backend refuses further
 * layout changes with a 409. Rather than let an admin build an edit and then lose it
 * to a rejected request, a locked venue is shown as read-only with the reason.
 */
export default function AdminPage() {
  const queryClient = useQueryClient();

  const [editingVenueId, setEditingVenueId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [rows, setRows] = useState<EditorRow[]>(DEFAULT_ROWS);

  const venuesQuery = useQuery({
    queryKey: queryKeys.venues.list(),
    queryFn: venuesApi.list,
  });

  const resetForm = () => {
    setEditingVenueId(null);
    setName('');
    setAddress('');
    setRows(DEFAULT_ROWS.map((row) => makeRow(row)));
  };

  const createMutation = useMutation({
    mutationFn: () =>
      venuesApi.create({ name: name.trim(), address: address.trim(), layout: toLayoutPayload(rows) }),
    onSuccess: (venue) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.venues.all });
      toast.success(`"${venue.name}" created`, {
        description: `${venue.seat_count} seats across ${venue.rows.length} rows.`,
      });
      resetForm();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Could not create the venue'),
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      const venueId = editingVenueId!;
      // Layout first: it is the operation that can be refused, so a 409 leaves the
      // name unchanged rather than half-applying the edit.
      await venuesApi.defineLayout(venueId, toLayoutPayload(rows));
      return venuesApi.update(venueId, { name: name.trim(), address: address.trim() });
    },
    onSuccess: (venue) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.venues.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.venues.detail(venue.id) });
      toast.success(`"${venue.name}" updated`, { description: `${venue.seat_count} seats.` });
      resetForm();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        toast.error('Layout is locked', { description: error.message });
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Could not update the venue');
    },
  });

  const startEdit = async (venueId: number) => {
    try {
      const venue = await queryClient.fetchQuery({
        queryKey: queryKeys.venues.detail(venueId),
        queryFn: () => venuesApi.get(venueId),
      });

      if (venue.locked) {
        toast.error('This layout is frozen', {
          description: `"${venue.name}" already has ${venue.show_count} show${venue.show_count === 1 ? '' : 's'}. Their seats were generated from this layout, so changing it would desynchronise sold tickets. Create a new venue instead.`,
        });
        return;
      }

      setEditingVenueId(venue.id);
      setName(venue.name);
      setAddress(venue.address ?? '');
      setRows(
        venue.rows.map((row) =>
          makeRow({ row_label: row.row_label, seats: row.seats.length, category: row.category })
        )
      );
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load that venue');
    }
  };

  const submit = () => {
    if (!name.trim()) {
      toast.error('Give the venue a name');
      return;
    }
    const problem = validateLayout(rows);
    if (problem) {
      toast.error(problem);
      return;
    }
    if (editingVenueId) updateMutation.mutate();
    else createMutation.mutate();
  };

  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="heading text-display-lg">Venues</h1>
        <p className="text-sm text-muted-foreground">
          Define the physical seats a venue has. Showings generate their inventory from this layout.
        </p>
      </div>

      {/* --- Builder ------------------------------------------------------- */}
      <Card className="border-0 bg-card">
        <CardHeader className="pb-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="heading text-display-sm">
                {editingVenueId ? `Editing "${name}"` : 'New venue'}
              </CardTitle>
              <CardDescription>
                {editingVenueId
                  ? 'Saving replaces the whole layout for this venue.'
                  : 'Create the venue and its seat layout in one step.'}
              </CardDescription>
            </div>
            {editingVenueId ? (
              <Button variant="ghost" size="sm" onClick={resetForm} disabled={saving}>
                <X /> Cancel edit
              </Button>
            ) : null}
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="venue-name">Venue name</Label>
              <Input
                id="venue-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Grand Auditorium"
                maxLength={200}
                disabled={saving}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="venue-address">Address</Label>
              <Input
                id="venue-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="1 Marine Drive, Mumbai"
                maxLength={500}
                disabled={saving}
              />
            </div>
          </div>

          <SeatLayoutEditor rows={rows} onChange={setRows} disabled={saving} />

          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={submit} loading={saving}>
              {editingVenueId ? <Save /> : <Plus />}
              {editingVenueId ? 'Save changes' : 'Create venue'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* --- Existing venues ---------------------------------------------- */}
      <Card className="border-0 bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="eyebrow text-muted-foreground">Existing venues</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {venuesQuery.isError ? (
            <div className="p-4">
              <ErrorState error={venuesQuery.error} onRetry={() => void venuesQuery.refetch()} />
            </div>
          ) : venuesQuery.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : venuesQuery.data && venuesQuery.data.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<Building2 className="h-5 w-5" />}
                title="No venues yet"
                description="Create one above. Organisers cannot list events until a venue has a seat layout."
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Venue</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead className="text-right">Seats</TableHead>
                  <TableHead className="text-right">Tiers</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                  <TableHead>Layout</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {venuesQuery.data?.map((venue) => {
                  // event_count > 0 implies shows may exist; the authoritative
                  // `locked` flag comes from the detail endpoint on edit.
                  const likelyLocked = venue.event_count > 0;

                  return (
                    <TableRow key={venue.id}>
                      <TableCell className="font-medium">{venue.name}</TableCell>
                      <TableCell className="max-w-[16rem] truncate text-sm text-muted-foreground">
                        {venue.address || '—'}
                      </TableCell>
                      <TableCell className="tabular text-right">{venue.seat_count}</TableCell>
                      <TableCell className="tabular text-right">{venue.category_count}</TableCell>
                      <TableCell className="tabular text-right">{venue.event_count}</TableCell>
                      <TableCell>
                        {venue.seat_count === 0 ? (
                          <Badge variant="destructive">No layout</Badge>
                        ) : likelyLocked ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="muted" className="cursor-help">
                                <Lock className="h-3 w-3" /> Frozen
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              Shows exist for this venue. Their seats were generated from this
                              layout, so it can no longer be changed.
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          /*
                            Outline, not `success`. `success` is lime, and this tag
                            renders on most rows — eight lime blocks in one table is
                            exactly the dilution the system's colour rule exists to
                            prevent. "Editable" is also a neutral fact, not a good
                            outcome. Outlined ink states it without shouting.
                          */
                          <Badge variant="outline">Editable</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void startEdit(venue.id)}
                          disabled={saving}
                        >
                          <Pencil /> Edit
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
