/**
 * Release calendar and data freshness.
 *
 * Answers the two questions a stale-looking chart raises: when is this figure
 * next published, and has it stopped updating? A flat chart and a dead feed look
 * identical, so freshness is stated explicitly rather than left to be inferred.
 *
 * Dates come from the Census economic-indicator calendar (their own listing,
 * a US Government work, and permitted by their robots.txt). BLS refuses
 * identified automated clients, so BLS-backed series show a derived cadence,
 * labelled as an estimate — never presented as a published date.
 */

import { formatValue } from './TimeSeriesChart.jsx';

const dayFmt = (iso) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

function daysUntil(iso) {
  const d = Math.round((new Date(`${iso}T12:00:00Z`).getTime() - Date.now()) / 86_400_000);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d < 0) return `${-d}d ago`;
  return `in ${d}d`;
}

/** Status pill. Colour never carries the meaning alone — the word does. */
function Freshness({ f }) {
  if (!f?.ok) return <span className="badge err">no data</span>;
  if (f.overdue) return <span className="badge err" title={`Latest observation is ${f.ageDays} days old`}>overdue</span>;
  if (f.ageDays > f.expectedMaxAgeDays) return <span className="badge warn">due now</span>;
  return <span className="badge ok">current</span>;
}

export default function ReleasesPanel({ calendar, loading, error }) {
  if (error) {
    return (
      <div className="notice error">
        <strong>The release calendar is unavailable</strong>
        <pre>{error.message}</pre>
      </div>
    );
  }
  if (loading && !calendar) {
    return <p className="small muted" style={{ padding: '32px 0', textAlign: 'center' }}>Loading the release calendar&hellip;</p>;
  }

  // No calendar is a normal state, not a failure: demo mode does not fetch one,
  // and a fresh clone has no published snapshot yet. Say which, rather than
  // spinning forever on a loader that will never resolve.
  if (!calendar) {
    return (
      <div className="notice info">
        <strong>No release calendar loaded</strong>
        The calendar is published with the data snapshot. Demo mode does not fetch it, and a fresh checkout has no
        snapshot yet &mdash; run <code>npm run data</code>, or switch the Data selector to &ldquo;Published
        snapshot&rdquo;. On the deployed site it is always present.
      </div>
    );
  }

  const { upcoming = [], recent = [], freshness = {}, notes = {} } = calendar;
  const tracked = upcoming.filter((e) => e.tracked);
  const others = upcoming.filter((e) => !e.tracked);
  const overdue = Object.entries(freshness).filter(([, f]) => f.overdue);

  return (
    <div className="stack">
      {overdue.length > 0 && (
        <div className="notice">
          <strong>{overdue.length} series {overdue.length === 1 ? 'is' : 'are'} past due</strong>
          The newest observation is older than the publication schedule implies. Usually a delayed release; occasionally a
          feed that has stopped updating — which a chart alone would never show you.
          <ul className="tiny-text" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {overdue.map(([k, f]) => (
              <li key={k}>{k} — latest {f.latest}, {f.ageDays} days old</li>
            ))}
          </ul>
        </div>
      )}

      <section className="card full">
        <div className="card-head"><h3>Next releases that move this dashboard</h3></div>
        <p className="card-sub">
          Scheduled dates from the Census Bureau&rsquo;s own economic-indicator calendar. Times are Eastern.
        </p>
        {tracked.length === 0 ? (
          <p className="small muted">No upcoming tracked releases found in the calendar.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Release</th><th>Date</th><th className="num">When</th><th>Reference period</th><th>Moves</th></tr>
              </thead>
              <tbody>
                {tracked.map((e) => (
                  <tr key={e.title + e.releaseAt}>
                    <td>
                      {e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.title}</a> : e.title}
                      <div className="tiny-text muted">{e.time}</div>
                    </td>
                    <td>{dayFmt(e.date)}</td>
                    <td className="num">{daysUntil(e.date)}</td>
                    <td className="small">{e.referencePeriod || '—'}</td>
                    <td className="small">{e.affects}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card full">
        <div className="card-head"><h3>Freshness by series</h3></div>
        <p className="card-sub">
          How old each series&rsquo; newest observation is. The threshold is derived from that series&rsquo; own
          observed spacing &mdash; roughly three intervals &mdash; rather than assumed, because a reference date is
          not a publication date: a figure stamped 1 May is published in mid-June and is perfectly current at 60 days old.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Series</th><th>Source</th><th>Latest</th><th className="num">Value</th>
                <th className="num">Age</th><th className="num">Flag at</th><th>Cadence</th><th>Status</th><th>Schedule</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(freshness)
                .sort((a, b) => (b[1].ageDays ?? 0) - (a[1].ageDays ?? 0))
                .map(([name, f]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td className="small muted">{f.group}</td>
                    <td className="small">{f.latest || '—'}</td>
                    <td className="num">{formatValue(f.latestValue, { decimals: 2 })}</td>
                    <td className="num">{f.ok ? `${f.ageDays}d` : '—'}</td>
                    <td className="num muted">{f.ok ? `${f.expectedMaxAgeDays}d` : '—'}</td>
                    <td className="small muted">{f.ok ? `${f.cadence}${f.intervalDays ? ` · ~${f.intervalDays}d` : ''}` : '—'}</td>
                    <td><Freshness f={f} /></td>
                    <td className="tiny-text muted">{f.rule || `${f.cadence}, estimated`}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <p className="card-note">
          {notes.bls}
        </p>
      </section>

      {recent.length > 0 && (
        <section className="card full">
          <div className="card-head"><h3>Recently published</h3></div>
          <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table>
              <thead><tr><th>Release</th><th>Date</th><th>Reference period</th><th>Tracked</th></tr></thead>
              <tbody>
                {recent.map((e) => (
                  <tr key={e.title + e.releaseAt}>
                    <td>{e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.title}</a> : e.title}</td>
                    <td className="small">{dayFmt(e.date)}</td>
                    <td className="small">{e.referencePeriod || '—'}</td>
                    <td>{e.tracked ? <span className="badge ok">yes</span> : <span className="muted tiny-text">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {others.length > 0 && (
        <details>
          <summary>All other scheduled Census economic releases ({others.length})</summary>
          <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto', marginTop: 10 }}>
            <table>
              <thead><tr><th>Release</th><th>Date</th><th className="num">When</th></tr></thead>
              <tbody>
                {others.map((e) => (
                  <tr key={e.title + e.releaseAt}>
                    <td className="small">{e.title}</td>
                    <td className="small">{dayFmt(e.date)}</td>
                    <td className="num">{daysUntil(e.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
