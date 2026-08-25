/**
 * Runtime settings.
 *
 * Keys entered here go to localStorage, not into the JavaScript bundle. That
 * matters for a backend-free app: anything in `.env` is compiled into the
 * shipped JS and readable by every visitor. Census/BLS/FRED keys are free,
 * read-only rate-limit identifiers rather than true secrets, so baking them in
 * is defensible for local use -- but if you deploy the built site anywhere
 * public, have each visitor supply their own here instead.
 */

import { useState } from 'react';
import { EDITABLE_SETTINGS, getConfig, writeOverride, setMemoryOverride } from '../config/env.js';
import { QUOTAS, quotaStatus, resetQuotas } from '../lib/rateLimiter.js';
import { clearCache, cacheStats } from '../lib/cache.js';

export default function SettingsPanel({ onApply }) {
  const cfg = getConfig();
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(EDITABLE_SETTINGS.map((s) => [s.key, cfg[s.key] ?? '']))
  );
  const [saved, setSaved] = useState(false);
  const [stats, setStats] = useState(() => cacheStats());

  const apply = () => {
    for (const s of EDITABLE_SETTINGS) {
      const v = draft[s.key];
      writeOverride(s.key, v);
      setMemoryOverride(s.key, v); // takes effect even if storage is blocked
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
    onApply?.();
  };

  const quotas = [
    quotaStatus('census', Boolean(cfg.censusKey)),
    quotaStatus('bls', Boolean(cfg.blsKey)),
    quotaStatus('fred', false),
    quotaStatus('redfin', false),
  ];

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head"><h3>API keys and options</h3></div>
        <p className="card-sub">
          Stored in this browser only. They override anything set in <code>.env</code> and take effect on the next reload of the data.
        </p>

        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          {EDITABLE_SETTINGS.map((s) => (
            <div className="field" key={s.key}>
              <label htmlFor={`set-${s.key}`}>
                {s.label}{s.required ? ' *' : ''}
              </label>
              <input
                id={`set-${s.key}`}
                type={s.type}
                value={draft[s.key] ?? ''}
                placeholder={s.required ? 'required' : 'optional'}
                onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))}
                autoComplete="off"
              />
              <span className="tiny-text muted">{s.help}</span>
            </div>
          ))}
        </div>

        <div className="row" style={{ marginTop: 16 }}>
          <button className="primary" onClick={apply}>Save and reload data</button>
          {saved && <span className="badge ok">saved</span>}
        </div>

        <div className="notice info" style={{ marginTop: 16 }}>
          <strong>Where to get the keys</strong>
          Census (required): <code>api.census.gov/data/key_signup.html</code> &mdash; instant, no approval.<br />
          BLS (optional): <code>data.bls.gov/registrationEngine/</code> &mdash; raises the daily limit from 25 to 500.<br />
          FRED is read through its keyless CSV endpoint, so no key is needed.
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3>Rate limits</h3></div>
        <p className="card-sub">
          Counted locally and reset at midnight UTC. These are the app&rsquo;s own guard rails, set at or below each
          provider&rsquo;s published limit so you get a clear message here instead of an opaque error from the API.
        </p>
        <div className="table-wrap">
          <table aria-label="API rate limits">
            <thead>
              <tr><th scope="col">Source</th><th scope="col" className="num">Used today</th><th scope="col" className="num">Daily budget</th><th scope="col" className="num">Min. spacing</th></tr>
            </thead>
            <tbody>
              {quotas.map((q) => (
                <tr key={q.source}>
                  <td>{q.label}</td>
                  <td className="num">{q.used}</td>
                  <td className="num">{q.limit}</td>
                  <td className="num">{QUOTAS[q.source].minIntervalMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="tiny" onClick={() => { resetQuotas(); onApply?.(); }}>Reset local counters</button>
          <span className="tiny-text muted">Only clears this app&rsquo;s bookkeeping &mdash; it does not change what the provider has recorded.</span>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3>Cache</h3></div>
        <p className="card-sub">
          Responses are cached for {cfg.cacheTtlMinutes} minutes. These series publish monthly at best, so a long TTL
          costs nothing in freshness and keeps you well inside every quota.
        </p>
        <p className="small">
          {stats.entries} stored entr{stats.entries === 1 ? 'y' : 'ies'} &middot;{' '}
          {(stats.bytes / 1024).toFixed(0)} KB in localStorage &middot; {stats.memoryEntries} in memory
        </p>
        <div className="row">
          <button className="tiny" onClick={() => { clearCache(); setStats(cacheStats()); onApply?.(); }}>
            Clear cache and refetch
          </button>
        </div>
      </section>
    </div>
  );
}
