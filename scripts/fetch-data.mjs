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
  // BLS counts years INCLUSIVELY: startyear=2016&endyear=2026 is eleven years,
  // which exceeds the keyless ten-year cap. BLS then silently clips the range
  // and returns 2016-2025 -- dropping the most recent months, which is exactly
  // the data a current-conditions gauge depends on. Hence span - 1.
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
          startyear: String(endYear - (span - 1)),
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

// REVOLSL is published in MILLIONS of dollars; the dashboard charts it in
// billions, which is how the figure is normally quoted. Must stay in step with
// the `scale` field in src/data/fred.js.
const FRED_SCALE = { revolvingCredit: 1 / 1000 };

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
      const scale = FRED_SCALE[name] ?? 1;
      const pts = rows
        .map((r) => {
          const v = num(r[valCol]);
          return { date: String(r[dateCol] || '').slice(0, 10), value: v === null ? null : v * scale };
        })
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


// -------------------------------------------------------------- calendar ----
/**
 * Economic release calendar.
 *
 * The goal is to know when each series the dashboard reads is next published,
 * so the site can say "next housing starts: Sep 17" rather than leaving the user
 * to guess why a number has not moved.
 *
 * SOURCING NOTE. Commercial calendars such as Econoday aggregate exactly this
 * information, but their listings are licensed content — fine to consult, not
 * ours to scrape and republish on a public site. The underlying release
 * schedules are published by the statistical agencies themselves and are US
 * Government works in the public domain, so we build the calendar from those
 * directly. Same dates, no licensing problem.
 *
 * This function PROBES several candidate endpoints and records what each
 * returned. The development sandbox cannot reach any of these hosts, so the
 * report is how we find out which ones exist and what shape they are in before
 * committing to a parser.
 */
const CALENDAR_CANDIDATES = [
  { id: 'bls_ics',        url: 'https://www.bls.gov/schedule/news_release/bls.ics', as: 'text' },
  { id: 'bls_schedule',   url: 'https://www.bls.gov/schedule/news_release/2026_sched.htm', as: 'text' },
  { id: 'census_ics',     url: 'https://www.census.gov/economic-indicators/calendar.ics', as: 'text' },
  { id: 'census_cal',     url: 'https://www.census.gov/economic-indicators/calendar-listview.html', as: 'text' },
  { id: 'fred_releases',  url: 'https://api.stlouisfed.org/fred/releases/dates?file_type=json&include_release_dates_with_no_data=true&api_key=' + (process.env.FRED_API_KEY || 'NOKEY'), as: 'text' },
];

async function doCalendar() {
  const info = { probes: {} };
  for (const c of CALENDAR_CANDIDATES) {
    try {
      const { data, cors } = await get(c.url, { as: c.as, timeoutMs: 45_000 });
      const text = String(data);
      info.probes[c.id] = {
        ok: true,
        cors,
        bytes: text.length,
        contentSniff: text.slice(0, 200).replace(/\s+/g, ' '),
        // For iCal, count events and show one so the parser can be written
        // against reality rather than a guess.
        vevents: (text.match(/BEGIN:VEVENT/g) || []).length,
        sampleEvent: (() => {
          const m = /BEGIN:VEVENT([\s\S]{0,600}?)END:VEVENT/.exec(text);
          return m ? m[1].replace(/\s+/g, ' ').slice(0, 400) : null;
        })(),
      };
    } catch (e) {
      info.probes[c.id] = { ok: false, error: e.message.slice(0, 200) };
    }
  }
  report.sources.calendar = info;
  return null;
}


