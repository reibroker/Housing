/**
 * Bureau of Labor Statistics -- Public Data API v2.
 *
 * Series this dashboard uses (all seasonally adjusted unless noted):
 *   CES2023610001  Residential building construction, all employees
 *   CES2023800001  Residential specialty trade contractors, all employees
 *   CES2000000001  Construction sector, all employees
 *   CES0000000001  Total nonfarm employment
 *   LNS14000000    Unemployment rate
 *   CUSR0000SAH1   CPI: shelter
 *   LASST<fips>... State unemployment rate (LAUS), when a state is selected
 *
 * ---------------------------------------------------------------------------
 * CORS, and the request ladder this module uses
 * ---------------------------------------------------------------------------
 * api.bls.gov does not document CORS support, and in practice its responses
 * often omit `Access-Control-Allow-Origin`. That makes it the least
 * browser-friendly of our sources, so we try three shapes in order:
 *
 *   1. Batch POST with `Content-Type: text/plain`.
 *      The v2 API's documented shape is a JSON POST, but `application/json`
 *      is NOT a CORS-safelisted content type, so it triggers a preflight
 *      OPTIONS request that BLS will not answer -- the request dies before the
 *      real one is sent. `text/plain` IS safelisted, so the POST goes out as a
 *      "simple request" with no preflight, and BLS parses the body as JSON
 *      regardless. One call covers up to 50 series, which matters a great deal
 *      against a 25/day keyless quota.
 *
 *   2. Per-series GET.
 *      `/timeseries/data/{seriesId}?startyear=&endyear=` is a plain GET, also
 *      preflight-free. Costs one quota unit per series, so it is a fallback,
 *      not the default.
 *
 *   3. Proxy (dev-server or user-supplied), if enabled in settings.
 *
 * If all three fail we surface a specific message rather than a generic error,
 * because the fix differs completely between "bad key" and "browser blocked it".
 *
 * ---------------------------------------------------------------------------
 * Rate limits
 * ---------------------------------------------------------------------------
 *   No key  (v1): 25 requests/day, 25 series/request, 10 years/request
 *   With key(v2): 500 requests/day, 50 series/request, 20 years/request
 * The limiter in lib/rateLimiter.js enforces the daily figure locally and the
 * config layer clamps the history window to 20 years.
 */

import { request, buildAttemptUrls } from '../lib/http.js';
import { cacheGet, cacheSet, cacheGetStale } from '../lib/cache.js';
import { getConfig } from '../config/env.js';
import { num } from '../lib/tsv.js';

const V2 = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const V1 = 'https://api.bls.gov/publicAPI/v1/timeseries/data/';

export const BLS_SERIES = {
  residentialConstructionJobs: {
    id: 'CES2023610001',
    label: 'Residential building construction employment',
    unit: 'thousands of jobs',
  },
  residentialTradeJobs: {
    id: 'CES2023800001',
    label: 'Residential specialty trade contractor employment',
    unit: 'thousands of jobs',
  },
  constructionJobs: {
    id: 'CES2000000001',
    label: 'Total construction employment',
    unit: 'thousands of jobs',
  },
  totalNonfarm: {
    id: 'CES0000000001',
    label: 'Total nonfarm employment',
    unit: 'thousands of jobs',
  },
  unemploymentRate: {
    id: 'LNS14000000',
    label: 'Unemployment rate',
    unit: 'percent',
  },
  cpiShelter: {
    id: 'CUSR0000SAH1',
    label: 'CPI: shelter',
    unit: 'index 1982-84=100',
  },
};

/** LAUS statewide unemployment-rate series id for a 2-digit state FIPS code. */
export function stateUnemploymentSeriesId(fips) {
  return `LASST${fips}0000000000003`;
}

