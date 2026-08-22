import { useMemo, useState } from 'react';
import { Copy, Eraser, Grid3x3, Plus, Trash2, Wand2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { LayoutRowSpec } from '@/lib/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Visual seat layout editor.
 *
 * ==========================================================================
 * WHY A GRID EDITOR AND NOT A ROW FORM
 * ==========================================================================
 *
 * The layout defines physical seats and is *frozen* the moment any show exists for
 * the venue, because show_seats rows are stamped from it and carry a foreign key
 * back. There is no second chance to fix a mistake, so getting it right first time
 * matters more than usual.
 *
 * A row-spec form ("row A, 10 seats, Premium") makes you hold the whole auditorium
 * in your head. This editor renders the actual grid and lets you paint categories
 * onto individual seats, so the thing you are approving is the thing you will get.
 *
 * ==========================================================================
 * THE ONE CONSTRAINT THAT SHAPES THIS COMPONENT
 * ==========================================================================
 *
 * The API models a layout as `[{ row_label, seats, category }]` — one category per
 * row, and rows are always numbered 1..n. So per-seat categories cannot be
 * represented. Rather than pretend otherwise, painting a seat sets the category for
 * its whole row, and the UI says so. Committing to the real data model beats
 * building an editor whose output cannot be saved.
 */

export interface EditorRow {
  /** Stable key so React does not remount rows when labels change. */
  key: string;
  row_label: string;
  seats: number;
  category: string;
}

/**
 * Tier swatches — a monochrome ink ramp, lightest tier first.
 *
 * Was six saturated hues (violet, green, amber, sky, pink, orange). In this system
 * colour is a functional signal reserved for lime / cobalt / error, so six decorative
 * hues would drown the three that change what a user can do. Tiers are distinguished
 * tonally instead, which is the same call already made for the customer-facing seat
 * map so the two views agree.
 *
 * `fg` is carried alongside `bg` rather than using a single `text-white/90` for all
 * of them: white on the lightest swatch was illegible, and the ramp crosses the point
 * where the readable text colour flips. Every pair here clears 4.5:1.
 */
const CATEGORY_PALETTE: Array<{ bg: string; fg: string }> = [
  { bg: '#ffffff', fg: '#1a1c19' },
  { bg: '#dcdcd7', fg: '#1a1c19' },
  { bg: '#b9b9b4', fg: '#1a1c19' },
  { bg: '#969691', fg: '#1a1c19' },
  { bg: '#6e6e6a', fg: '#fafaf5' },
  { bg: '#3d3d3a', fg: '#fafaf5' },
];

const ROW_LABELS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');

let keyCounter = 0;
const nextKey = () => `row-${++keyCounter}`;

export function makeRow(partial: Partial<EditorRow> = {}): EditorRow {
  return {
    key: nextKey(),
    row_label: partial.row_label ?? 'A',
    seats: partial.seats ?? 10,
    category: partial.category ?? 'Standard',
  };
}

/** Presets, because most venues are one of a few shapes. */
const PRESETS: Array<{ name: string; description: string; rows: Omit<EditorRow, 'key'>[] }> = [
  {
    name: 'Small cinema',
    description: '46 seats · 2 tiers',
    rows: [
      { row_label: 'A', seats: 8, category: 'Premium' },
      { row_label: 'B', seats: 8, category: 'Premium' },
      { row_label: 'C', seats: 10, category: 'Standard' },
      { row_label: 'D', seats: 10, category: 'Standard' },
      { row_label: 'E', seats: 10, category: 'Standard' },
    ],
  },
  {
    name: 'Theatre',
    description: '120 seats · 3 tiers',
    rows: [
      { row_label: 'A', seats: 12, category: 'VIP' },
      { row_label: 'B', seats: 12, category: 'VIP' },
      { row_label: 'C', seats: 14, category: 'Premium' },
      { row_label: 'D', seats: 14, category: 'Premium' },
      { row_label: 'E', seats: 14, category: 'Premium' },
      { row_label: 'F', seats: 18, category: 'Standard' },
      { row_label: 'G', seats: 18, category: 'Standard' },
      { row_label: 'H', seats: 18, category: 'Standard' },
    ],
  },
  {
    name: 'Arena block',
    description: '200 seats · 2 tiers',
    rows: Array.from({ length: 10 }, (_, i) => ({
      row_label: ROW_LABELS[i]!,
      seats: 20,
      category: i < 3 ? 'Floor' : 'Stand',
    })),
  },
];

export function SeatLayoutEditor({
  rows,
  onChange,
  disabled = false,
}: {
  rows: EditorRow[];
  onChange: (rows: EditorRow[]) => void;
  disabled?: boolean;
}) {
  const [activeCategory, setActiveCategory] = useState<string>('Standard');
  const [newCategory, setNewCategory] = useState('');

  const categories = useMemo(() => {
    const found = [...new Set(rows.map((row) => row.category).filter(Boolean))];
    // Always include whatever is selected, so a freshly added category is paintable
    // before it has been applied to any row.
    if (activeCategory && !found.includes(activeCategory)) found.push(activeCategory);
    return found;
  }, [rows, activeCategory]);

  const colourFor = (category: string) => {
    const index = categories.indexOf(category);
    return CATEGORY_PALETTE[(index < 0 ? 0 : index) % CATEGORY_PALETTE.length]!;
  };

  /** Swatch style: the tonal fill plus a hairline, so white stays visible on cream. */
  const swatchStyle = (category: string) => ({
    backgroundColor: colourFor(category).bg,
    outline: '1px solid hsl(var(--border))',
    outlineOffset: '-1px',
  });

  const totalSeats = rows.reduce((sum, row) => sum + (Number.isFinite(row.seats) ? row.seats : 0), 0);

  const perCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.category, (map.get(row.category) ?? 0) + row.seats);
    }
    return [...map.entries()];
  }, [rows]);

  const duplicateLabels = useMemo(() => {
    const labels = rows.map((row) => row.row_label.trim().toUpperCase()).filter(Boolean);
    return [...new Set(labels.filter((label, i) => labels.indexOf(label) !== i))];
  }, [rows]);

  const update = (key: string, patch: Partial<EditorRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const addRow = () => {
    const used = new Set(rows.map((row) => row.row_label.toUpperCase()));
    const label = ROW_LABELS.find((candidate) => !used.has(candidate)) ?? '';
    const last = rows[rows.length - 1];
    onChange([
      ...rows,
      makeRow({ row_label: label, seats: last?.seats ?? 10, category: last?.category ?? activeCategory }),
    ]);
  };

  const duplicateRow = (key: string) => {
    const source = rows.find((row) => row.key === key);
    if (!source) return;
    const used = new Set(rows.map((row) => row.row_label.toUpperCase()));
    const label = ROW_LABELS.find((candidate) => !used.has(candidate)) ?? '';
    const index = rows.findIndex((row) => row.key === key);
    const copy = makeRow({ ...source, row_label: label });
    onChange([...rows.slice(0, index + 1), copy, ...rows.slice(index + 1)]);
  };

  return (
    <div className="space-y-4">
      {/* --- Category palette --------------------------------------------- */}
      <div className="space-y-2">
        <Label>Categories</Label>
        <div className="flex flex-wrap items-center gap-2">
          {categories.map((category) => (
            <button
              key={category}
              type="button"
              disabled={disabled}
              onClick={() => setActiveCategory(category)}
              className={cn(
                'inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs font-medium transition-all',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                // Selection is a cobalt left edge, per the spec's selection state.
                activeCategory === category
                  ? 'border-border-strong border-l-4 border-l-cobalt bg-card-alt'
                  : 'border-border hover:bg-card-alt'
              )}
            >
              <span
                className="h-2.5 w-2.5"
                style={swatchStyle(category)}
                aria-hidden
              />
              {category}
            </button>
          ))}

          <div className="flex items-center gap-1">
            <Input
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newCategory.trim()) {
                  e.preventDefault();
                  setActiveCategory(newCategory.trim());
                  setNewCategory('');
                }
              }}
              placeholder="Add tier…"
              className="h-7 w-28 text-xs"
              maxLength={50}
              disabled={disabled}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              disabled={disabled || !newCategory.trim()}
              onClick={() => {
                setActiveCategory(newCategory.trim());
                setNewCategory('');
              }}
            >
              <Plus />
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Click a tier to select it, then click seats to assign that tier.
        </p>
      </div>

      <Separator />

      {/* --- The grid ------------------------------------------------------ */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label>Layout</Label>
          <span className="tabular text-xs text-muted-foreground">
            {totalSeats} seat{totalSeats === 1 ? '' : 's'} · {rows.length} row
            {rows.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="border border-border-strong bg-card p-3">
          <div className="mx-auto mb-3 max-w-xs">
            {/* Solid ink slab, not a fading gradient — same marker the customer-facing
                seat map uses, so the admin previews what they will ship. */}
            <div className="bg-panel py-1">
              <p className="eyebrow text-center text-panel-foreground">Screen / Stage</p>
            </div>
          </div>

          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No rows yet. Add one, or start from a preset below.
            </p>
          ) : (
            <div className="space-y-1.5 overflow-x-auto scrollbar-thin pb-1">
              {rows.map((row) => (
                <div key={row.key} className="flex min-w-max items-center gap-2">
                  {/* Row controls */}
                  <Input
                    value={row.row_label}
                    onChange={(e) => update(row.key, { row_label: e.target.value.toUpperCase() })}
                    className={cn(
                      'h-7 w-12 shrink-0 px-1 text-center text-xs font-semibold',
                      duplicateLabels.includes(row.row_label.trim().toUpperCase()) &&
                        'border-destructive'
                    )}
                    maxLength={10}
                    aria-label={`Label for row ${row.row_label}`}
                    disabled={disabled}
                  />

                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={row.seats}
                    onChange={(e) => {
                      // Clamp to the API's own limits (1..100) so the request cannot
                      // be rejected for a value the UI allowed.
                      const raw = Number(e.target.value);
                      const clamped = Number.isFinite(raw) ? Math.min(100, Math.max(1, raw)) : 1;
                      update(row.key, { seats: clamped });
                    }}
                    className="h-7 w-16 shrink-0 px-1 text-center text-xs"
                    aria-label={`Seat count for row ${row.row_label}`}
                    disabled={disabled}
                  />

                  {/* Seats — clicking paints the active category onto the row */}
                  <div className="flex gap-1">
                    {Array.from({ length: Math.min(row.seats, 40) }).map((_, index) => (
                      <button
                        key={index}
                        type="button"
                        disabled={disabled}
                        title={`${row.row_label}${index + 1} · ${row.category} — click to set this row to ${activeCategory}`}
                        aria-label={`Seat ${row.row_label}${index + 1}, currently ${row.category}. Click to assign ${activeCategory}.`}
                        onClick={() => update(row.key, { category: activeCategory })}
                        // 24px, not 20px: these are real click targets (each one
                        // repaints the row's category), so WCAG 2.5.8's 24px minimum
                        // applies to them exactly as it does to the customer seat map.
                        className={cn(
                          'h-6 w-6 shrink-0 text-[9px] font-bold transition-transform',
                          !disabled && 'hover:scale-125'
                        )}
                        style={{
                          backgroundColor: colourFor(row.category).bg,
                          color: colourFor(row.category).fg,
                          outline: '1px solid hsl(var(--border))',
                          outlineOffset: '-1px',
                        }}
                      >
                        {index + 1 <= 9 ? index + 1 : ''}
                      </button>
                    ))}
                    {row.seats > 40 ? (
                      <span className="self-center pl-1 text-[10px] text-muted-foreground">
                        +{row.seats - 40}
                      </span>
                    ) : null}
                  </div>

                  <div className="ml-1 flex shrink-0 items-center gap-0.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => duplicateRow(row.key)}
                          disabled={disabled}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Duplicate row</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10"
                          onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
                          disabled={disabled}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Remove row</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {duplicateLabels.length > 0 ? (
          <p className="text-xs font-medium text-destructive">
            Duplicate row label{duplicateLabels.length === 1 ? '' : 's'}:{' '}
            {duplicateLabels.join(', ')}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={addRow} disabled={disabled}>
            <Plus /> Add row
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange([])}
            disabled={disabled || rows.length === 0}
          >
            <Eraser /> Clear
          </Button>
        </div>
      </div>

      {/* --- Presets ------------------------------------------------------- */}
      <div className="space-y-2">
        <Label className="flex items-center gap-1.5">
          <Wand2 className="h-3 w-3" /> Start from a preset
        </Label>
        <div className="grid gap-2 sm:grid-cols-3">
          {PRESETS.map((preset) => (
            <button
              key={preset.name}
              type="button"
              disabled={disabled}
              onClick={() => {
                onChange(preset.rows.map((row) => makeRow(row)));
                setActiveCategory(preset.rows[0]?.category ?? 'Standard');
              }}
              className="border border-border-strong p-2.5 text-left transition-colors hover:bg-card-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                <Grid3x3 className="h-3.5 w-3.5 text-muted-foreground" />
                {preset.name}
              </p>
              <p className="text-xs text-muted-foreground">{preset.description}</p>
            </button>
          ))}
        </div>
      </div>

      {/* --- Summary ------------------------------------------------------- */}
      {perCategory.length > 0 ? (
        <Card className="border-0 bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="eyebrow text-muted-foreground">Summary</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {perCategory.map(([category, count]) => (
              <Badge key={category} variant="secondary" className="gap-1.5">
                <span
                  className="h-2.5 w-2.5"
                  style={swatchStyle(category)}
                  aria-hidden
                />
                {category}: {count}
              </Badge>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/** Convert editor rows to the API's layout payload, dropping incomplete rows. */
export function toLayoutPayload(rows: EditorRow[]): LayoutRowSpec[] {
  return rows
    .map((row) => ({
      row_label: row.row_label.trim(),
      seats: Math.min(100, Math.max(1, Math.round(row.seats))),
      category: row.category.trim(),
    }))
    .filter((row) => row.row_label !== '' && row.category !== '' && Number.isFinite(row.seats));
}

/** Validate before sending, mirroring the server's own rules. */
export function validateLayout(rows: EditorRow[]): string | null {
  const payload = toLayoutPayload(rows);
  if (payload.length === 0) return 'Add at least one row with a label, seat count and category.';
  if (payload.length > 100) return 'A layout can have at most 100 rows.';

  const labels = payload.map((row) => row.row_label.toUpperCase());
  const duplicates = [...new Set(labels.filter((label, i) => labels.indexOf(label) !== i))];
  if (duplicates.length > 0) return `Duplicate row label(s): ${duplicates.join(', ')}`;

  return null;
}