// ------------------------------------------------------- mirrors / checks ---
/**
 * Independent second source, used two ways: to CROSS-CHECK the primary feeds,
 * and to FILL IN for them when a primary is unavailable.
 *
 * FRED republishes the same underlying releases the Census and BLS APIs serve —
 * housing starts, permits, new-home sales and months' supply come from the
 * Census New Residential Construction and New Home Sales releases; the labour
 * series come from BLS. Reading them by a second, independent path is a real
 * validity check: if our Census parse and FRED's copy of the same release
 * disagree on the latest value, the parse is wrong, not the economy.
 *
 * It also removes the hard dependency on a Census API key. Every Census-sourced
 * indicator in the risk model has a keyless FRED mirror, so the dashboard can
 * reach full coverage with no key at all; a key then upgrades those panels to
 * the primary source and turns the mirror into a check.
 *
 * Each entry lists CANDIDATE FRED ids because a few series have been renumbered
 * over the years. The first that returns data wins, and the report records which
 * one resolved — the same discover-at-runtime approach used for the Census codes,
 * for the same reason: this sandbox cannot reach the API to confirm a guess.
 */
const MIRRORS = {
  startsTotal:         { ids: ['HOUST'],                    unit: 'thousands, SAAR', primary: 'census' },
  startsSingle:        { ids: ['HOUST1F'],                  unit: 'thousands, SAAR', primary: 'census' },
  permitsTotal:        { ids: ['PERMIT'],                   unit: 'thousands, SAAR', primary: 'census' },
  permitsSingle:       { ids: ['PERMIT1'],                  unit: 'thousands, SAAR', primary: 'census' },
  underConstruction:   { ids: ['UNDCONTSA'],                unit: 'thousands, SA',   primary: 'census' },
  completions:         { ids: ['COMPUTSA'],                 unit: 'thousands, SAAR', primary: 'census' },
  newHomeSales:        { ids: ['HSN1F'],                    unit: 'thousands, SAAR', primary: 'census' },
  newHomeMonthsSupply: { ids: ['MSACSR'],                   unit: 'months',          primary: 'census' },
  newHomesForSale:     { ids: ['HNFSEPUSSA', 'HNFSUSNSA'],  unit: 'thousands',       primary: 'census' },
  homeownerVacancy:    { ids: ['RHVRUSQ156N'],              unit: 'percent',         primary: 'census' },
  rentalVacancy:       { ids: ['RRVRUSQ156N'],              unit: 'percent',         primary: 'census' },
  unemploymentRate:    { ids: ['UNRATE'],                   unit: 'percent',         primary: 'bls' },
  totalNonfarm:        { ids: ['PAYEMS'],                   unit: 'thousands',       primary: 'bls' },
  constructionJobs:    { ids: ['USCONS'],                   unit: 'thousands',       primary: 'bls' },
};

