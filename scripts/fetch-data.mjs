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
const REDFIN_BASE = 'https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_market_tracker';
const REDFIN_URL = `${REDFIN_BASE}/us_national_market_tracker.tsv000.gz`;

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



/**
 * Diagnose Redfin's publication lag.
 *
 * The first full run had every Redfin series stopping at 2026-05 while Census and
 * BLS were current to 2026-07. Redfin publishes monthly with a two-to-three week
 * lag, so July should exist. Since Redfin supplies five of the fourteen model
 * indicators and roughly 47% of the weight, a two-month lag on the primary file
 * is worth resolving rather than tolerating.
 *
 * Two hypotheses: the national rollup is refreshed less often than the
 * finer-grained files, or there is a more current file we are not reading. This
 * checks Last-Modified on each candidate and reports the newest period each one
 * actually contains, so the answer comes from the data rather than a guess.
 */
const REDFIN_CANDIDATES = [
  { id: 'national',    url: `${REDFIN_BASE}/us_national_market_tracker.tsv000.gz` },
  { id: 'state',       url: `${REDFIN_BASE}/state_market_tracker.tsv000.gz` },
  { id: 'weekly',      url: 'https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_covid19/weekly_housing_market_data_most_recent.tsv000.gz' },
];

async function probeRedfinFreshness() {
  const info = {};
  for (const c of REDFIN_CANDIDATES) {
    try {
      const head = await fetch(c.url, { method: 'HEAD' });
      const meta = {
        status: head.status,
        lastModified: head.headers.get('last-modified'),
        bytes: head.headers.get('content-length'),
      };
      // Read just enough of the body to learn the newest period it carries.
      if (head.ok && c.id !== 'state') {
        const { res } = await get(c.url, { as: 'stream', timeoutMs: 240_000 });
        const { rows } = await parseTsvStream(res.body, {
          gzipped: true,
          columns: ['period_begin', 'period_end', 'property_type', 'period_duration', 'region_type'],
          filter: () => true,
          maxRows: 400_000,
        });
        const periods = [...new Set(rows.map((r) => String(r.period_begin || '').slice(0, 7)).filter(Boolean))].sort();
        meta.newestPeriod = periods[periods.length - 1] || null;
        meta.oldestPeriod = periods[0] || null;
        meta.distinctPeriods = periods.length;
        meta.propertyTypes = [...new Set(rows.map((r) => r.property_type))].slice(0, 6);
        meta.durations = [...new Set(rows.map((r) => r.period_duration))].slice(0, 6);
      }
      info[c.id] = meta;
    } catch (e) {
      info[c.id] = { error: e.message.slice(0, 180) };
    }
  }
  report.redfinFreshnessProbe = info;
  return info;
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
  { id: 'bls_ics',      url: 'https://www.bls.gov/schedule/news_release/bls.ics' },
  { id: 'bls_sched_26', url: 'https://www.bls.gov/schedule/news_release/2026_sched.htm' },
  { id: 'bls_sched_27', url: 'https://www.bls.gov/schedule/news_release/2027_sched.htm' },
  { id: 'census_list',  url: 'https://www.census.gov/economic-indicators/calendar-listview.html' },
  { id: 'census_ics',   url: 'https://www.census.gov/economic-indicators/calendar.ics' },
  { id: 'census_json',  url: 'https://www.census.gov/economic-indicators/calendar.json' },
];

/**
 * A descriptive User-Agent, as a courtesy and because it is usually the fix.
 *
 * The first probe got 403 from bls.gov on every path. Federal sites routinely
 * reject the default runtime UA (undici/Node) while serving identified clients
 * fine — the block is aimed at anonymous scrapers, not at telling us to go away.
 * Identifying the project and linking the repo is both the polite form and the
 * one that tends to work. If a 403 survives this, that is a real refusal and we
 * stop rather than dress the request up further.
 */
const UA = 'HousingMarketDashboard/1.0 (+https://github.com/reibroker/Housing; public data, hourly)';

