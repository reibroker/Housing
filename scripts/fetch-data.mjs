#!/usr/bin/env node
/**
 * Server-side data fetch, run by GitHub Actions.
 *
 * WHY THIS EXISTS
 * The browser cannot read three of our four sources. api.bls.gov,
 * fred.stlouisfed.org and Redfin's S3 bucket do not send
 * Access-Control-Allow-Origin, so a purely client-side fetch is refused by the
 * browser no matter how well the request is formed. On a static host with no
 * backend there is no way around that from inside the page.
 *
 * There is, however, a way around it from *outside* the page: fetch on a
 * machine that has no CORS policy, and publish the result alongside the app.
 * This script runs in CI, pulls every source with no origin restrictions and no
 * key exposure, normalizes each into the exact series shape the dashboard's
 * adapters produce, and writes JSON into public/data/. Those files are then
 * served from the same origin as the app, so the browser fetches them without a
 * preflight, without a key, and without a proxy.
 *
 * The app keeps its direct-fetch adapters: a user with their own Census key can
 * still pull live. The snapshot is the default because it always works.
 *
 * It also writes data-report.json -- a verbose diagnostic of what each source
 * actually returned, including the Census category/data-type codes discovered at
 * runtime. That file is the ground truth this project could not otherwise get,
 * because the development sandbox cannot reach these hosts at all.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTsvStream, parseCsv, num } from '../src/lib/tsv.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'data');
mkdirSync(OUT, { recursive: true });

const HISTORY_YEARS = Number(process.env.HISTORY_YEARS || 12);
const CENSUS_KEY = process.env.CENSUS_API_KEY || '';
const BLS_KEY = process.env.BLS_API_KEY || '';

const report = { generatedAt: new Date().toISOString(), node: process.version, sources: {} };

/** Fetch with timeout and a descriptive error. */
async function get(url, { as = 'json', timeoutMs = 120_000, init = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const cors = res.headers.get('access-control-allow-origin');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${body.replace(/<[^>]+>/g, ' ').trim().slice(0, 200)}`);
    }
    if (as === 'stream') return { res, cors };
    const data = as === 'json' ? await res.json() : await res.text();
    return { data, cors };
  } finally {
    clearTimeout(t);
  }
}

const iso = (y, m) => `${y}-${String(m).padStart(2, '0')}-01`;

// ---------------------------------------------------------------- Census ----
function normalizeEitsTime(t) {
  const s = String(t || '').trim();
  let m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return iso(m[1], Number(m[2]));
  m = /^(\d{4})-?Q(\d)$/i.exec(s);
  if (m) return iso(m[1], (Number(m[2]) - 1) * 3 + 1);
  m = /^(\d{4})$/.exec(s);
  if (m) return iso(m[1], 1);
  return null;
}

async function fetchEits(dataset) {
  const end = new Date();
  const start = new Date(end.getFullYear() - HISTORY_YEARS, end.getMonth(), 1);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const params = new URLSearchParams({
    get: 'cell_value,data_type_code,category_code,seasonally_adj,time_slot_id,error_data',
    for: 'us:*',
    time: `from ${fmt(start)} to ${fmt(end)}`,
    key: CENSUS_KEY,
  });
  const { data, cors } = await get(`https://api.census.gov/data/timeseries/eits/${dataset}?${params}`);
  if (!Array.isArray(data) || data.length < 2) throw new Error('Census returned no rows.');

  const header = data[0];
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const series = new Map();
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const date = normalizeEitsTime(row[col.time]);
    if (!date) continue;
    const key = `${row[col.category_code]}|${row[col.data_type_code]}|${row[col.seasonally_adj]}`;
    if (!series.has(key)) {
      series.set(key, {
        key,
        category: row[col.category_code],
        dataType: row[col.data_type_code],
        seasonallyAdj: row[col.seasonally_adj],
        points: new Map(),
      });
    }
    series.get(key).points.set(date, num(row[col.cell_value]));
  }
  const out = [...series.values()].map((s) => ({
    ...s,
    points: [...s.points.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => (a.date < b.date ? -1 : 1)),
  }));
  return { series: out, cors, rows: data.length - 1 };
}

const normCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function resolve(all, candidates, preferSA = 'yes') {
  for (const [cat, dt] of candidates) {
    const hits = all.filter((s) => normCode(s.category) === normCode(cat) && normCode(s.dataType) === normCode(dt));
    if (!hits.length) continue;
    return hits.find((s) => String(s.seasonallyAdj).toLowerCase().startsWith(preferSA[0])) || hits[0];
  }
  return null;
}

const CENSUS_SPEC = {
  permitsTotal:         { ds: 'resconst', c: [['APERMITS','TOTAL'],['PERMITS','TOTAL'],['AUTHORIZED','TOTAL'],['APERMITS','ALL']] },
  permitsSingle:        { ds: 'resconst', c: [['APERMITS','SINGLE'],['APERMITS','SINGLEUNIT'],['PERMITS','SINGLE'],['APERMITS','1UNIT']] },
  startsTotal:          { ds: 'resconst', c: [['STARTS','TOTAL'],['ASTARTS','TOTAL'],['HOUSINGSTARTS','TOTAL'],['STARTS','ALL']] },
  startsSingle:         { ds: 'resconst', c: [['STARTS','SINGLE'],['STARTS','SINGLEUNIT'],['ASTARTS','SINGLE'],['STARTS','1UNIT']] },
  underConstruction:    { ds: 'resconst', c: [['UNDERCONST','TOTAL'],['UNDERCONSTRUCTION','TOTAL'],['UC','TOTAL']] },
  completions:          { ds: 'resconst', c: [['COMPLETIONS','TOTAL'],['COMPS','TOTAL'],['ACOMPLETIONS','TOTAL']] },
  newHomeSales:         { ds: 'ressales', c: [['SOLD','TOTAL'],['NEWHOMESALES','TOTAL'],['SOLD','ALL']] },
  newHomeMonthsSupply:  { ds: 'ressales', c: [['MSACCT','TOTAL'],['MONTHSSUPPLY','TOTAL'],['MS','TOTAL'],['SUPPLY','TOTAL']] },
  newHomesForSale:      { ds: 'ressales', c: [['FORSALE','TOTAL'],['NOTSOLD','TOTAL'],['INVENTORY','TOTAL']] },
  homeownerVacancy:     { ds: 'hv',       c: [['HOMEOWNER','RATE'],['HVR','TOTAL'],['HOMEOWNERVACANCY','TOTAL'],['USHVR','TOTAL']] },
  rentalVacancy:        { ds: 'hv',       c: [['RENTAL','RATE'],['RVR','TOTAL'],['RENTALVACANCY','TOTAL'],['USRVR','TOTAL']] },
};

async function doCensus() {
  const info = { ok: false, cors: null, datasets: {}, resolved: {}, unmatched: [], allCodes: {} };
  if (!CENSUS_KEY) {
    info.error = 'CENSUS_API_KEY not set — Census rejects every unkeyed request.';
    report.sources.census = info;
    return null;
  }
  const out = {};
  for (const ds of ['resconst', 'ressales', 'hv']) {
    try {
      const { series, cors, rows } = await fetchEits(ds);
      info.cors = cors;
      info.datasets[ds] = { ok: true, seriesCount: series.length, rows };
      // The whole point of the probe: record every code combination Census
      // actually serves, so the candidate lists can stop being guesses.
      info.allCodes[ds] = series.map((s) => ({ category: s.category, dataType: s.dataType, sa: s.seasonallyAdj, n: s.points.length }));
      out[ds] = series;
    } catch (e) {
      info.datasets[ds] = { ok: false, error: e.message };
    }
  }
  const series = {};
  for (const [name, spec] of Object.entries(CENSUS_SPEC)) {
    const all = out[spec.ds] || [];
    const hit = resolve(all, spec.c);
    series[name] = hit ? hit.points : null;
    if (hit) info.resolved[name] = { matched: hit.key, points: hit.points.length };
    else { info.resolved[name] = null; info.unmatched.push(name); }
  }
  info.ok = Object.values(series).some(Boolean);
  report.sources.census = info;
  return series;
}