async function fetchFredCsv(id, cosd) {
  const { data } = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cosd}`, { as: 'text' });
  if (/<html/i.test(data.slice(0, 200))) throw new Error(`FRED returned HTML for ${id} (unknown or discontinued series).`);
  const { header, rows } = parseCsv(data);
  const dateCol = header.find((h) => /^(observation_date|DATE)$/i.test(h)) || header[0];
  const valCol = header.find((h) => h !== dateCol) || id;
  const pts = rows
    .map((r) => ({ date: String(r[dateCol] || '').slice(0, 10), value: num(r[valCol]) }))
    .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date));
  if (!pts.length) throw new Error(`No observations for ${id}.`);
  return pts;
}

async function doMirrors() {
  const info = { resolved: {}, failed: {} };
  const start = new Date();
  start.setFullYear(start.getFullYear() - HISTORY_YEARS);
  const cosd = start.toISOString().slice(0, 10);

  const out = {};
  for (const [name, spec] of Object.entries(MIRRORS)) {
    let got = null;
    const tried = [];
    for (const id of spec.ids) {
      try {
        got = { id, points: await fetchFredCsv(id, cosd) };
        break;
      } catch (e) {
        tried.push(`${id}: ${e.message.slice(0, 90)}`);
      }
    }
    if (got) {
      out[name] = got.points;
      info.resolved[name] = { id: got.id, n: got.points.length, last: got.points[got.points.length - 1] };
    } else {
      out[name] = null;
      info.failed[name] = tried;
    }
  }
  report.sources.mirrors = info;
  return out;
}

/**
 * Compare the primary feed against the mirror on the most recent date they
 * share, and record the disagreement.
 *
 * Small differences are expected and benign: seasonal-adjustment vintages differ,
 * and Census revises the previous two months with every release while FRED may
 * be a few hours behind. A large gap means a parsing or units error, which is
 * exactly the class of bug that produced the revolving-credit and BLS-year
 * problems.
 */
function crossCheck(primary, mirrors) {
  const checks = {};
  for (const [name, spec] of Object.entries(MIRRORS)) {
    const a = primary[spec.primary]?.[name];
    const b = mirrors[name];
    if (!a?.length || !b?.length) {
      checks[name] = { status: a?.length ? 'mirror-missing' : b?.length ? 'primary-missing' : 'both-missing' };
      continue;
    }
    const bByDate = new Map(b.map((p) => [p.date, p.value]));
    const shared = [...a].reverse().find((p) => bByDate.has(p.date) && Number.isFinite(p.value));
    if (!shared) { checks[name] = { status: 'no-shared-date', primaryLast: a[a.length - 1], mirrorLast: b[b.length - 1] }; continue; }
    const mv = bByDate.get(shared.date);
    const diffPct = mv === 0 ? null : ((shared.value - mv) / Math.abs(mv)) * 100;
    checks[name] = {
      status: diffPct === null ? 'unknown' : Math.abs(diffPct) <= 2 ? 'agree' : Math.abs(diffPct) <= 10 ? 'minor' : 'MISMATCH',
      date: shared.date,
      primary: shared.value,
      mirror: mv,
      diffPct: diffPct === null ? null : Number(diffPct.toFixed(2)),
      mirrorId: MIRRORS[name].ids[0],
    };
  }
  return checks;
}

// ------------------------------------------------------------------- main ---
const [census, bls, fred, redfin, , mirrors] = await Promise.all([
  doCensus(), doBls(), doFred(), doRedfin(), doCalendar(), doMirrors(),
]);

// Validity check: primary vs independent second path.
const checks = crossCheck({ census, bls }, mirrors || {});
report.crossChecks = checks;
const mismatches = Object.entries(checks).filter(([, c]) => c.status === 'MISMATCH');
if (mismatches.length) {
  console.log('\nCROSS-CHECK MISMATCHES (>10% apart — investigate):');
  for (const [k, c] of mismatches) console.log(`  ${k}: primary ${c.primary} vs ${c.mirrorId} ${c.mirror} (${c.diffPct}%) on ${c.date}`);
}

// Fill gaps from the mirror. Census needs an API key; without one, every
// Census-sourced indicator would be missing and the gauge would run at ~50%
// coverage. The keyless FRED mirrors carry the same releases, so the dashboard
// stays complete either way — and each filled series is labelled so nobody
// mistakes a mirror for the primary source.
const filledFrom = {};
const censusOut = { ...(census || {}) };
for (const [name, spec] of Object.entries(MIRRORS)) {
  if (spec.primary !== 'census') continue;
  if (!censusOut[name]?.length && mirrors?.[name]?.length) {
    censusOut[name] = mirrors[name];
    filledFrom[name] = MIRRORS[name].ids[0];
  }
}
report.filledFromMirror = filledFrom;

const write = (name, payload) =>
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(payload), 'utf8');

write('census', { series: Object.keys(censusOut).length ? censusOut : null, generatedAt: report.generatedAt, filledFromMirror: filledFrom });
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
manifest.crossChecks = Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, c.status]));
manifest.filledFromMirror = filledFrom;
write('manifest', manifest);
write('mirrors', { series: mirrors, generatedAt: report.generatedAt });
writeFileSync(join(ROOT, 'data-report.json'), JSON.stringify(report, null, 2), 'utf8');

console.log(JSON.stringify(manifest, null, 2));
const okCount = Object.values(manifest.sources).filter((s) => s.ok).length;
console.log(`\n${okCount}/4 sources fetched successfully.`);
// Never fail the job: a partial snapshot is more useful than none, and the
// report explains exactly what was missing.
