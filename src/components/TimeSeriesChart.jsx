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

/** Fixed categorical slot order. Never cycled; a 6th series is a design smell. */
const SLOTS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5'];

export function seriesColor(i) {
  return `var(${SLOTS[Math.min(i, SLOTS.length - 1)]})`;
}

function formatDate(iso, granularity = 'month') {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return granularity === 'year'
    ? String(d.getFullYear())
    : d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
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
      <div className="tooltip-date">{formatDate(label)}</div>
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
            tickFormatter={(d) => formatDate(d)}
            minTickGap={38}
            tickLine={false}
            axisLine={{ stroke: 'var(--axis)' }}
          />
          {/* One axis. Always. */}
          <YAxis
            width={56}
            tickFormatter={(v) =>
              compactAxis
                ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v)
                : formatValue(v, { unit, decimals: 0 })
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
                    formatter={(v) => (v === null ? '' : formatValue(v, { unit, decimals: 0 }))}
                    content={(props) => {
                      const { x, y, value, index } = props;
                      if (rows[index]?.date !== lastDate || !Number.isFinite(value)) return null;
                      return (
                        <text x={x + 6} y={y} dy={4} fontSize={11} fill="var(--text-secondary)">
                          {formatValue(value, { unit, decimals: 0 })}
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
