'use client'

import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { formatMoney, type CurrencyCode } from '@/lib/money'

/**
 * PRD §5.6's charts.
 *
 * Client components because a chart needs the DOM -- the only client-side data
 * in this product, and it is the same aggregates already on screen rather than
 * any raw row.
 *
 * Both charts are a SINGLE SERIES, which settles the colour question: one
 * sequential hue from `--viz-series-1` (validated for each mode against its own
 * surface), and NO LEGEND, because the heading names the only series. Colours
 * come from CSS variables so the dark step swaps with the app's theme rather
 * than being computed here.
 *
 * Mark specs: 2px lines, no dot per point (a dot on every point is noise; the
 * hover dot is 5px radius, comfortably over the 8px minimum diameter), 4px
 * rounded data-ends on bars anchored to the baseline, recessive grid and axes,
 * and direct value labels on bars so the numbers survive for anyone who cannot
 * separate the mark from the surface.
 */

/** Compact for an axis -- "1,5jt" rather than "Rp 1.500.000" eleven times. */
const compact = (n: number) => {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')}jt`
  if (abs >= 1_000) return `${Math.round(n / 1000)}rb`
  return String(n)
}

const TooltipBox = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-md border bg-popover px-2 py-1 text-xs shadow-md">
    <div className="text-muted-foreground">{label}</div>
    <div className="font-medium text-popover-foreground">{value}</div>
  </div>
)

export function RevenueTrend({
  data, currency,
}: {
  data: { day: string; revenue: number }[]
  currency: CurrencyCode
}) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
          <XAxis
            dataKey="day"
            tickFormatter={(d: string) => d.slice(8)}
            stroke="var(--viz-axis)"
            tickLine={false}
            axisLine={false}
            fontSize={11}
            minTickGap={16}
          />
          <YAxis
            tickFormatter={compact}
            stroke="var(--viz-axis)"
            tickLine={false}
            axisLine={false}
            fontSize={11}
            width={48}
          />
          {/* The hover layer a chart is expected to have: a crosshair on the
              day plus the exact figure, so the axis can stay compact. */}
          <Tooltip
            cursor={{ stroke: 'var(--viz-axis)', strokeWidth: 1 }}
            content={({ active, payload, label }) => (active && payload?.length ? (
              <TooltipBox
                label={String(label)}
                value={formatMoney(Number(payload[0].value), currency)}
              />
            ) : null)}
          />
          <Line
            type="monotone"
            dataKey="revenue"
            stroke="var(--viz-series-1)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export function TopServicesChart({
  data, currency, measure,
}: {
  data: { name: string; revenue: number; count: number }[]
  currency: CurrencyCode
  measure: 'revenue' | 'count'
}) {
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">Belum ada data.</p>
  }
  const render = (n: number) =>
    (measure === 'revenue' ? formatMoney(n, currency) : String(n))

  return (
    // Horizontal, because Indonesian service names are long and a rotated
    // label is a label nobody reads.
    <div style={{ height: data.length * 40 + 16 }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 0, right: 72, bottom: 0, left: 0 }}
          barCategoryGap={6}
        >
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="name"
            width={140}
            stroke="var(--viz-axis)"
            tickLine={false}
            axisLine={false}
            fontSize={12}
          />
          <Tooltip
            cursor={{ fill: 'var(--viz-grid)' }}
            content={({ active, payload }) => (active && payload?.length ? (
              <TooltipBox
                label={String(payload[0].payload.name)}
                value={render(Number(payload[0].value))}
              />
            ) : null)}
          />
          <Bar dataKey={measure} radius={[0, 4, 4, 0]} maxBarSize={22}>
            {data.map((d) => (
              <Cell key={d.name} fill="var(--viz-series-1)" />
            ))}
            {/* Direct labels: the value survives without the colour. */}
            <LabelList
              dataKey={measure}
              position="right"
              formatter={(v) => render(Number(v ?? 0))}
              className="fill-foreground"
              fontSize={11}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
