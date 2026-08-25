/**
 * The one chart component every panel uses.
 *
 * Rules it enforces so individual panels cannot get them wrong:
 *   - ONE y-axis, always. Two measures on different scales are two charts, not
 *     one chart with two scales -- a dual axis invents a correlation that is not
 *     in the data. `TimeSeriesChart` physically cannot render a second axis.
 *   - Series take categorical slots in fixed order, keyed by series name, so
 *     hiding one never repaints the others.
 *   - A legend appears whenever there are two or more series; the last point of
 *     each series is direct-labelled. Never a number on every point.
 *   - Crosshair + tooltip by default, with the same values reachable from the
 *     table view toggle on the card -- a tooltip is never the only way to read
 *     a value.
 */

import { useMemo } from 'react';
import {
  ResponsiveContainer, LineChart, Line, AreaChart, Area, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceArea, ReferenceLine, LabelList,
} from 'recharts';
import { alignSeries } from '../lib/stats.js';

/**
 * Vertical nudge for a direct end-label, so labels for series ending at similar
 * values do not overlap. Ranks the final values and offsets by rank; 13px is one
 * line at 11px type.
 */
function endLabelOffset(seriesIndex, rows, series) {
  if (!rows.length) return 0;
  const lastRow = rows[rows.length - 1];
  const finals = series
    .map((s, i) => ({ i, v: lastRow[s.key] }))
    .filter((x) => Number.isFinite(x.v));
  if (finals.length < 2) return 0;
  // Only separate labels that are actually close together.
  const values = finals.map((f) => f.v);
  const span = Math.max(...values) - Math.min(...values);
  const range = Math.abs(span) || 1;
  const mine = finals.find((f) => f.i === seriesIndex);
  if (!mine) return 0;
  const crowded = finals.filter((f) => f.i !== seriesIndex && Math.abs(f.v - mine.v) < range * 0.08);
  if (!crowded.length) return 0;
  const order = [...finals].sort((a, b) => b.v - a.v).findIndex((f) => f.i === seriesIndex);
  return (order - (finals.length - 1) / 2) * 13;
}

/** Fixed categorical slot order. Never cycled; a 6th series is a design smell. */
const SLOTS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5'];

export function seriesColor(i) {
  return `var(${SLOTS[Math.min(i, SLOTS.length - 1)]})`;
}

/**
 * `Jul 16` on a twelve-year axis reads as a day of the month, not a year. Above
 * ~4 years of span the tick becomes the bare year; tooltips always spell the
 * year out, where there is room for it.
 */
function formatDate(iso, granularity = 'month') {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  if (granularity === 'year') return String(d.getFullYear());
  if (granularity === 'long') return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

export function formatValue(v, { unit = '', decimals = 1, compact = false } = {}) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  const abs = Math.abs(v);
  let s;
  if (compact && abs >= 1000) {
    s = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
  } else {
    s = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(v);
  }
  if (unit === '%') return `${s}%`;
  if (unit === '$') return `$${s}`;
  return unit ? `${s} ${unit}` : s;
}

