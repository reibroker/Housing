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

/**
 * Render the CORS column from what we MEASURED, not from prose.
 *
 * The hardcoded descriptions had drifted badly from reality: the page claimed
 * BLS "often absent" when it measurably sends `*`, claimed FRED was "usually
 * readable" when it sends no header at all, and claimed Census "works directly"
 * on a host we have never once successfully called. The fetcher already records
 * the real `access-control-allow-origin` per source and hands it to the UI —
 * this just uses it, and says "not measured" rather than guessing.
 */
function CorsCell({ measured, note }) {
  if (measured === '*' || (typeof measured === 'string' && measured.length)) {
    return (
      <>
        <div>
          Sends <code className="tiny-text">Access-Control-Allow-Origin: {measured}</code> — a browser can read
          this host directly.
        </div>
        {note && <div className="tiny-text muted">{note}</div>}
      </>
    );
  }
  if (measured === null || measured === undefined) {
    return (
      <>
        <div>
          Sends no <code className="tiny-text">Access-Control-Allow-Origin</code> header, so a browser cannot read
          it directly. Fetched server-side instead.
        </div>
        {note && <div className="tiny-text muted">{note}</div>}
      </>
    );
  }
  return <span className="muted">Not measured.</span>;
}

function StatusRow({ name, host, cors, corsNote, measuredCors, keyNeeded, state, note }) {
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
      <td className="small">
        {measuredCors === 'unmeasured'
          ? <span className="muted">Not measured — this host has not been successfully called.</span>
          : <CorsCell measured={measuredCors} note={corsNote} />}
      </td>
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
  // The fetcher records the real ACAO header per source; 'unmeasured' means the
  // host was never successfully reached, which is different from "no header".
  const manifest = census.meta?.manifest || bls.meta?.manifest || fred.meta?.manifest;
  const corsOf = (key) => {
    const src = manifest?.sources?.[key];
    if (!src) return 'unmeasured';
    if (!src.ok && src.error) return 'unmeasured';
    return src.cors ?? null;
  };
  const noteOf = (key) => manifest?.sources?.[key]?.note || null;
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
          <table aria-label="Data source status">
            <thead>
              <tr><th scope="col">Source</th><th scope="col">CORS</th><th scope="col">API key</th><th scope="col">Status</th><th scope="col">Detail</th></tr>
            </thead>
            <tbody>
              <StatusRow
                name="Census Bureau — Economic Indicators"
                host="api.census.gov"
                measuredCors={corsOf('census')}
                corsNote={noteOf('census')}
                keyNeeded="A key is required for the API. The bulk files below need none."
                state={census}
                note={noteOf('census')}
              />
              <StatusRow
                name="Bureau of Labor Statistics"
                host="api.bls.gov"
                measuredCors={corsOf('bls')}
                keyNeeded="Optional. 25/day without, 500/day with."
                state={bls}
              />
              <StatusRow
                name="FRED — consumer credit, sentiment, rates"
                host="fred.stlouisfed.org"
                measuredCors={corsOf('fred')}
                keyNeeded="Not needed in CSV mode."
                state={fred}
              />
              <StatusRow
                name="Redfin Data Center"
                host="redfin-public-data.s3.us-west-2.amazonaws.com"
                measuredCors={corsOf('redfin')}
                corsNote="A data bucket, not an API. File-drop fallback offered in live mode."
                keyNeeded="None."
                state={redfin}
                note="Publication stalled: their file was last modified 2 Jun 2026."
              />
              <StatusRow
                name="Realtor.com residential listings"
                host="fred.stlouisfed.org (ACTLISCOUUS, NEWLISCOUUS, …)"
                measuredCors={corsOf('resale')}
                keyNeeded="None."
                state={resale || { loading: false }}
                note="Live stand-in for the stalled Redfin series."
              />
              <StatusRow
                name="Zillow Research"
                host="files.zillowstatic.com"
                measuredCors={corsOf('zillow')}
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
          <table aria-label="Census series resolution">
            <thead>
              <tr><th scope="col">Chart series</th><th scope="col">Matched code</th><th scope="col" className="num">Points</th><th scope="col">Candidates tried</th></tr>
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
              <table aria-label="Every series Census returned">
                <thead>
                  <tr><th scope="col">Dataset</th><th scope="col">category_code</th><th scope="col">data_type_code</th><th scope="col">SA</th><th scope="col" className="num">Points</th></tr>
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
          <table aria-label="Series reference">
            <thead><tr><th scope="col">Series</th><th scope="col">Identifier</th><th scope="col">Unit</th><th scope="col">Publisher</th></tr></thead>
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
