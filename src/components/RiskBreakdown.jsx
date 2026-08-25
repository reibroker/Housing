/**
 * The audit trail for the gauge.
 *
 * A single composite number is only trustworthy if you can take it apart, so
 * this table shows every indicator's raw value, the two thresholds it was scaled
 * between, its resulting 0-100 sub-score, the weight it carries after
 * renormalization, and its actual contribution to the total. Indicators that
 * failed to resolve are listed too, with the reason -- silence about a missing
 * input is how composite scores mislead people.
 */

import { formatValue } from './TimeSeriesChart.jsx';

const TONE = (s) =>
  s >= 80 ? 'var(--critical)' : s >= 60 ? 'var(--serious)' : s >= 40 ? 'var(--warning)' : 'var(--good)';

export default function RiskBreakdown({ result }) {
  if (!result) return null;
  const { contributions, byGroup } = result;
  const missing = contributions.filter((c) => !c.available);
  const present = contributions.filter((c) => c.available);

  return (
    <div>
      {byGroup.length > 0 && (
        <>
          <h4 style={{ margin: '4px 0 8px', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>By category</h4>
          <div className="table-wrap">
            <table aria-label="Indicator detail, sorted by contribution">
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col" className="num">Indicators</th>
                  <th scope="col" className="num">Weight</th>
                  <th scope="col" style={{ width: '34%' }}>Category score</th>
                </tr>
              </thead>
              <tbody>
                {byGroup.map((g) => (
                  <tr key={g.group}>
                    <td>{g.group}</td>
                    <td className="num">{g.available}/{g.total}</td>
                    <td className="num">{(g.weight * 100).toFixed(0)}%</td>
                    <td>
                      <Meter score={g.groupScore} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h4 style={{ margin: '20px 0 8px', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
        Indicator detail &mdash; sorted by contribution to the total
      </h4>
      <div className="table-wrap">
        <table aria-label="Indicator detail, sorted by contribution">
          <thead>
            <tr>
              <th scope="col">Indicator</th>
              <th scope="col" className="num">Latest</th>
              <th scope="col" className="num">0-score at</th>
              <th scope="col" className="num">100-score at</th>
              <th scope="col" style={{ minWidth: 150 }}>Sub-score</th>
              <th scope="col" className="num">Weight</th>
              <th scope="col" className="num">Adds</th>
            </tr>
          </thead>
          <tbody>
            {present.map((c) => (
              <tr key={c.key}>
                <td>
                  <div style={{ fontWeight: 500 }}>{c.label}</div>
                  <div className="tiny-text muted">
                    {c.sourceNote || c.source}
                    {c.observedAt ? ` · as of ${new Date(`${c.observedAt}T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}` : ''}
                  </div>
                  {c.sourceNote && c.sourceNote !== c.source && (
                    <div className="tiny-text" style={{ color: 'var(--text-secondary)' }}>
                      Using a substitute source, with thresholds calibrated to it.
                    </div>
                  )}
                  {c.stale && <span className="badge warn">source stalled</span>}
                  <details>
                    <summary>Why it matters</summary>
                    <p className="tiny-text muted" style={{ margin: '6px 0 0', maxWidth: '52ch' }}>{c.rationale}</p>
                  </details>
                </td>
                <td className="num">{formatValue(c.value, { unit: c.unit === '%' ? '%' : '', decimals: c.unit === 'ratio' ? 2 : 1 })}</td>
                <td className="num muted">{c.low}</td>
                <td className="num muted">{c.high}</td>
                <td><Meter score={c.subScore} /></td>
                <td className="num">{(c.effectiveWeight * 100).toFixed(0)}%</td>
                <td className="num">{c.contribution.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {missing.length > 0 && (
        <div className="notice" style={{ marginTop: 16 }}>
          <strong>{missing.length} indicator{missing.length === 1 ? '' : 's'} could not be computed</strong>
          The remaining weights were renormalized, so the score reflects only what resolved.
          <ul className="tiny-text" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {missing.map((c) => (
              <li key={c.key}>
                <strong style={{ display: 'inline' }}>{c.label}</strong> ({c.source})
                {c.error ? ` — ${c.error}` : ' — source unavailable or series empty.'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Meter({ score }) {
  if (!Number.isFinite(score)) return <span className="muted tiny-text">n/a</span>;
  return (
    <span className="meter">
      <span className="meter-track">
        <span className="meter-fill" style={{ width: `${score}%`, background: TONE(score) }} />
      </span>
      <span className="meter-num">{Math.round(score)}</span>
    </span>
  );
}