/** Check robots.txt before fetching anything on a host we intend to parse. */
async function robotsAllows(origin, path) {
  try {
    const { data } = await get(`${origin}/robots.txt`, { as: 'text', timeoutMs: 20_000, init: { headers: { 'User-Agent': UA } } });
    // Deliberately simple: collect Disallow rules under `*` and check for a
    // prefix match. Good enough to catch an explicit prohibition, which is what
    // we actually care about.
    const lines = String(data).split(/\r?\n/).map((l) => l.trim());
    let inStar = false;
    const disallowed = [];
    for (const line of lines) {
      const ua = /^user-agent:\s*(.+)$/i.exec(line);
      if (ua) { inStar = ua[1].trim() === '*'; continue; }
      const dis = /^disallow:\s*(.*)$/i.exec(line);
      if (dis && inStar && dis[1].trim()) disallowed.push(dis[1].trim());
    }
    const hit = disallowed.find((d) => path.startsWith(d));
    return { allowed: !hit, matchedRule: hit || null, rules: disallowed.length };
  } catch (e) {
    return { allowed: null, error: e.message.slice(0, 120) };
  }
}

async function doCalendar() {
  const info = { userAgent: UA, robots: {}, probes: {} };

  for (const origin of ['https://www.bls.gov', 'https://www.census.gov']) {
    info.robots[origin] = await robotsAllows(origin, origin.includes('bls') ? '/schedule/' : '/economic-indicators/');
  }

  for (const c of CALENDAR_CANDIDATES) {
    try {
      const { data, cors } = await get(c.url, {
        as: 'text',
        timeoutMs: 45_000,
        init: { headers: { 'User-Agent': UA, Accept: 'text/calendar, text/html, application/json;q=0.9, */*;q=0.8' } },
      });
      const text = String(data);
      const isIcal = /BEGIN:VCALENDAR/.test(text);
      info.probes[c.id] = {
        ok: true,
        cors,
        bytes: text.length,
        kind: isIcal ? 'ical' : /^\s*[[{]/.test(text) ? 'json' : 'html',
        vevents: (text.match(/BEGIN:VEVENT/g) || []).length,
        sampleEvent: (() => {
          const m = /BEGIN:VEVENT([\s\S]{0,700}?)END:VEVENT/.exec(text);
          return m ? m[1].replace(/\s+/g, ' ').slice(0, 500) : null;
        })(),
        // For HTML, capture the rows so a parser can be written against the
        // real markup instead of a guess at its structure.
        htmlRowSample: isIcal ? null : (() => {
          const rows = text.match(/<tr[\s\S]{0,900}?<\/tr>/gi) || [];
          const withDate = rows.filter((r) => /\b(20\d\d|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(r));
          return withDate.slice(0, 3).map((r) => r.replace(/\s+/g, ' ').slice(0, 450));
        })(),
      };
    } catch (e) {
      info.probes[c.id] = { ok: false, error: e.message.slice(0, 250) };
    }
  }
  // Build the real calendar from whichever Census listing came back as HTML.
  const censusHtml = ['census_list', 'census_ics', 'census_json']
    .map((id) => info.probes[id])
    .find((p) => p?.ok && p.kind === 'html');

  let events = [];
  if (censusHtml) {
    try {
      const { data } = await get(
        CALENDAR_CANDIDATES.find((c) => c.id === 'census_list').url,
        { as: 'text', timeoutMs: 45_000, init: { headers: { 'User-Agent': UA } } }
      );
      events = parseCensusCalendar(String(data));
      info.parsed = events.length;
    } catch (e) {
      info.parseError = e.message.slice(0, 200);
    }
  }
  info.ok = events.length > 0;
  report.sources.calendar = info;
  return events;
}


/**
 * Parse the Census economic-indicator calendar.
 *
 * robots.txt at www.census.gov permits /economic-indicators/, and the listing is
 * a US Government work. Each row carries a sortable key of the exact form
 * YYYYMMDDHHMM, which is a far more reliable anchor than the human-readable date
 * beside it:
 *
 *   <tr><td><a href="/construction/nrc/">New Residential Construction</a></td>
 *       <td sorttable_customkey="202601201000">January 20, 2026</td>
 *       <td>10:00 AM</td><td>December 2025</td>…</tr>
 *
 * BLS is not scraped: it returns 403 to identified clients and its robots.txt is
 * itself 403, which is a refusal, not an obstacle to route around. BLS-sourced
 * indicators get a DERIVED next-release estimate instead (see releaseRules), and
 * the UI labels those as estimates rather than published dates.
 */
function parseCensusCalendar(html) {
  const events = [];
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const key = /sorttable_customkey="(\d{12})"/.exec(row);
    if (!key) continue;
    const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map((c) =>
      c.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    );
    if (cells.length < 3) continue;
    const k = key[1];
    const iso = `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}T${k.slice(8, 10)}:${k.slice(10, 12)}:00-05:00`;
    const href = /href="([^"]+)"/.exec(row);
    events.push({
      title: cells[0],
      url: href ? `https://www.census.gov${href[1]}` : null,
      releaseAt: iso,
      date: `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`,
      time: cells[2] || null,
      referencePeriod: cells[3] || null,
      source: 'Census',
    });
  }
  // Same release can be listed twice (advance + full report).
  const seen = new Set();
  return events
    .filter((e) => { const k = e.title + e.releaseAt; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.releaseAt < b.releaseAt ? -1 : 1));
}