// ------------------------------------------------------------------- BLS ----
const BLS_IDS = {
  residentialConstructionJobs: 'CES2023610001',
  residentialTradeJobs: 'CES2023800001',
  constructionJobs: 'CES2000000001',
  totalNonfarm: 'CES0000000001',
  unemploymentRate: 'LNS14000000',
  cpiShelter: 'CUSR0000SAH1',
};

function blsPoints(s) {
  const out = [];
  for (const d of s.data || []) {
    const p = d.period || '';
    let month;
    if (/^M(\d{2})$/.test(p)) { const m = Number(p.slice(1)); if (m === 13) continue; month = m; }
    else if (/^Q0([1-4])$/.test(p)) month = (Number(p.slice(2)) - 1) * 3 + 1;
    else if (p === 'A01') month = 1;
    else continue;
    out.push({ date: iso(d.year, month), value: num(d.value) });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

async function doBls() {
  const info = { ok: false, cors: null, keyed: Boolean(BLS_KEY) };
  const endYear = new Date().getFullYear();
  const span = BLS_KEY ? Math.min(HISTORY_YEARS, 20) : Math.min(HISTORY_YEARS, 10);
  const base = BLS_KEY
    ? 'https://api.bls.gov/publicAPI/v2/timeseries/data/'
    : 'https://api.bls.gov/publicAPI/v1/timeseries/data/';
  try {
    const { data, cors } = await get(base, {
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seriesid: Object.values(BLS_IDS),
          startyear: String(endYear - span),
          endyear: String(endYear),
          ...(BLS_KEY ? { registrationkey: BLS_KEY } : {}),
        }),
      },
    });
    info.cors = cors;
    info.status = data.status;
    info.message = data.message;
    if (!/SUCCEEDED/i.test(data.status || '')) throw new Error(`BLS: ${(data.message || []).join(' ') || data.status}`);
    const byId = Object.fromEntries((data.Results?.series || []).map((s) => [s.seriesID, blsPoints(s)]));
    const series = {};
    for (const [name, id] of Object.entries(BLS_IDS)) series[name] = byId[id]?.length ? byId[id] : null;
    series.stateUnemploymentRate = null;
    info.counts = Object.fromEntries(Object.entries(series).map(([k, v]) => [k, v?.length ?? 0]));
    info.ok = Object.values(series).some(Boolean);
    report.sources.bls = info;
    return series;
  } catch (e) {
    info.error = e.message;
    report.sources.bls = info;
    return null;
  }
}

// ------------------------------------------------------------------ FRED ----
const FRED_IDS = {
  mortgage30yr: 'MORTGAGE30US',
  consumerSentiment: 'UMCSENT',
  revolvingCredit: 'REVOLSL',
  creditCardDelinquency: 'DRCCLACBS',
  caseShiller: 'CSUSHPINSA',
  existingHomeSales: 'EXHOSLUSM495S',
};

