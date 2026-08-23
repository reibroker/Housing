/**
 * FRED (Federal Reserve Bank of St. Louis) -- consumer credit, sentiment,
 * mortgage rates and the actual house-price index we score ourselves against.
 *
 * Why FRED, and why the CSV endpoint
 * ----------------------------------
 * The user asked for consumer credit-card debt and consumer confidence. Neither
 * the Census nor the BLS API carries them. The Federal Reserve's own G.19
 * release and the University of Michigan sentiment survey are both republished
 * by FRED, which is the only one of the three that a browser can read without
 * an account.
 *
 * FRED has two front doors:
 *   api.stlouisfed.org/fred/...   -- the documented JSON API. Needs a key AND
 *                                    has historically not sent CORS headers,
 *                                    which makes it a poor fit for a keyless
 *                                    client-side app.
 *   fred.stlouisfed.org/graph/fredgraph.csv?id=SERIES
 *                                 -- the endpoint the FRED chart widget itself
 *                                    calls. No key, plain CSV, and it is what
 *                                    this module uses by default.
 *
 * Set VITE_FRED_MODE=api plus VITE_FRED_API_KEY to switch to the JSON API if
 * you have a key and a proxy; the parsing below handles both shapes.
 *
 * CORS is still not guaranteed on either host, so every call goes through the
 * same direct -> proxy ladder as the rest of the app and degrades to a clear
 * message rather than a blank panel.
 */

import { cachedRequest } from '../lib/http.js';
import { parseCsv, num } from '../lib/tsv.js';
import { getConfig } from '../config/env.js';

const CSV_BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const API_BASE = 'https://api.stlouisfed.org/fred/series/observations';

export const FRED_SERIES = {
  mortgage30yr: {
    id: 'MORTGAGE30US',
    label: '30-year fixed mortgage rate',
    unit: 'percent',
    frequency: 'weekly',
    source: 'Freddie Mac PMMS via FRED',
  },
  consumerSentiment: {
    id: 'UMCSENT',
    label: 'Consumer sentiment (U. Michigan)',
    unit: 'index 1966=100',
    frequency: 'monthly',
    source: 'University of Michigan via FRED',
  },
  revolvingCredit: {
    id: 'REVOLSL',
    label: 'Revolving consumer credit outstanding',
    // FRED publishes REVOLSL in MILLIONS of dollars (a mid-2026 reading is
    // ~1,351,069). Verified against the live series in CI on 2026-08-23. We
    // divide by 1000 on ingest so the charts read in billions, which is how this
    // figure is universally quoted.
    scale: 1 / 1000,
    unit: '$ billions, SA',
    frequency: 'monthly',
    source: 'Federal Reserve G.19 via FRED',
  },
  creditCardDelinquency: {
    id: 'DRCCLACBS',
    label: 'Credit card delinquency rate, all commercial banks',
    unit: 'percent',
    frequency: 'quarterly',
    source: 'Federal Reserve via FRED',
  },
  caseShiller: {
    id: 'CSUSHPINSA',
    label: 'S&P CoreLogic Case-Shiller US national home price index',
    unit: 'index Jan 2000=100',
    frequency: 'monthly',
    source: 'S&P Dow Jones Indices via FRED',
  },
  existingHomeSales: {
    id: 'EXHOSLUSM495S',
    label: 'Existing home sales',
    unit: 'units, SAAR',
    frequency: 'monthly',
    source: 'National Association of Realtors via FRED',
  },
};

/**
 * Fetch one FRED series.
 *
 * fredgraph.csv returns:
 *     observation_date,UMCSENT
 *     2015-01-01,98.1
 *     2015-02-01,.
 *
 * Missing observations are a literal "." -- `num()` maps that to null so gaps
 * stay gaps rather than becoming zeros, which would badly distort a chart and
 * silently corrupt the risk score.
 */
