import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { formatMoney, formatMoneyCompact, toMoney } from '@/lib/money';
import type { DashboardEventRow, EventReportShow } from '@/lib/api/types';
import { formatDateShort, formatTime } from '@/lib/datetime';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Charts for the organiser dashboard.
 *
 * Every value passed to recharts goes through `toMoney()` first: the API sends
 * money as NUMERIC strings, and recharts silently renders a string axis value as a
 * category rather than a number, which produces a chart that looks plausible but is
 * ordered alphabetically. Coercing at the boundary avoids that.
 */

const TOOLTIP_STYLE = {
  backgroundColor: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 'var(--radius)',
  fontSize: 12,
  color: 'hsl(var(--popover-foreground))',
} as const;

/** Revenue per event, highest first. */
export function RevenueByEventChart({ events }: { events: DashboardEventRow[] }) {
  const data = useMemo(
    () =>
      events
        .map((event) => ({
          name: event.title.length > 22 ? `${event.title.slice(0, 22)}…` : event.title,
          fullName: event.title,
          revenue: toMoney(event.revenue),
          sold: event.booked_seats,
        }))
        .filter((row) => row.revenue > 0 || row.sold > 0)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 8),
    [events]
  );

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="eyebrow text-muted-foreground">Revenue by event</CardTitle>
          <CardDescription>Confirmed bookings only.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="py-12 text-center text-sm text-muted-foreground">
            No sales yet. Revenue appears here once a booking is confirmed.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="eyebrow text-muted-foreground">Revenue by event</CardTitle>
        <CardDescription>Confirmed bookings only — cancellations excluded.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                stroke="hsl(var(--border))"
                interval={0}
                angle={data.length > 4 ? -20 : 0}
                textAnchor={data.length > 4 ? 'end' : 'middle'}
                height={data.length > 4 ? 56 : 30}
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                stroke="hsl(var(--border))"
                tickFormatter={(value: number) => formatMoneyCompact(value)}
                width={56}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value: number) => [formatMoney(value), 'Revenue']}
                labelFormatter={(_label, payload) => payload?.[0]?.payload?.fullName ?? ''}
                cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
              />
              <Bar dataKey="revenue" fill="hsl(var(--primary))" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

/** Seats sold vs remaining per event — an occupancy read rather than a money read. */
export function OccupancyByEventChart({ events }: { events: DashboardEventRow[] }) {
  const data = useMemo(
    () =>
      events
        .map((event) => ({
          name: event.title.length > 22 ? `${event.title.slice(0, 22)}…` : event.title,
          fullName: event.title,
          Sold: event.booked_seats,
          Held: event.pending_seats,
          Available: event.available_seats,
        }))
        .slice(0, 8),
    [events]
  );

  if (data.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="eyebrow text-muted-foreground">Seat occupancy</CardTitle>
        <CardDescription>Across every showing of each event.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                stroke="hsl(var(--border))"
                interval={0}
                angle={data.length > 4 ? -20 : 0}
                textAnchor={data.length > 4 ? 'end' : 'middle'}
                height={data.length > 4 ? 56 : 30}
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                stroke="hsl(var(--border))"
                width={40}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                labelFormatter={(_label, payload) => payload?.[0]?.payload?.fullName ?? ''}
                cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
              />
              {/*
                Recharts colours each legend label with its series' fill. "Available"
                is a tonal step (--card-alt, a near-cream #e3e3de), which is right for
                the bar but rendered the *label* at 1.11:1 on the card — effectively
                invisible. The formatter puts the text back to ink; the swatch beside
                it still shows the true fill, so the mapping is unambiguous.
              */}
              <Legend
                wrapperStyle={{ fontSize: 12 }}
                formatter={(value) => (
                  <span style={{ color: 'hsl(var(--foreground))' }}>{value}</span>
                )}
              />
              <Bar dataKey="Sold" stackId="seats" fill="hsl(var(--primary))" />
              <Bar dataKey="Held" stackId="seats" fill="hsl(var(--cobalt))" />
              {/* A 1px ink stroke, because this fill is nearly the card colour and
                  without an edge the "available" segment has no visible boundary. */}
              <Bar
                dataKey="Available"
                stackId="seats"
                fill="hsl(var(--card-alt))"
                stroke="hsl(var(--border))"
                strokeWidth={1}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

/** Per-showing revenue for a single event, in schedule order. */
export function ShowRevenueChart({ shows }: { shows: EventReportShow[] }) {
  const data = useMemo(
    () =>
      shows.map((show) => ({
        name: `${formatDateShort(show.date)} ${formatTime(show.time)}`,
        revenue: toMoney(show.revenue),
        occupancy: toMoney(show.occupancy_pct),
      })),
    [shows]
  );

  if (data.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="eyebrow text-muted-foreground">Revenue per showing</CardTitle>
        <CardDescription>Bar shading reflects how full each showing is.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                stroke="hsl(var(--border))"
                interval={0}
                angle={data.length > 3 ? -20 : 0}
                textAnchor={data.length > 3 ? 'end' : 'middle'}
                height={data.length > 3 ? 52 : 30}
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                stroke="hsl(var(--border))"
                tickFormatter={(value: number) => formatMoneyCompact(value)}
                width={56}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value: number, key) =>
                  key === 'revenue' ? [formatMoney(value), 'Revenue'] : [`${value}%`, 'Occupancy']
                }
                cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
              />
              <Bar dataKey="revenue">
                {data.map((row, index) => (
                  <Cell
                    key={index}
                    fill="hsl(var(--primary))"
                    // Fuller showings read as more solid, so the bar encodes two
                    // dimensions without needing a second axis.
                    fillOpacity={0.45 + Math.min(0.55, (row.occupancy / 100) * 0.55)}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