async function doFred() {
  const info = { ok: false, cors: null, series: {} };
  const start = new Date();
  start.setFullYear(start.getFullYear() - HISTORY_YEARS);
  const cosd = start.toISOString().slice(0, 10);
  const series = {};
  for (const [name, id] of Object.entries(FRED_IDS)) {
    try {
      const { data, cors } = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cosd}`, { as: 'text' });
      info.cors = cors;
      const { header, rows } = parseCsv(data);
      const dateCol = header.find((h) => /^(observation_date|DATE)$/i.test(h)) || header[0];
      const valCol = header.find((h) => h !== dateCol) || id;
      const pts = rows
        .map((r) => ({ date: String(r[dateCol] || '').slice(0, 10), value: num(r[valCol]) }))
        .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date));
      series[name] = pts.length ? pts : null;
      info.series[name] = { ok: Boolean(pts.length), header, n: pts.length, last: pts[pts.length - 1] || null };
    } catch (e) {
      series[name] = null;
      info.series[name] = { ok: false, error: e.message };
    }
  }
  info.ok = Object.values(series).some(Boolean);
  report.sources.fred = info;
  return series;
}

// ---------------------------------------------------------------- Redfin ----
const REDFIN_URL =
  'https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_market_tracker/us_national_market_tracker.tsv000.gz';

const REDFIN_COLS = ['period_begin','period_duration','region_type','region','state_code','property_type',
  'is_seasonally_adjusted','median_sale_price','median_sale_price_yoy','homes_sold','homes_sold_yoy',
  'new_listings','inventory','inventory_yoy','months_of_supply','median_dom','avg_sale_to_list',
  'sold_above_list','price_drops'];

async function doRedfin() {
  const info = { ok: false, cors: null };
  try {
    const { res, cors } = await get(REDFIN_URL, { as: 'stream', timeoutMs: 300_000 });
    info.cors = cors;
    info.contentLength = res.headers.get('content-length');
    const { rows, header, totalRows } = await parseTsvStream(res.body, {
      gzipped: true,
      columns: REDFIN_COLS,
      filter: (r) => r.property_type === 'All Residential' && (!r.period_duration || r.period_duration === '30'),
    });
    info.headerSample = header.slice(0, 30);
    info.totalRows = totalRows;
    info.keptRows = rows.length;
    if (!rows.length) throw new Error(`Parsed ${totalRows} rows, none matched the filter.`);

    const pick = (field, tf = num) => {
      const m = new Map();
      for (const r of rows) {
        const d = /^(\d{4})-(\d{2})/.exec(String(r.period_begin || ''));
        if (!d) continue;
        const v = tf(r[field]);
        if (v !== null) m.set(iso(d[1], Number(d[2])), v);
      }
      return [...m.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => (a.date < b.date ? -1 : 1));
    };
    const pct = (v) => { const n = num(v); return n === null ? null : n * 100; };

    const series = {
      medianSalePrice: pick('median_sale_price'),
      medianSalePriceYoY: pick('median_sale_price_yoy', pct),
      homesSold: pick('homes_sold'),
      homesSoldYoY: pick('homes_sold_yoy', pct),
      newListings: pick('new_listings'),
      inventory: pick('inventory'),
      inventoryYoY: pick('inventory_yoy', pct),
      monthsOfSupply: pick('months_of_supply'),
      medianDaysOnMarket: pick('median_dom'),
      saleToListRatio: pick('avg_sale_to_list', pct),
      soldAboveList: pick('sold_above_list', pct),
      priceDrops: pick('price_drops', pct),
    };
    info.counts = Object.fromEntries(Object.entries(series).map(([k, v]) => [k, v.length]));
    info.samples = Object.fromEntries(Object.entries(series).map(([k, v]) => [k, v[v.length - 1] || null]));
    info.ok = Object.values(series).some((v) => v.length);
    report.sources.redfin = info;
    return series;
  } catch (e) {
    info.error = e.message;
    report.sources.redfin = info;
    return null;
  }
}

// ------------------------------------------------------------------- main ---
const [census, bls, fred, redfin] = await Promise.all([doCensus(), doBls(), doFred(), doRedfin()]);

const write = (name, payload) =>
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(payload), 'utf8');

write('census', { series: census, generatedAt: report.generatedAt });
write('bls', { series: bls, generatedAt: report.generatedAt });
write('fred', { series: fred, generatedAt: report.generatedAt });
write('redfin', { series: redfin, generatedAt: report.generatedAt });

const manifest = {
  generatedAt: report.generatedAt,
  historyYears: HISTORY_YEARS,
  sources: Object.fromEntries(
    Object.entries(report.sources).map(([k, v]) => [k, { ok: Boolean(v.ok), error: v.error || null, cors: v.cors ?? null }])
  ),
};
write('manifest', manifest);
writeFileSync(join(ROOT, 'data-report.json'), JSON.stringify(report, null, 2), 'utf8');

console.log(JSON.stringify(manifest, null, 2));
const okCount = Object.values(manifest.sources).filter((s) => s.ok).length;
console.log(`\n${okCount}/4 sources fetched successfully.`);
// Never fail the job: a partial snapshot is more useful than none, and the
// report explains exactly what was missing.
