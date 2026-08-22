/**
 * US Census Bureau -- Economic Indicators Time Series (EITS) API.
 *
 *   New Residential Construction : /data/timeseries/eits/resconst
 *       building permits, housing starts, units under construction, completions
 *   New Home Sales               : /data/timeseries/eits/ressales
 *       new houses sold, months' supply, median sales price
 *   Housing Vacancies            : /data/timeseries/eits/hv
 *       homeowner and rental vacancy rates (quarterly)
 *
 * CORS: api.census.gov sends `Access-Control-Allow-Origin: *`, so these calls
 * work directly from the browser with no proxy.
 *
 * API KEY: required. Census used to allow 500 anonymous calls a day; it now
 * rejects unkeyed requests with a 400 and an HTML "Missing Key" page. The key
 * is free and issued instantly.
 *
 * ----------------------------------------------------------------------------
 * A note on why this module discovers series codes instead of hard-coding them
 * ----------------------------------------------------------------------------
 * EITS identifies a series by a (category_code, data_type_code, seasonally_adj)
 * triple. Census does not expose the valid values for those fields through the
 * API's own metadata endpoints -- `variables/category_code.json` returns only
 * the field's schema, not its domain -- and the codes differ per dataset and
 * have changed across survey revisions.
 *
 * Hard-coding a guessed triple gives you a dashboard that silently renders an
 * empty chart the day Census renames a code. Instead we pull the full national
 * time slice in one request (it is small -- a few hundred KB), group it into
 * series in the browser, and then *resolve* each chart against an ordered list
 * of candidate codes. If none of the candidates match, the UI can still show
 * every series the API actually returned, labelled with its raw codes, so the
 * dashboard degrades into something inspectable rather than something blank.
 * It also costs one HTTP request instead of one per series.
 */

import { cachedRequest } from '../lib/http.js';
import { getConfig } from '../config/env.js';
import { num } from '../lib/tsv.js';

const BASE = 'https://api.census.gov/data/timeseries/eits';

/** EITS wants `time=from 2014-01 to 2026-08` with the spaces URL-encoded. */
function timeParam(years) {
  const end = new Date();
  const start = new Date(end.getFullYear() - years, end.getMonth(), 1);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `from ${fmt(start)} to ${fmt(end)}`;
}

/**
 * Fetch one EITS dataset and reshape it into named series.
 *
 * @param {'resconst'|'ressales'|'hv'} dataset
 * @returns {Promise<{series: Map<string, object>, meta: object}>}
 *   Keys are `${category_code}|${data_type_code}|${seasonally_adj}`.
 */