/**
 * Which Census releases move which indicators on this dashboard.
 * Matched case-insensitively against the calendar's report title.
 */
const RELEASE_MAP = [
  { match: /new residential construction/i, indicators: ['permitsTotal', 'permitsSingle', 'startsTotal', 'startsSingle', 'underConstruction', 'completions'], label: 'Permits, starts, completions' },
  { match: /new residential sales|new home sales/i, indicators: ['newHomeSales', 'newHomeMonthsSupply', 'newHomesForSale'], label: "New-home sales and months' supply" },
  { match: /housing vacanc/i, indicators: ['homeownerVacancy', 'rentalVacancy'], label: 'Vacancy rates' },
];

/**
 * Publication rules for sources whose calendar we cannot read.
 *
 * These are the agencies' long-standing schedules, not scraped data. They are
 * ESTIMATES and the UI says so; the point is to flag an overdue series, not to
 * promise a date.
 */
const RELEASE_RULES = {
  bls_employment: { cadence: 'monthly', rule: 'First Friday of the month after the reference month', lagDays: 38, series: ['unemploymentRate', 'residentialConstructionJobs', 'residentialTradeJobs', 'constructionJobs', 'totalNonfarm'] },
  bls_cpi:        { cadence: 'monthly', rule: 'Mid-month, about the 13th, for the prior month',      lagDays: 44, series: ['cpiShelter'] },
  freddie_pmms:   { cadence: 'weekly',  rule: 'Thursdays',                                            lagDays: 7,  series: ['mortgage30yr'] },
  umich:          { cadence: 'monthly', rule: 'Preliminary mid-month, final end of month',            lagDays: 45, series: ['consumerSentiment'] },
  fed_g19:        { cadence: 'monthly', rule: 'About the fifth business day, two months in arrears',  lagDays: 68, series: ['revolvingCredit'] },
  fed_delinq:     { cadence: 'quarterly', rule: 'About 8 weeks after quarter end',                    lagDays: 130, series: ['creditCardDelinquency'] },
  caseshiller:    { cadence: 'monthly', rule: 'Last Tuesday, two months in arrears',                  lagDays: 88, series: ['caseShiller'] },
  redfin:         { cadence: 'monthly', rule: 'Mid-month for the prior month',                        lagDays: 50, series: Object.keys({ medianSalePrice: 1, monthsOfSupply: 1, inventory: 1, priceDrops: 1 }) },
};