/** Convert one BLS series object into our { date, value } point array. */
function toPoints(seriesObj) {
  const out = [];
  for (const d of seriesObj.data || []) {
    const period = d.period || '';
    let month;
    if (/^M(\d{2})$/.test(period)) {
      const m = Number(period.slice(1));
      if (m === 13) continue; // M13 is the annual average, not a monthly obs
      month = m;
    } else if (/^Q0([1-4])$/.test(period)) {
      month = (Number(period.slice(2)) - 1) * 3 + 1;
    } else if (/^S0([12])$/.test(period)) {
      month = Number(period.slice(2)) === 1 ? 1 : 7;
    } else if (period === 'A01') {
      month = 1;
    } else {
      continue;
    }
    const value = num(d.value);
    out.push({ date: `${d.year}-${String(month).padStart(2, '0')}-01`, value });
  }
  // BLS returns newest-first.
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Turn a BLS envelope into { seriesId: points }, throwing on API-level errors. */
function unwrap(payload) {
  if (!payload || typeof payload !== 'object') {
    const e = new Error('BLS returned an unreadable response.');
    e.kind = 'parse';
    throw e;
  }
  const status = payload.status || '';
  if (!/SUCCEEDED/i.test(status)) {
    const msg = (payload.message || []).join(' ') || status || 'unknown error';
    const e = new Error(`BLS rejected the request: ${msg}`);
    // A bad or missing key, or a blown quota, is a configuration problem the
    // user can fix; anything else is transient.
    e.kind = /key|threshold|limit|daily/i.test(msg) ? 'config' : 'http';
    throw e;
  }
  const series = payload.Results?.series || [];
  const out = {};
  for (const s of series) out[s.seriesID] = toPoints(s);
  return out;
}

/**
 * Fetch a batch of BLS series, walking the request ladder described above.
 *
 * @param {string[]} seriesIds
 * @returns {Promise<{series:Record<string,object[]>, meta:object}>}
 */
export async function fetchBlsSeries(seriesIds) {
  const cfg = getConfig();
  const hasKey = Boolean(cfg.blsKey);
  const endYear = new Date().getFullYear();
  // Keyless requests are capped at 10 years of history by BLS itself.
  const span = hasKey ? Math.min(cfg.historyYears, 20) : Math.min(cfg.historyYears, 10);
  // Inclusive year counting: startyear=2016&endyear=2026 is ELEVEN years and
  // breaches the cap (10 keyless, 20 keyed). BLS responds by clipping the range
  // and returning the OLDEST years, silently dropping the newest months -- the
  // ones a current-conditions dashboard actually needs. Verified against the
  // live API in CI: a 2016-2026 request came back ending 2025-12.
  const startYear = endYear - (span - 1);

  const ids = [...new Set(seriesIds)];
  const cacheKey = `bls:${ids.join(',')}:${startYear}-${endYear}:${hasKey ? 'k' : 'nk'}`;

  const hit = cacheGet(cacheKey, cfg.cacheTtlMinutes);
  if (hit) {
    return { series: hit.value, meta: { via: `cache:${hit.tier}`, cached: true, stale: false, ageMs: hit.ageMs } };
  }

  const attempts = [];
  const errors = [];

  // --- Attempt 1: one batched POST, preflight-free via text/plain -----------
  attempts.push(async () => {
    const body = JSON.stringify({
      seriesid: ids.slice(0, hasKey ? 50 : 25),
      startyear: String(startYear),
      endyear: String(endYear),
      ...(hasKey ? { registrationkey: cfg.blsKey } : {}),
    });
    const res = await request(hasKey ? V2 : V1, {
      source: 'bls',
      hasKey,
      as: 'json',
      proxyPath: '/proxy/bls',
      retries: 1,
      init: {
        method: 'POST',
        // Deliberately text/plain -- see the module comment.
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body,
      },
    });
    return { series: unwrap(res.data), via: `${res.via} (batch POST)` };
  });

  // --- Attempt 2: one GET per series ---------------------------------------
  attempts.push(async () => {
    const out = {};
    let via = 'direct (per-series GET)';
    for (const id of ids) {
      const qs = new URLSearchParams({
        startyear: String(startYear),
        endyear: String(endYear),
        ...(hasKey ? { registrationkey: cfg.blsKey } : {}),
      });
      const res = await request(`${hasKey ? V2 : V1}${encodeURIComponent(id)}?${qs}`, {
        source: 'bls',
        hasKey,
        as: 'json',
        proxyPath: '/proxy/bls',
        retries: 1,
      });
      Object.assign(out, unwrap(res.data));
      via = `${res.via} (per-series GET)`;
    }
    return { series: out, via };
  });

  for (const attempt of attempts) {
    try {
      const { series, via } = await attempt();
      // Only accept the result if it actually carried data; an empty success
      // usually means the series ids were wrong, and we would rather fall
      // through and report that than cache an empty dashboard.
      const nonEmpty = Object.values(series).some((p) => p.length > 0);
      if (nonEmpty) {
        cacheSet(cacheKey, series);
        return { series, meta: { via, cached: false, stale: false, ageMs: 0, startYear, endYear, hasKey } };
      }
      errors.push(new Error('BLS responded successfully but returned no observations for the requested series.'));
    } catch (e) {
      errors.push(e);
      // A rejected key will fail identically on every attempt shape, so stop.
      if (e.kind === 'config') break;
    }
  }

  const stale = cacheGetStale(cacheKey);
  if (stale) {
    return {
      series: stale.value,
      meta: { via: 'cache:stale', cached: true, stale: true, ageMs: stale.ageMs, error: errors[0] },
    };
  }

  const primary = errors[0] || new Error('BLS request failed.');
  const detail = errors.map((e) => `- ${e.message}`).join('\n');
  const err = new Error(
    `Could not load BLS data. Attempts made:\n${detail}\n\n` +
      (primary.kind === 'cors'
        ? 'api.bls.gov appears not to send CORS headers for this origin. Enable the dev proxy (VITE_USE_DEV_PROXY=true) or set a CORS proxy in Settings.'
        : 'Check your BLS key and daily quota in the Data Sources panel.')
  );
  err.kind = primary.kind;
  throw err;
}

/** Load every BLS series the dashboard needs, plus the selected state's rate. */
export async function loadBls({ stateFips = null } = {}) {
  const ids = Object.values(BLS_SERIES).map((s) => s.id);
  if (stateFips) ids.push(stateUnemploymentSeriesId(stateFips));

  const { series, meta } = await fetchBlsSeries(ids);

  const out = {};
  for (const [name, spec] of Object.entries(BLS_SERIES)) {
    out[name] = series[spec.id]?.length ? series[spec.id] : null;
  }
  out.stateUnemploymentRate = stateFips ? series[stateUnemploymentSeriesId(stateFips)] || null : null;

  return { series: out, meta, raw: series };
}