export async function fetchEits(dataset) {
  const cfg = getConfig();
  if (!cfg.censusKey) {
    const e = new Error(
      'A Census API key is required. Get a free one at api.census.gov/data/key_signup.html, ' +
        'then paste it into Settings (or put it in .env as VITE_CENSUS_API_KEY).'
    );
    e.kind = 'config';
    throw e;
  }

  const params = new URLSearchParams({
    get: 'cell_value,data_type_code,category_code,seasonally_adj,time_slot_id,error_data',
    for: 'us:*',
    time: timeParam(cfg.historyYears),
    key: cfg.censusKey,
  });

  const url = `${BASE}/${dataset}?${params.toString()}`;
  // Cache key deliberately excludes the key itself so rotating a key does not
  // orphan the cache, but includes the window so changing it forces a refetch.
  const cacheKey = `census:${dataset}:${cfg.historyYears}y`;

  const res = await cachedRequest(cacheKey, url, {
    source: 'census',
    hasKey: true,
    as: 'json',
    proxyPath: '/proxy/census', // present as a fallback only; not normally needed
  });

  const table = res.data;
  if (!Array.isArray(table) || table.length < 2) {
    const e = new Error(`Census returned no rows for "${dataset}". The dataset or time window may be unavailable.`);
    e.kind = 'parse';
    throw e;
  }

  const header = table[0];
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const required = ['cell_value', 'data_type_code', 'category_code', 'seasonally_adj', 'time'];
  const missing = required.filter((r) => col[r] === undefined);
  if (missing.length) {
    const e = new Error(`Census response is missing expected columns: ${missing.join(', ')}. Header was: ${header.join(', ')}`);
    e.kind = 'parse';
    throw e;
  }

  const series = new Map();

  for (let r = 1; r < table.length; r++) {
    const row = table[r];
    const category = row[col.category_code];
    const dataType = row[col.data_type_code];
    const sa = row[col.seasonally_adj];
    const time = row[col.time]; // 'YYYY-MM' for monthly, 'YYYY-Qn' for quarterly
    const value = num(row[col.cell_value]);

    const date = normalizeEitsTime(time);
    if (!date) continue;

    const key = `${category}|${dataType}|${sa}`;
    if (!series.has(key)) {
      series.set(key, { key, category, dataType, seasonallyAdj: sa, points: [] });
    }
    series.get(key).points.push({ date, value });
  }

  // Sort each series and collapse duplicate dates (EITS occasionally returns
  // multiple time slots for one period; the last published wins).
  for (const s of series.values()) {
    const byDate = new Map();
    s.points.forEach((p) => byDate.set(p.date, p.value));
    s.points = [...byDate.entries()]
      .map(([date, value]) => ({ date, value }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  return {
    series,
    meta: {
      dataset,
      via: res.via,
      cached: res.cached,
      stale: res.stale,
      ageMs: res.ageMs,
      seriesCount: series.size,
      availableKeys: [...series.keys()].sort(),
    },
  };
}

/** '2026-03' -> '2026-03-01'; '2026-Q2' -> '2026-04-01'. */
function normalizeEitsTime(t) {
  if (!t) return null;
  const s = String(t).trim();
  let m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-01`;
  m = /^(\d{4})-?Q(\d)$/i.exec(s);
  if (m) return `${m[1]}-${String((Number(m[2]) - 1) * 3 + 1).padStart(2, '0')}-01`;
  m = /^(\d{4})$/.exec(s);
  if (m) return `${m[1]}-01-01`;
  return null;
}

/**
 * Pick the first series whose (category, dataType) matches a candidate pair.
 *
 * Candidates are tried in order, so put the exact code you expect first and
 * historical or alternate spellings after it. Matching is case-insensitive and
 * ignores underscores, which absorbs the most common kind of code drift.
 *
 * @param {Map} series          Output of fetchEits().series
 * @param {Array<[string,string]>} candidates  [category, dataType] pairs
 * @param {'yes'|'no'} preferSA  Seasonal adjustment preference; falls back to
 *                               the other if the preferred one is absent.
 */
export function resolveSeries(series, candidates, preferSA = 'yes') {
  const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const all = [...series.values()];

  for (const [cat, dt] of candidates) {
    const matches = all.filter((s) => norm(s.category) === norm(cat) && norm(s.dataType) === norm(dt));
    if (matches.length === 0) continue;
    const preferred = matches.find((s) => String(s.seasonallyAdj).toLowerCase().startsWith(preferSA[0]));
    return preferred || matches[0];
  }
  return null;
}

/**
 * Candidate code lists for the charts this app draws.
 *
 * Each entry lists several spellings because the exact EITS code set is not
 * published through the API. `resolveSeries` walks them in order and takes the
 * first hit; the Data Sources panel shows which one actually matched, and the
 * "Browse raw series" view lists everything so an unmatched chart can be
 * diagnosed in seconds.
 */
export const CENSUS_SERIES = {
  permitsTotal: {
    dataset: 'resconst',
    label: 'Building permits, total units',
    unit: 'thousands, SAAR',
    candidates: [
      ['APERMITS', 'TOTAL'],
      ['PERMITS', 'TOTAL'],
      ['AUTHORIZED', 'TOTAL'],
      ['APERMITS', 'ALL'],
    ],
  },
  permitsSingle: {
    dataset: 'resconst',
    label: 'Building permits, single-family',
    unit: 'thousands, SAAR',
    candidates: [
      ['APERMITS', 'SINGLE'],
      ['APERMITS', 'SINGLEUNIT'],
      ['PERMITS', 'SINGLE'],
      ['APERMITS', '1UNIT'],
    ],
  },
  startsTotal: {
    dataset: 'resconst',
    label: 'Housing starts, total units',
    unit: 'thousands, SAAR',
    candidates: [
      ['STARTS', 'TOTAL'],
      ['ASTARTS', 'TOTAL'],
      ['HOUSINGSTARTS', 'TOTAL'],
      ['STARTS', 'ALL'],
    ],
  },
  startsSingle: {
    dataset: 'resconst',
    label: 'Housing starts, single-family',
    unit: 'thousands, SAAR',
    candidates: [
      ['STARTS', 'SINGLE'],
      ['STARTS', 'SINGLEUNIT'],
      ['ASTARTS', 'SINGLE'],
      ['STARTS', '1UNIT'],
    ],
  },
  underConstruction: {
    dataset: 'resconst',
    label: 'Units under construction',
    unit: 'thousands',
    candidates: [
      ['UNDERCONST', 'TOTAL'],
      ['UNDERCONSTRUCTION', 'TOTAL'],
      ['UC', 'TOTAL'],
    ],
  },
  completions: {
    dataset: 'resconst',
    label: 'Housing completions',
    unit: 'thousands, SAAR',
    candidates: [
      ['COMPLETIONS', 'TOTAL'],
      ['COMPS', 'TOTAL'],
      ['ACOMPLETIONS', 'TOTAL'],
    ],
  },
  newHomeSales: {
    dataset: 'ressales',
    label: 'New single-family homes sold',
    unit: 'thousands, SAAR',
    candidates: [
      ['SOLD', 'TOTAL'],
      ['NEWHOMESALES', 'TOTAL'],
      ['SOLD', 'ALL'],
    ],
  },
  newHomeMonthsSupply: {
    dataset: 'ressales',
    label: "New homes: months' supply at current sales rate",
    unit: 'months',
    candidates: [
      ['MSACCT', 'TOTAL'],
      ['MONTHSSUPPLY', 'TOTAL'],
      ['MS', 'TOTAL'],
      ['SUPPLY', 'TOTAL'],
    ],
  },
  newHomesForSale: {
    dataset: 'ressales',
    label: 'New homes for sale (inventory)',
    unit: 'thousands',
    candidates: [
      ['FORSALE', 'TOTAL'],
      ['NOTSOLD', 'TOTAL'],
      ['INVENTORY', 'TOTAL'],
    ],
  },
  homeownerVacancy: {
    dataset: 'hv',
    label: 'Homeowner vacancy rate',
    unit: 'percent',
    candidates: [
      ['HOMEOWNER', 'RATE'],
      ['HVR', 'TOTAL'],
      ['HOMEOWNERVACANCY', 'TOTAL'],
      ['USHVR', 'TOTAL'],
    ],
  },
  rentalVacancy: {
    dataset: 'hv',
    label: 'Rental vacancy rate',
    unit: 'percent',
    candidates: [
      ['RENTAL', 'RATE'],
      ['RVR', 'TOTAL'],
      ['RENTALVACANCY', 'TOTAL'],
      ['USRVR', 'TOTAL'],
    ],
  },
};

/**
 * Load every Census series the dashboard needs, with at most three HTTP calls
 * (one per dataset) regardless of how many charts consume them.
 */
export async function loadCensus() {
  const datasets = [...new Set(Object.values(CENSUS_SERIES).map((s) => s.dataset))];

  const results = await Promise.allSettled(datasets.map((d) => fetchEits(d)));

  const byDataset = {};
  const errors = {};
  datasets.forEach((d, i) => {
    const r = results[i];
    if (r.status === 'fulfilled') byDataset[d] = r.value;
    else errors[d] = r.reason;
  });

  const out = {};
  const resolution = {};

  for (const [name, spec] of Object.entries(CENSUS_SERIES)) {
    const ds = byDataset[spec.dataset];
    if (!ds) {
      out[name] = null;
      resolution[name] = { matched: null, reason: errors[spec.dataset]?.message || 'dataset unavailable' };
      continue;
    }
    const hit = resolveSeries(ds.series, spec.candidates);
    out[name] = hit ? hit.points : null;
    resolution[name] = hit
      ? { matched: hit.key, label: spec.label, unit: spec.unit, points: hit.points.length }
      : {
          matched: null,
          label: spec.label,
          reason: `No series matched candidates ${JSON.stringify(spec.candidates)}.`,
        };
  }

  return {
    series: out,
    resolution,
    errors,
    meta: Object.fromEntries(Object.entries(byDataset).map(([k, v]) => [k, v.meta])),
    rawSeries: Object.fromEntries(Object.entries(byDataset).map(([k, v]) => [k, [...v.series.values()]])),
  };
}