/**
 * Freshness per series: how old the newest observation is, and whether that
 * exceeds what the publication schedule would imply. This is entirely
 * data-derived — no external calendar needed — and it is the check that actually
 * matters: a series that has stopped updating is invisible otherwise, because a
 * stale chart looks exactly like a flat one.
 */
function computeFreshness(bundle) {
  const out = {};
  const now = Date.now();
  const ruleFor = (name) => Object.values(RELEASE_RULES).find((r) => r.series.includes(name));

  /**
   * Median spacing between the last two years of observations. This is how the
   * cadence is determined -- measured, not assumed.
   *
   * The first version used a hand-written lag table and flagged 24 of 36 series
   * as overdue, which said more about the table than about the data. Reference
   * dates are not publication dates: a monthly figure stamped 2026-05-01 is
   * published in mid-June, so its age measured from the reference date is
   * routinely 60-90 days even when perfectly current. Deriving the interval per
   * series sidesteps that guesswork entirely and adapts to weekly, monthly and
   * quarterly series without a lookup.
   */
  const medianIntervalDays = (pts) => {
    const recent = pts.slice(-24);
    if (recent.length < 3) return null;
    const gaps = [];
    for (let i = 1; i < recent.length; i++) {
      gaps.push((new Date(recent[i].date + 'T00:00:00Z') - new Date(recent[i - 1].date + 'T00:00:00Z')) / 86_400_000);
    }
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  };

  for (const [group, series] of Object.entries(bundle)) {
    for (const [name, pts] of Object.entries(series || {})) {
      if (!Array.isArray(pts) || !pts.length) { out[name] = { group, ok: false }; continue; }
      const last = pts[pts.length - 1];
      const ageDays = Math.round((now - new Date(last.date + 'T00:00:00Z').getTime()) / 86_400_000);
      const interval = medianIntervalDays(pts);
      const rule = ruleFor(name);

      // Flag only after roughly two whole periods have been missed on top of the
      // normal publication lag. Anything tighter fires on healthy series;
      // anything looser misses a feed that has genuinely stopped.
      const threshold = interval ? Math.max(45, Math.round(interval * 3)) : 120;

      out[name] = {
        group,
        ok: true,
        latest: last.date,
        latestValue: last.value,
        ageDays,
        intervalDays: interval,
        expectedMaxAgeDays: threshold,
        overdue: ageDays > threshold,
        cadence: !interval ? 'unknown' : interval <= 10 ? 'weekly' : interval <= 45 ? 'monthly' : interval <= 130 ? 'quarterly' : 'annual',
        rule: rule?.rule || null,
      };
    }
  }
  return out;
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


/**
 * Candidate replacements for the stalled Redfin feed.
 *
 * Redfin's public S3 file carries last-modified 2026-06-02 and stops at the May
 * period — their publication has stalled, which is not something we can fix from
 * here. Since Redfin supplies five model indicators and about 47% of the weight,
 * leaning on a three-month-old feed quietly degrades the whole gauge.
 *
 * Realtor.com publishes an equivalent monthly residential-listings series
 * through FRED: active listings, new listings, days on market, price reductions
 * and median list price, keyless and current. Between that and NAR's existing-home
 * months' supply, every stalled Redfin indicator has a live counterpart.
 *
 * Probed rather than assumed — FRED ids get renumbered, and this sandbox cannot
 * reach the API to confirm one.
 */
const RESALE_CANDIDATES = {
  activeListings:     ['ACTLISCOUUS'],
  newListings:        ['NEWLISCOUUS'],
  medianDaysOnMarket: ['MEDDAYONMARUS'],
  priceReducedCount:  ['PRIREDCOUUS'],
  medianListPrice:    ['MEDLISPRIUS'],
  totalListings:      ['TOTLISCOUUS'],
  existingMonthsSupply: ['HOSSUPUSM673N'],
  existingHomeSales:  ['EXHOSLUSM495S', 'HOSSLDUSM495S'],
  pendingSales:       ['HSN1FNSA', 'PENSALEUS'],
};

async function probeResaleSubstitutes() {
  const info = {};
  const start = new Date();
  start.setFullYear(start.getFullYear() - HISTORY_YEARS);
  const cosd = start.toISOString().slice(0, 10);

  for (const [name, ids] of Object.entries(RESALE_CANDIDATES)) {
    for (const id of ids) {
      try {
        const pts = await fetchFredCsv(id, cosd);
        info[name] = { id, n: pts.length, first: pts[0], last: pts[pts.length - 1] };
        break;
      } catch (e) {
        info[name] = { failed: (info[name]?.failed || []).concat(`${id}: ${e.message.slice(0, 80)}`) };
      }
    }
  }
  report.resaleSubstitutes = info;
  return info;
}


/**
 * Realtor.com residential-listings series, via FRED — the live stand-in for the
 * stalled Redfin feed.
 *
 * IMPORTANT: these are NOT drop-in equivalents of Redfin's columns. Redfin's
 * `price_drops` is the share of listings that cut their asking price in the
 * month; Realtor.com's price-reduced count divided by active listings is a
 * stock, not a flow, and runs materially higher. Median LIST price is not median
 * SALE price. The two sources are therefore kept as separate series with their
 * own names, and the risk model carries separate thresholds for each — never
 * assume a Redfin threshold transfers.
 */
async function doResale() {
  const info = { resolved: {}, failed: {} };
  const start = new Date();
  start.setFullYear(start.getFullYear() - HISTORY_YEARS);
  const cosd = start.toISOString().slice(0, 10);

  const ids = {
    activeListings: 'ACTLISCOUUS',
    newListings: 'NEWLISCOUUS',
    medianDaysOnMarket: 'MEDDAYONMARUS',
    priceReducedCount: 'PRIREDCOUUS',
    medianListPrice: 'MEDLISPRIUS',
    existingMonthsSupply: 'HOSSUPUSM673N',
    existingHomeSales: 'EXHOSLUSM495S',
  };

  const raw = {};
  for (const [name, id] of Object.entries(ids)) {
    try {
      raw[name] = await fetchFredCsv(id, cosd);
      info.resolved[name] = { id, n: raw[name].length, last: raw[name][raw[name].length - 1] };
    } catch (e) {
      raw[name] = null;
      info.failed[name] = e.message.slice(0, 120);
    }
  }

  // Price-reduced SHARE: the count is meaningless without the denominator, and
  // the denominator only exists on dates both series cover.
  if (raw.priceReducedCount && raw.activeListings) {
    const active = new Map(raw.activeListings.map((p) => [p.date, p.value]));
    raw.priceReducedShare = raw.priceReducedCount
      .map((p) => {
        const a = active.get(p.date);
        return a && a > 0 && Number.isFinite(p.value) ? { date: p.date, value: (p.value / a) * 100 } : null;
      })
      .filter(Boolean);
    info.resolved.priceReducedShare = { id: 'PRIREDCOUUS / ACTLISCOUUS', n: raw.priceReducedShare.length, last: raw.priceReducedShare[raw.priceReducedShare.length - 1] };
  }

  // Months of supply, derived where NAR's own series is too short to chart.
  // EXHOSLUSM495S is a seasonally adjusted ANNUAL rate, so the monthly pace is
  // that divided by twelve.
  if (raw.activeListings && raw.existingHomeSales) {
    const sales = new Map(raw.existingHomeSales.map((p) => [p.date, p.value]));
    raw.derivedMonthsOfSupply = raw.activeListings
      .map((p) => {
        const s = sales.get(p.date);
        return s && s > 0 ? { date: p.date, value: p.value / (s / 12) } : null;
      })
      .filter(Boolean);
    info.resolved.derivedMonthsOfSupply = { id: 'ACTLISCOUUS / (EXHOSLUSM495S / 12)', n: raw.derivedMonthsOfSupply.length, last: raw.derivedMonthsOfSupply[raw.derivedMonthsOfSupply.length - 1] };
  }

  info.ok = Object.values(raw).some((v) => v?.length);
  report.sources.resale = info;
  return raw;
}


/**
 * Zillow Research public CSVs.
 *
 * Zillow publishes its research data as free public CSVs for anyone to use with
 * attribution — a very different footing from a licensed calendar product, so
 * these are fair to read and republish provided the credit is shown, which the
 * comparison page does.
 *
 * Of the three portals, Zillow is the only one that publishes a machine-readable
 * FORECAST: ZHVF, their one-year home-value growth projection. Realtor.com and
 * Redfin publish annual outlooks as prose in articles, which is not something to
 * parse into a number.
 *
 * The files are wide: RegionID, SizeRank, RegionName, RegionType, StateName,
 * then one column per month. The national row is RegionName "United States".
 */
const ZILLOW_BASE = 'https://files.zillowstatic.com/research/public_csvs';
const ZILLOW_FILES = {
  homeValueIndex:   `${ZILLOW_BASE}/zhvi/Metro_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv`,
  homeValueForecast:`${ZILLOW_BASE}/zhvf_growth/Metro_zhvf_growth_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv`,
  inventory:        `${ZILLOW_BASE}/invt_fs/Metro_invt_fs_uc_sfrcondo_sm_month.csv`,
  newListings:      `${ZILLOW_BASE}/new_listings/Metro_new_listings_uc_sfrcondo_sm_month.csv`,
  daysToPending:    `${ZILLOW_BASE}/med_doz_pending/Metro_med_doz_pending_uc_sfrcondo_sm_month.csv`,
  priceCutShare:    `${ZILLOW_BASE}/perc_listings_price_cut/Metro_perc_listings_price_cut_uc_sfrcondo_sm_month.csv`,
  medianSalePrice:  `${ZILLOW_BASE}/median_sale_price/Metro_median_sale_price_uc_sfrcondo_sm_sa_month.csv`,
};

/** Pull the "United States" row out of a wide Zillow CSV and melt it long. */
function zillowNationalSeries(csvText) {
  const { header, rows } = parseCsv(csvText);
  const nameCol = header.find((h) => /^RegionName$/i.test(h));
  if (!nameCol) throw new Error(`No RegionName column. Header starts: ${header.slice(0, 6).join(', ')}`);
  const row = rows.find((r) => String(r[nameCol]).trim() === 'United States');
  if (!row) throw new Error('No "United States" row in this file.');
  const dateCols = header.filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h));
  const pts = dateCols
    .map((d) => ({ date: `${d.slice(0, 7)}-01`, value: num(row[d]) }))
    .filter((p) => p.value !== null);
  return { points: pts, dateColumns: dateCols.length, meta: { sizeRank: row.SizeRank, regionType: row.RegionType } };
}