function ChartTooltip({ active, payload, label, series, unit, decimals }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip">
      <div className="tooltip-date">{formatDate(label, 'long')}</div>
      {payload.map((p) => {
        const meta = series.find((s) => s.key === p.dataKey);
        return (
          <div className="tooltip-row" key={p.dataKey}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className="legend-swatch" style={{ background: p.stroke || p.fill }} />
              {meta?.label || p.dataKey}
            </span>
            <span className="val">{formatValue(p.value, { unit, decimals })}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * @param {object} props
 * @param {Array<{key:string,label:string,data:Array<{date,value}>}>} props.series
 * @param {string} props.unit        Shared unit -- all series MUST share one.
 * @param {number} props.decimals
 * @param {'line'|'area'} props.type
 * @param {number} props.height
 * @param {Array<{y1:number,y2:number,label:string}>} props.bands
 *        Optional shaded reference ranges, e.g. the balanced-market zone.
 * @param {number|null} props.referenceLine  Optional horizontal rule (e.g. zero).
 */
export default function TimeSeriesChart({
  series = [],
  unit = '',
  decimals = 1,
  type = 'line',
  height = 240,
  bands = [],
  referenceLine = null,
  compactAxis = false,
}) {
  const rows = useMemo(() => {
    const map = {};
    series.forEach((s) => { map[s.key] = s.data || []; });
    return alignSeries(map);
  }, [series]);

  const withData = series.filter((s) => (s.data || []).some((p) => Number.isFinite(p.value)));

  // Axis ticks lose the month once a chart covers several years.
  const spansYears = useMemo(() => {
    if (rows.length < 2) return false;
    const first = new Date(`${rows[0].date}T00:00:00Z`).getTime();
    const last = new Date(`${rows[rows.length - 1].date}T00:00:00Z`).getTime();
    return (last - first) / 86_400_000 > 4 * 365;
  }, [rows]);

  // Y-axis ticks want fewer decimals than the tooltip, but not zero.
  const axisDecimals = decimals >= 2 ? 1 : decimals;

  if (rows.length === 0 || withData.length === 0) {
    return <p className="small muted" style={{ padding: '28px 0', textAlign: 'center' }}>No observations available for this chart.</p>;
  }

  const Chart = type === 'area' ? AreaChart : LineChart;
  const showLegend = withData.length >= 2;

  // Direct-label only the final point of each series, and only when there are
  // few enough series that the labels cannot collide.
  const directLabel = withData.length <= 3;
  const lastDate = rows[rows.length - 1]?.date;

  return (
    <div>
      {showLegend && (
        <div className="legend">
          {withData.map((s, i) => (
            <span className="legend-item" key={s.key}>
              <span className="legend-swatch" style={{ background: seriesColor(series.indexOf(s)) }} />
              {s.label}
            </span>
          ))}
        </div>
      )}

      {/* Height includes the x-axis band so the axis labels are never clipped
          into a nested scrollbar. */}
      <ResponsiveContainer width="100%" height={height}>
        <Chart data={rows} margin={{ top: 8, right: directLabel ? 52 : 12, bottom: 4, left: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={(d) => formatDate(d, spansYears ? 'year' : 'month')}
            minTickGap={38}
            tickLine={false}
            axisLine={{ stroke: 'var(--axis)' }}
          />
          {/* One axis. Always. */}
          <YAxis
            width={56}
            // Ticks inherit the chart's precision. Hardcoding 0 decimals made
            // five distinct gridlines render as "2%, 2%, 3%, 3%, 4%" — and
            // "4M, 4.1M, 4.1M, 4.2M, 4.3M" under compactAxis.
            tickFormatter={(v) =>
              compactAxis
                ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v)
                : formatValue(v, { unit, decimals: axisDecimals })
            }
            tickLine={false}
            axisLine={false}
            domain={['auto', 'auto']}
          />

          {bands.map((b, i) => (
            <ReferenceArea
              key={i}
              y1={b.y1}
              y2={b.y2}
              fill="var(--text-muted)"
              fillOpacity={0.09}
              stroke="none"
              ifOverflow="extendDomain"
              label={{ value: b.label, position: 'insideTopRight', fill: 'var(--text-muted)', fontSize: 10 }}
            />
          ))}
          {referenceLine !== null && (
            <ReferenceLine y={referenceLine} stroke="var(--axis)" strokeWidth={1} />
          )}

          <Tooltip
            cursor={{ stroke: 'var(--text-muted)', strokeWidth: 1 }}
            content={<ChartTooltip series={series} unit={unit} decimals={decimals} />}
          />

          {series.map((s, i) =>
            type === 'area' ? (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={seriesColor(i)}
                strokeWidth={2}
                fill={seriesColor(i)}
                fillOpacity={0.12}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-1)' }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ) : (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={seriesColor(i)}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-1)' }}
                connectNulls={false}
                isAnimationActive={false}
              >
                {directLabel && (
                  <LabelList
                    dataKey={s.key}
                    position="right"
                    fontSize={11}
                    // Text wears text tokens, not the series color; the line
                    // beside it already carries identity.
                    fill="var(--text-secondary)"
                    formatter={(v) => (v === null ? '' : formatValue(v, { unit, decimals }))}
                    content={(props) => {
                      const { x, y, value, index } = props;
                      const seriesIndex = i;
                      if (rows[index]?.date !== lastDate || !Number.isFinite(value)) return null;
                      // Nudge apart so two series ending at nearly the same
                      // value do not render on top of each other — measured
                      // overlaps of 32x9px on the permits/starts chart.
                      const dy = endLabelOffset(seriesIndex, rows, series);
                      return (
                        <text x={x + 6} y={y + dy} dy={4} fontSize={11} fill="var(--text-secondary)">
                          {formatValue(value, { unit, decimals })}
                        </text>
                      );
                    }}
                  />
                )}
              </Line>
            )
          )}
        </Chart>
      </ResponsiveContainer>
    </div>
  );
}