export async function fetchFredSeries(seriesId, { years } = {}) {
  const cfg = getConfig();
  const span = years || cfg.historyYears;
  const start = new Date();
  start.setFullYear(start.getFullYear() - span);
  const cosd = start.toISOString().slice(0, 10);

  const useApi = cfg.fredMode === 'api' && cfg.fredKey;
  const cacheKey = `fred:${seriesId}:${span}y:${useApi ? 'api' : 'csv'}`;

  if (useApi) {
    const qs = new URLSearchParams({
      series_id: seriesId,
      api_key: cfg.fredKey,
      file_type: 'json',
      observation_start: cosd,
    });
    const res = await cachedRequest(cacheKey, `${API_BASE}?${qs}`, {
      source: 'fred',
      hasKey: true,
      as: 'json',
      proxyPath: '/proxy/fred',
    });
    const obs = res.data?.observations || [];
    return {
      points: obs
        .map((o) => ({ date: o.date, value: num(o.value) }))
        .sort((a, b) => (a.date < b.date ? -1 : 1)),
      meta: { via: res.via, cached: res.cached, stale: res.stale, ageMs: res.ageMs, mode: 'api' },
    };
  }

  const qs = new URLSearchParams({ id: seriesId, cosd });
  const res = await cachedRequest(cacheKey, `${CSV_BASE}?${qs}`, {
    source: 'fred',
    hasKey: false,
    as: 'text',
    proxyPath: '/proxy/fred',
  });

  // A cache hit returns the already-parsed points array, not raw CSV.
  if (Array.isArray(res.data)) {
    return { points: res.data, meta: { via: res.via, cached: true, stale: res.stale, ageMs: res.ageMs, mode: 'csv' } };
  }

  const text = String(res.data);
  if (/<html/i.test(text.slice(0, 200))) {
    const e = new Error(
      `FRED returned an HTML page instead of CSV for "${seriesId}". The series id may be wrong or discontinued.`
    );
    e.kind = 'parse';
    throw e;
  }

  const { header, rows } = parseCsv(text);
  // FRED renamed the date column from DATE to observation_date; accept either,
  // and fall back to "whatever the first column is called".
  const dateCol = header.find((h) => /^(observation_date|DATE)$/i.test(h)) || header[0];
  const valueCol = header.find((h) => h !== dateCol) || seriesId;

  const scale = Object.values(FRED_SERIES).find((s) => s.id === seriesId)?.scale ?? 1;
  const points = rows
    .map((r) => {
      const v = num(r[valueCol]);
      return { date: String(r[dateCol] || '').slice(0, 10), value: v === null ? null : v * scale };
    })
    .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  if (points.length === 0) {
    const e = new Error(`FRED returned no usable observations for "${seriesId}".`);
    e.kind = 'parse';
    throw e;
  }

  return { points, meta: { via: res.via, cached: res.cached, stale: res.stale, ageMs: res.ageMs, mode: 'csv' } };
}

/**
 * Load every FRED series. Uses Promise.allSettled so one dead series (FRED does
 * occasionally discontinue and renumber them) cannot take down the whole panel.
 */
export async function loadFred() {
  const entries = Object.entries(FRED_SERIES);
  const results = await Promise.allSettled(entries.map(([, spec]) => fetchFredSeries(spec.id)));

  const series = {};
  const errors = {};
  const meta = {};

  entries.forEach(([name, spec], i) => {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value.points.length) {
      series[name] = r.value.points;
      meta[name] = r.value.meta;
    } else {
      series[name] = null;
      errors[name] = r.status === 'rejected' ? r.reason : new Error(`No data returned for ${spec.id}.`);
    }
  });

  const anySucceeded = Object.values(series).some(Boolean);
  if (!anySucceeded) {
    const first = Object.values(errors)[0];
    const err = new Error(
      `Could not load any FRED series. ${first?.message || ''}\n\n` +
        (first?.kind === 'cors'
          ? 'fred.stlouisfed.org did not send CORS headers for this origin. Enable the dev proxy (VITE_USE_DEV_PROXY=true) or configure a CORS proxy in Settings.'
          : '')
    );
    err.kind = first?.kind || 'network';
    throw err;
  }

  return { series, errors, meta };
}