async function doZillow() {
  const info = { attribution: 'Zillow Group, Zillow Research public data', resolved: {}, failed: {} };
  const out = {};
  for (const [name, url] of Object.entries(ZILLOW_FILES)) {
    try {
      const { data } = await get(url, { as: 'text', timeoutMs: 120_000, init: { headers: { 'User-Agent': UA } } });
      const { points, dateColumns } = zillowNationalSeries(String(data));
      out[name] = points;
      info.resolved[name] = { n: points.length, dateColumns, first: points[0], last: points[points.length - 1] };
    } catch (e) {
      out[name] = null;
      info.failed[name] = e.message.slice(0, 180);
    }
  }
  info.ok = Object.values(out).some((v) => v?.length);
  report.sources.zillow = info;
  return out;
}

// ------------------------------------------------------------------- main ---
const [census, bls, fred, redfin, calendarEvents, mirrors, resale, zillow] = await Promise.all([
  doCensus(), doBls(), doFred(), doRedfin(), doCalendar(), doMirrors(), doResale(), doZillow(),
]);
await probeRedfinFreshness();

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
write('resale', { series: resale, generatedAt: report.generatedAt });
write('zillow', { series: zillow, generatedAt: report.generatedAt, attribution: 'Zillow Group, Zillow Research' });

