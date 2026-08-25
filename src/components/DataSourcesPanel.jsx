/**
 * Provenance and diagnostics.
 *
 * When a chart is empty, the useful question is "which of the four sources
 * failed, and why" -- this panel answers that without opening devtools. It also
 * exposes the Census code-resolution table, which is the fastest way to tell a
 * genuinely missing series apart from a code that Census renamed.
 */

import { CENSUS_SERIES } from '../data/census.js';
import { BLS_SERIES } from '../data/bls.js';
import { FRED_SERIES } from '../data/fred.js';
import { REDFIN_FILES } from '../data/redfin.js';

function StatusRow({ name, host, cors, keyNeeded, state, note }) {
  const status = state.error
    ? { cls: 'err', text: 'failed' }
    : state.loading
      ? { cls: '', text: 'loading' }
      : state.data
        ? { cls: 'ok', text: state.meta?.stale ? 'stale cache' : 'ok' }
        : { cls: '', text: 'idle' };

  return (
    <tr>
      <td>
        <div style={{ fontWeight: 500 }}>{name}</div>
        <div className="tiny-text muted"><code>{host}</code></div>
      </td>
      <td className="small">{cors}</td>
      <td className="small">{keyNeeded}</td>
      <td><span className={`badge ${status.cls}`}>{status.text}</span></td>
      <td className="small">
        {note && !state.error && <div className="tiny-text muted" style={{ marginBottom: 4 }}>{note}</div>}
        {state.error ? (
          <details>
            <summary>Show error</summary>
            <pre className="tiny-text" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{state.error.message}</pre>
          </details>
        ) : (
          <span className="muted tiny-text">{state.meta?.via || note || ''}</span>
        )}
      </td>
    </tr>
  );
}

