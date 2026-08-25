/**
 * Card wrapper: title, provenance badge, error/loading handling, and the
 * table-view toggle every chart is required to have.
 *
 * The table view is not a nicety -- a chart that encodes values only in pixels
 * and a hover tooltip is unreadable to screen readers and unusable on a phone.
 * Every chart here ships its WCAG-clean twin behind one button.
 */

import { useState } from 'react';
import { formatValue } from './TimeSeriesChart.jsx';

function ageLabel(ms) {
  if (!Number.isFinite(ms)) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function SourceBadge({ meta }) {
  if (!meta) return null;
  // A snapshot is not "live". It is real data fetched server-side at a known
  // time, and saying so is the difference between a reader trusting a number
  // that is three hours old and one that is three months old.
  if (meta.via === 'snapshot' || meta.snapshot) {
    return <span className="badge" title={`Fetched server-side ${ageLabel(meta.ageMs)}`}>snapshot &middot; {ageLabel(meta.ageMs)}</span>;
  }
  if (meta.synthetic || meta.via === 'demo') {
    return <span className="badge warn" title="Synthetic data — nothing was fetched">demo</span>;
  }
  if (meta.stale) {
    return <span className="badge warn" title={meta.error?.message || ''}>stale cache &middot; {ageLabel(meta.ageMs)}</span>;
  }
  if (meta.cached) return <span className="badge">cached &middot; {ageLabel(meta.ageMs)}</span>;
  if (meta.via === 'file-upload') return <span className="badge ok">from your file</span>;
  if (meta.via?.startsWith('dev-proxy') || meta.via?.includes('proxy')) return <span className="badge">via proxy</span>;
  return <span className="badge ok">live</span>;
}

export default function ChartCard({
  title,
  subtitle,
  note,
  meta,
  error,
  loading,
  full = false,
  series = [],
  unit = '',
  decimals = 1,
  children,
  actions,
}) {
  const [showTable, setShowTable] = useState(false);

  const hasData = series.some((s) => (s.data || []).some((p) => Number.isFinite(p.value)));

  // Spoken description of the chart: what it plots, over what span, ending where.
  const chartSummary = (() => {
    if (!hasData) return `${title} — no data available`;
    const parts = series
      .filter((s) => (s.data || []).some((p) => Number.isFinite(p.value)))
      .map((s) => {
        const pts = (s.data || []).filter((p) => Number.isFinite(p.value));
        const last = pts[pts.length - 1];
        return `${s.label}, latest ${formatValue(last.value, { unit, decimals })} in ${last.date.slice(0, 7)}`;
      });
    return `${title}. Line chart. ${parts.join('. ')}. Use the table view button for all values.`;
  })();

  return (
    <section className={`card${full ? ' full' : ''}`}>
      <div className="card-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <p className="card-sub">{subtitle}</p>}
        </div>
        <div className="row" style={{ gap: 6 }}>
          {actions}
          <SourceBadge meta={meta} />
          {hasData && (
            <button
              className="tiny ghost"
              onClick={() => setShowTable((v) => !v)}
              aria-pressed={showTable}
              // The label stays fixed so aria-pressed carries the state. A
              // swapping label plus aria-pressed announced "Chart, pressed" —
              // the opposite of what the control does.
              title="Show this chart's values as a table"
            >
              Table view
            </button>
          )}
        </div>
      </div>

      {error && !hasData && (
        <div className="notice error">
          <strong>Could not load this panel</strong>
          <pre>{error.message}</pre>
        </div>
      )}

      {/* Refetch holds the previous render at reduced opacity rather than
          flashing a skeleton, so nothing jumps. */}
      {/* Charts are SVG with no accessible content of their own, so the card
          supplies the text alternative and the table view supplies the values. */}
      <div className={loading && hasData ? 'refreshing' : undefined} role="group" aria-label={chartSummary}>
        {showTable && hasData ? (
          <DataTable series={series} unit={unit} decimals={decimals} title={title} />
        ) : (
          children
        )}
      </div>

      {loading && !hasData && !error && (
        <p className="small muted" style={{ padding: '32px 0', textAlign: 'center' }}>Loading&hellip;</p>
      )}

      {note && <p className="card-note">{note}</p>}
    </section>
  );
}

/** The table twin. Newest first, because that is what people look for. */
function DataTable({ series, unit, decimals, title }) {
  const dates = new Set();
  series.forEach((s) => (s.data || []).forEach((p) => Number.isFinite(p.value) && dates.add(p.date)));
  const sorted = [...dates].sort().reverse().slice(0, 60);

  const lookup = series.map((s) => ({ ...s, map: new Map((s.data || []).map((p) => [p.date, p.value])) }));

  return (
    <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
      {/* Six identically-shaped tables can be open at once; without a name
          each is announced as "table, 3 columns" and nothing distinguishes them. */}
      <table aria-label={title ? `${title} — data table` : undefined}>
        <thead>
          <tr>
            <th scope="col">Period</th>
            {series.map((s) => (
              <th scope="col" className="num" key={s.key}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((d) => (
            <tr key={d}>
              <td>{new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</td>
              {lookup.map((s) => (
                <td className="num" key={s.key}>{formatValue(s.map.get(d), { unit, decimals })}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {dates.size > 60 && <p className="card-note">Showing the 60 most recent periods.</p>}
    </div>
  );
}