// The manifest is what the UI reports as source status, so it must describe the
// data that actually shipped -- not the raw fetch outcome. A Census fetch that
// failed for want of a key, whose every series was then filled from the FRED
// mirror, is a working panel sourced elsewhere; reporting it as "failed" next to
// a chart full of data is worse than useless. `calendar` and `mirrors` are a
// probe and a support layer, not user-facing sources, so they stay out.
const DATA_SOURCES = ['census', 'bls', 'fred', 'redfin', 'resale', 'zillow'];
const filledCount = Object.keys(filledFrom).length;

const manifest = {
  generatedAt: report.generatedAt,
  historyYears: HISTORY_YEARS,
  sources: Object.fromEntries(
    DATA_SOURCES.map((k) => {
      const v = report.sources[k] || {};
      const shipped =
        k === 'census'
          ? Object.values(censusOut).some((x) => x?.length)
          : Boolean(v.ok);
      const viaMirror = k === 'census' && filledCount > 0;
      return [
        k,
        {
          ok: shipped,
          // Keep the underlying reason visible even when the mirror saved us:
          // the user still wants to know a Census key would upgrade these.
          error: shipped ? null : v.error || null,
          note: viaMirror
            ? `${filledCount} series sourced from the FRED mirror because the primary Census API was unavailable` +
              (v.error ? ` (${v.error})` : '') +
              '. Add a CENSUS_API_KEY secret to read the primary and turn the mirror into a cross-check.'
            : null,
          cors: v.cors ?? null,
        },
      ];
    })
  ),
  mirrors: {
    resolved: Object.keys(report.sources.mirrors?.resolved || {}).length,
    failed: Object.keys(report.sources.mirrors?.failed || {}).length,
  },
};
manifest.crossChecks = Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, c.status]));
manifest.filledFromMirror = filledFrom;
write('manifest', manifest);
write('mirrors', { series: mirrors, generatedAt: report.generatedAt });