export default function DataSourcesPanel({ census, bls, fred, redfin, resale, zillow, demo = false }) {
  const resolution = census.meta?.resolution || {};
  const raw = census.meta?.rawSeries || {};

  return (
    <div className="stack">
      {demo && (
        <div className="notice demo-banner">
          <strong>Demo mode is on &mdash; nothing below is being fetched</strong>
          Source status, code resolution and quota counts describe live API calls. Switch the Data selector back to
          &ldquo;Published snapshot&rdquo; for real data, or &ldquo;Live APIs&rdquo; if you have a Census key and
          want the browser to fetch directly.
        </div>
      )}
      <section className="card">
        <div className="card-head"><h3>Sources</h3></div>
        <p className="card-sub">
          The CORS column is why this app has a scheduled fetch rather than reading everything in the page: a host
          that omits <code>Access-Control-Allow-Origin</code> answers the request fine, but the browser refuses to
          hand the response to the page. In the default snapshot mode these were read server-side, where that
          restriction does not apply; in &ldquo;Live APIs&rdquo; mode your browser calls them directly and the ones
          marked as sending no CORS headers will fail.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Source</th><th>CORS</th><th>API key</th><th>Status</th><th>Detail</th></tr>
            </thead>
            <tbody>
              <StatusRow
                name="Census Bureau — Economic Indicators"
                host="api.census.gov"
                cors="Sends Access-Control-Allow-Origin: * — works directly."
                keyNeeded="Required. Unkeyed requests are rejected."
                state={census}
              />
              <StatusRow
                name="Bureau of Labor Statistics"
                host="api.bls.gov"
                cors="Not documented; often absent. App falls back to a proxy if configured."
                keyNeeded="Optional. 25/day without, 500/day with."
                state={bls}
              />
              <StatusRow
                name="FRED — consumer credit, sentiment, rates"
                host="fred.stlouisfed.org"
                cors="Keyless CSV endpoint; usually readable."
                keyNeeded="Not needed in CSV mode."
                state={fred}
              />
              <StatusRow
                name="Redfin Data Center"
                host="redfin-public-data.s3.us-west-2.amazonaws.com"
                cors="No CORS headers — a data bucket, not an API. Read server-side; file-drop fallback in live mode."
                keyNeeded="None."
                state={redfin}
                note="Publication stalled: their file was last modified 2 Jun 2026."
              />
              <StatusRow
                name="Realtor.com residential listings"
                host="fred.stlouisfed.org (ACTLISCOUUS, NEWLISCOUUS, …)"
                cors="No CORS headers; read server-side."
                keyNeeded="None."
                state={resale || { loading: false }}
                note="Live stand-in for the stalled Redfin series."
              />
              <StatusRow
                name="Zillow Research"
                host="files.zillowstatic.com"
                cors="Read server-side."
                keyNeeded="None."
                state={zillow || { loading: false }}
                note="Comparison page and the ZHVF forecast. © Zillow Group, used with attribution."
              />
            </tbody>
          </table>
        </div>
      </section>

      {/* Runtime code resolution only happens when the browser talks to the
          Census API directly. In snapshot mode the resolving was done in CI, so
          rendering this table would mark all eleven series "no match" and tell
          the user Census renamed every code when nothing is wrong. */}
      {!demo && Object.keys(resolution).length > 0 && (
      <section className="card">
        <div className="card-head"><h3>Census series resolution</h3></div>
        <p className="card-sub">
          Census identifies each EITS series by a <code>(category_code, data_type_code)</code> pair, and does not
          publish the valid values through the API. Rather than hard-code a guess, the app pulls the whole national
          time slice and matches against an ordered candidate list. This table shows what actually matched.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Chart series</th><th>Matched code</th><th className="num">Points</th><th>Candidates tried</th></tr>
            </thead>
            <tbody>
              {Object.entries(CENSUS_SERIES).map(([key, spec]) => {
                const r = resolution[key];
                return (
                  <tr key={key}>
                    <td>{spec.label}<div className="tiny-text muted">{spec.unit}</div></td>
                    <td>
                      {r?.matched ? (
                        <code className="tiny-text">{r.matched}</code>
                      ) : (
                        <span className="badge err">no match</span>
                      )}
                    </td>
                    <td className="num">{r?.points ?? '--'}</td>
                    <td className="tiny-text muted">
                      {spec.candidates.map((c) => c.join('/')).join(', ')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {Object.keys(raw).length > 0 && (
          <details>
            <summary>Browse every series Census actually returned ({Object.values(raw).reduce((n, a) => n + a.length, 0)} total)</summary>
            <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto', marginTop: 10 }}>
              <table>
                <thead>
                  <tr><th>Dataset</th><th>category_code</th><th>data_type_code</th><th>SA</th><th className="num">Points</th></tr>
                </thead>
                <tbody>
                  {Object.entries(raw).flatMap(([ds, list]) =>
                    list.map((s) => (
                      <tr key={`${ds}:${s.key}`}>
                        <td className="tiny-text">{ds}</td>
                        <td><code className="tiny-text">{s.category}</code></td>
                        <td><code className="tiny-text">{s.dataType}</code></td>
                        <td className="tiny-text">{s.seasonallyAdj}</td>
                        <td className="num">{s.points.length}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <p className="card-note">
              If a chart says &ldquo;no match&rdquo;, find the right pair here and add it to that entry&rsquo;s
              <code>candidates</code> list in <code>src/data/census.js</code>.
            </p>
          </details>
        )}
      </section>
      )}

      <section className="card">
        <div className="card-head"><h3>Series reference</h3></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Series</th><th>Identifier</th><th>Unit</th><th>Publisher</th></tr></thead>
            <tbody>
              {Object.entries(BLS_SERIES).map(([k, s]) => (
                <tr key={k}><td>{s.label}</td><td><code className="tiny-text">{s.id}</code></td><td className="small">{s.unit}</td><td className="small">BLS</td></tr>
              ))}
              {Object.entries(FRED_SERIES).map(([k, s]) => (
                <tr key={k}><td>{s.label}</td><td><code className="tiny-text">{s.id}</code></td><td className="small">{s.unit}</td><td className="small">{s.source}</td></tr>
              ))}
              {Object.entries(REDFIN_FILES).map(([k, f]) => (
                <tr key={k}><td>Redfin market tracker — {f.label}</td><td><code className="tiny-text" style={{ wordBreak: 'break-all' }}>{f.url}</code></td><td className="small">mixed</td><td className="small">Redfin</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