// ---- release calendar + per-series freshness -------------------------------
const nowIso = new Date().toISOString().slice(0, 10);
const allEvents = calendarEvents || [];
const tagged = allEvents.map((e) => {
  const hit = RELEASE_MAP.find((m) => m.match.test(e.title));
  return { ...e, indicators: hit?.indicators || [], affects: hit?.label || null, tracked: Boolean(hit) };
});
const freshness = computeFreshness({ census: censusOut, bls, fred, redfin, resale });

write('calendar', {
  generatedAt: report.generatedAt,
  // Published dates, from the agency's own listing.
  upcoming: tagged.filter((e) => e.date >= nowIso).slice(0, 60),
  recent: tagged.filter((e) => e.date < nowIso).slice(-30).reverse(),
  // Schedules we could not read, stated as rules rather than dates.
  derivedRules: RELEASE_RULES,
  freshness,
  notes: {
    census: 'Published dates, parsed from the Census economic-indicator calendar.',
    bls: 'BLS returns 403 to identified automated clients and its robots.txt is likewise unavailable, so its calendar is not read. BLS-backed series show a derived cadence instead.',
  },
});
report.freshness = freshness;
const overdue = Object.entries(freshness).filter(([, f]) => f.overdue);
if (overdue.length) {
  console.log('\nOVERDUE SERIES (older than the publication schedule implies):');
  for (const [k, f] of overdue) console.log(`  ${k}: latest ${f.latest}, ${f.ageDays}d old (expected <= ${f.expectedMaxAgeDays}d)`);
}
writeFileSync(join(ROOT, 'data-report.json'), JSON.stringify(report, null, 2), 'utf8');

console.log(JSON.stringify(manifest, null, 2));
const okCount = Object.values(manifest.sources).filter((s) => s.ok).length;
console.log(`\n${okCount}/4 sources fetched successfully.`);
// Never fail the job: a partial snapshot is more useful than none, and the
// report explains exactly what was missing.
