/**
 * End-to-end smoke test.
 *
 * Loads the built app in a real browser with every upstream host intercepted and
 * served synthetic-but-correctly-shaped payloads, then asserts that:
 *   - no console errors or page exceptions occur
 *   - each adapter parses its format (Census JSON, BLS envelope, FRED CSV,
 *     gzipped Redfin TSV) into charts
 *   - the composite gauge renders a numeric score at full coverage
 *   - every tab mounts without crashing
 *
 * This is what catches the class of bug a `vite build` cannot: a Recharts prop
 * that only throws at render time, a parser that silently yields zero rows, a
 * null dereference in the risk model.
 */
import { chromium } from 'playwright';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };

const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  if (!existsSync(file)) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------------------
// Regression (Node-side, no browser needed): Redfin ships its market tracker
// with UPPERCASE column headers while every published example uses lowercase.
// Exact-match column selection silently produced zero rows, which read
// downstream as "Redfin has no data" rather than "wrong case".
// ---------------------------------------------------------------------------
{
  const { parseTsvStream } = await import('../src/lib/tsv.js');
  const { Readable } = await import('node:stream');
  const gz = gzipSync(Buffer.from([
    ['PERIOD_BEGIN', 'PERIOD_DURATION', 'PROPERTY_TYPE', 'MONTHS_OF_SUPPLY'].join('\t'),
    ['2026-06-01', '30', 'All Residential', '4.2'].join('\t'),
  ].join('\n')));
  const { rows } = await parseTsvStream(Readable.toWeb(Readable.from([gz])), {
    gzipped: true,
    columns: ['period_begin', 'period_duration', 'property_type', 'months_of_supply'],
    filter: (r) => r.property_type === 'All Residential',
  });
  if (rows.length !== 1 || rows[0].months_of_supply !== '4.2') {
    console.log('FAIL  uppercase TSV headers resolve to the requested lowercase keys');
    process.exit(1);
  }
  console.log('PASS  uppercase TSV headers resolve to the requested lowercase keys');
}

// ------------------------------------------------------------------ fixtures
const months = [];
for (let y = 2019; y <= 2026; y++) for (let m = 1; m <= 12; m++) {
  if (y === 2026 && m > 6) break;
  months.push(`${y}-${String(m).padStart(2, '0')}`);
}

function censusFixture(pairs) {
  const header = ['cell_value', 'data_type_code', 'category_code', 'seasonally_adj', 'time_slot_id', 'error_data', 'time', 'us'];
  const rows = [header];
  months.forEach((t, i) => {
    for (const [cat, dt, base] of pairs) {
      rows.push([String(base + Math.round(Math.sin(i / 6) * base * 0.12)), dt, cat, 'yes', '0', 'no', t, '1']);
    }
  });
  return rows;
}

const CENSUS = {
  resconst: censusFixture([
    ['APERMITS', 'TOTAL', 1450], ['APERMITS', 'SINGLE', 950],
    ['STARTS', 'TOTAL', 1380], ['STARTS', 'SINGLE', 900],
    ['UNDERCONST', 'TOTAL', 1600], ['COMPLETIONS', 'TOTAL', 1500],
  ]),
  ressales: censusFixture([
    ['SOLD', 'TOTAL', 660], ['MSACCT', 'TOTAL', 8], ['FORSALE', 'TOTAL', 480],
  ]),
  hv: censusFixture([['HOMEOWNER', 'RATE', 1], ['RENTAL', 'RATE', 7]]),
};

function blsFixture(ids) {
  return {
    status: 'REQUEST_SUCCEEDED', responseTime: 10, message: [],
    Results: {
      series: ids.map((id) => ({
        seriesID: id,
        data: months.slice().reverse().map((t, i) => {
          const [year, mm] = t.split('-');
          const base = id.startsWith('LNS') || id.startsWith('LASST') ? 4.2 : id.startsWith('CU') ? 330 : 900;
          return { year, period: `M${mm}`, periodName: 'X', value: String((base + Math.sin(i / 5) * base * 0.05).toFixed(1)), footnotes: [] };
        }),
      })),
    },
  };
}

function fredFixture(id) {
  const base = { MORTGAGE30US: 6.5, UMCSENT: 68, REVOLSL: 1300, DRCCLACBS: 3.2, CSUSHPINSA: 320, EXHOSLUSM495S: 4100000 }[id] ?? 100;
  const lines = ['observation_date,' + id];
  months.forEach((t, i) => lines.push(`${t}-01,${(base + Math.sin(i / 7) * base * 0.06).toFixed(3)}`));
  return lines.join('\n');
}

const CALENDAR_FIXTURE = {
  generatedAt: new Date().toISOString(),
  upcoming: [
    { title: 'New Residential Construction', url: 'https://www.census.gov/construction/nrc/',
      releaseAt: '2026-09-17T08:30:00-05:00', date: '2026-09-17', time: '8:30 AM',
      referencePeriod: 'August 2026', source: 'Census',
      indicators: ['permitsTotal', 'startsTotal'], affects: 'Permits, starts, completions', tracked: true },
    { title: 'Advance Retail Sales', releaseAt: '2026-09-15T08:30:00-05:00', date: '2026-09-15',
      time: '8:30 AM', referencePeriod: 'August 2026', source: 'Census', indicators: [], affects: null, tracked: false },
  ],
  recent: [
    { title: 'New Residential Sales', releaseAt: '2026-08-25T10:00:00-05:00', date: '2026-08-25',
      time: '10:00 AM', referencePeriod: 'July 2026', source: 'Census',
      indicators: ['newHomeSales'], affects: "New-home sales and months' supply", tracked: true },
  ],
  derivedRules: {},
  freshness: {
    monthsOfSupply: { group: 'redfin', ok: true, latest: '2026-05-01', latestValue: 3.36, ageDays: 116, intervalDays: 31, expectedMaxAgeDays: 93, overdue: true, cadence: 'monthly', rule: 'Mid-month for the prior month' },
    unemploymentRate: { group: 'bls', ok: true, latest: '2026-07-01', latestValue: 4.1, ageDays: 30, intervalDays: 31, expectedMaxAgeDays: 93, overdue: false, cadence: 'monthly', rule: 'First Friday' },
  },
  notes: { census: 'Published dates.', bls: 'BLS refuses automated clients; derived cadence shown.' },
};

const REDFIN_COLS = ['period_begin','period_end','period_duration','region_type','region','state_code','property_type','is_seasonally_adjusted','median_sale_price','median_sale_price_yoy','homes_sold','homes_sold_yoy','new_listings','inventory','inventory_yoy','months_of_supply','median_dom','avg_sale_to_list','sold_above_list','price_drops'];
const redfinRows = [REDFIN_COLS.join('\t')];
months.forEach((t, i) => {
  const w = Math.sin(i / 8);
  redfinRows.push([
    `${t}-01`, `${t}-28`, '30', 'national', 'National', '', 'All Residential', 'f',
    String(Math.round(400000 + w * 20000)), (0.03 + w * 0.02).toFixed(4),
    String(Math.round(420000 + w * 30000)), (-0.05 + w * 0.03).toFixed(4),
    String(Math.round(500000 + w * 40000)), String(Math.round(900000 + w * 90000)),
    (0.15 + w * 0.1).toFixed(4), (4.5 + w).toFixed(2), String(Math.round(40 + w * 10)),
    (0.99 + w * 0.01).toFixed(4), (0.28 + w * 0.05).toFixed(4), (0.22 + w * 0.06).toFixed(4),
  ].join('\t'));
});
const REDFIN_GZ = gzipSync(Buffer.from(redfinRows.join('\n'), 'utf8'));

// ---------------------------------------------------------------- run
/**
 * Locate a browser.
 *
 * On CI and on a normal dev machine, Playwright resolves its own bundled
 * Chromium and `executablePath` must be left undefined. Some sandboxed
 * environments instead ship a preinstalled Chromium at a fixed path and block
 * the download, so we probe PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH and a couple of
 * known locations first. Hardcoding a path here breaks CI; hardcoding nothing
 * breaks the sandbox -- hence the probe.
 */
function findChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH
      ? ['chromium/chrome-linux/chrome', 'chromium-1194/chrome-linux/chrome'].map((p) =>
          join(process.env.PLAYWRIGHT_BROWSERS_PATH, p)
        )
      : []),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

const executablePath = findChromium();
if (executablePath) console.log(`Using preinstalled Chromium at ${executablePath}`);

const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  // Required in most containers, harmless elsewhere.
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.route('**/api.census.gov/**', (route) => {
  const ds = /eits\/(\w+)/.exec(route.request().url())?.[1];
  route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(CENSUS[ds] || [[]]) });
});
await page.route('**/api.bls.gov/**', (route) => {
  const req = route.request();
  let ids = [];
  try { ids = JSON.parse(req.postData() || '{}').seriesid || []; } catch { /* GET */ }
  if (!ids.length) ids = [decodeURIComponent(req.url().split('/data/')[1].split('?')[0])];
  route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(blsFixture(ids)) });
});
await page.route('**/fred.stlouisfed.org/**', (route) => {
  const id = new URL(route.request().url()).searchParams.get('id');
  route.fulfill({ status: 200, contentType: 'text/csv', headers: { 'access-control-allow-origin': '*' }, body: fredFixture(id) });
});
// The calendar is same-origin JSON published with the snapshot. A clean clone
// has none, so serve it here rather than letting the live pass 404 on a file
// whose absence is a normal development state.
await page.route('**/data/calendar.json', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CALENDAR_FIXTURE) })
);
await page.route('**/redfin-public-data.s3**', (route) => {
  route.fulfill({ status: 200, contentType: 'application/gzip', headers: { 'access-control-allow-origin': '*' }, body: REDFIN_GZ });
});

// A key must be present or the Census panels short-circuit by design.
await page.addInitScript(() => {
  localStorage.setItem('hmd:settings:censusKey', 'TEST_KEY');
  localStorage.setItem('hmd:settings:blsKey', 'TEST_KEY');
  localStorage.setItem('hmd:mode', 'live');   // exercise the direct-fetch adapters
});

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); };

const scoreText = await page.locator('.gauge-value').first().innerText();
const score = parseInt(scoreText, 10);
check('gauge renders a numeric score', Number.isFinite(score) && score >= 0 && score <= 100, scoreText.replace(/\s+/g, ' '));

const coverage = await page.locator('.coverage').first().innerText();
check('coverage is 100% with all sources mocked', /100%/.test(coverage), coverage.replace(/\s+/g, ' '));

const band = await page.locator('.gauge-band').first().innerText().catch(() => '');
check('risk band is labelled in text, not colour alone', /pressure/i.test(band), band);

const rows = await page.locator('table').first().locator('tbody tr').count();
check('breakdown table populated', rows > 0, `${rows} rows`);

// Every tab must mount. "Compare sources" and "Releases" read `resale` and
// `zillow`, which ONLY exist in snapshot mode — live mode never fetches them and
// demo never generates them. Opening those tabs in the other two modes used to
// take down the whole app via the error boundary, and the suite missed it because
// it only ever opened them in the snapshot pass. Every tab, in every mode, now.
for (const label of ['Inventory & demand', 'Construction & permits', 'Employment', 'Credit & confidence', 'Compare sources', 'Releases', 'Data sources', 'Settings']) {
  await page.getByRole('tab', { name: label }).click();
  await page.waitForTimeout(700);
  // "Content" includes an explanatory empty state: a tab whose source is not
  // available in this mode should say so, not render a chart.
  const nodes = await page.locator('.recharts-surface, table, .notice, .dropzone').count();
  const crashed = await page.locator('.notice.error', { hasText: 'unrecoverable' }).count();
  check(`tab "${label}" mounts with content`, nodes > 0 && crashed === 0, `${nodes} nodes, ${crashed} crashes`);
}

// Census code resolution must have matched every declared series.
await page.getByRole('tab', { name: 'Data sources' }).click();
await page.waitForTimeout(500);
const noMatch = await page.locator('.badge.err', { hasText: 'no match' }).count();
check('all Census series resolved against the fixture codes', noMatch === 0, `${noMatch} unmatched`);

// Table-view twin must work.
await page.getByRole('tab', { name: 'Inventory & demand' }).click();
await page.waitForTimeout(700);
const tableBtn = page.getByRole('button', { name: 'Table' }).first();
if (await tableBtn.count()) {
  await tableBtn.click();
  await page.waitForTimeout(300);
  check('table view toggles on', (await page.locator('.table-wrap table').count()) > 0);
}

await page.getByRole('tab', { name: 'Overview' }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: 'smoke-overview.png', fullPage: false });
await page.getByRole('tab', { name: 'Inventory & demand' }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: 'smoke-supply.png', fullPage: false });

// ---------------------------------------------------------------------------
// Demo mode: a second page with NO routes intercepted and NO keys set. If any
// request escapes, or any panel needs one, this fails -- which is exactly the
// guarantee demo mode is supposed to give (works offline, keyless, in a static
// deploy).
// ---------------------------------------------------------------------------
const demoPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const demoErrors = [];
const escaped = [];
demoPage.on('console', (m) => { if (m.type() === 'error') demoErrors.push(m.text()); });
demoPage.on('pageerror', (e) => demoErrors.push(e.message));
// Any request to a non-local host is a leak.
demoPage.on('request', (r) => {
  const u = new URL(r.url());
  if (!['127.0.0.1', 'localhost'].includes(u.hostname)) escaped.push(r.url());
});
await demoPage.addInitScript(() => {
  localStorage.clear();
  localStorage.setItem('hmd:mode', 'demo');
});
await demoPage.goto(base, { waitUntil: 'networkidle' });
await demoPage.waitForTimeout(2000);

const demoScore = parseInt(await demoPage.locator('.gauge-value').first().innerText(), 10);
check('demo mode renders a score with no keys and no network', Number.isFinite(demoScore), String(demoScore));
check('demo mode makes zero external requests', escaped.length === 0, escaped.slice(0, 3).join(', '));
check('demo mode shows the synthetic-data banner', (await demoPage.locator('.demo-banner').count()) > 0);
check('demo mode stamps the gauge', (await demoPage.locator('.demo-stamp').count()) > 0);
// Regression guard: the gauge's filled arc must use large-arc-flag 0 at every
// score. Setting that flag from the value rather than the swept angle made any
// score above 50 render the complement of the arc -- a bug no "does it have a
// number" assertion catches. Demo mode scores above 50, so this exercises it.
const arcPaths = await demoPage.locator('.gauge-figure svg path').evaluateAll((els) =>
  els.map((e) => e.getAttribute('d'))
);
const arcFlagsOk = arcPaths.every((d) => {
  const m = /A\s[\d.]+\s[\d.]+\s0\s(\d)\s(\d)/.exec(d || '');
  return !m || m[1] === '0';
});
check('gauge arcs use the correct large-arc-flag at every score', arcFlagsOk, arcPaths.join(' | ').slice(0, 160));
check('gauge draws both a track and a value arc', arcPaths.length >= 2, `${arcPaths.length} paths`);

const demoCoverage = await demoPage.locator('.coverage').first().innerText();
check('demo mode resolves every indicator', /100%/.test(demoCoverage), demoCoverage.replace(/\s+/g, ' '));
for (const label of ['Inventory & demand', 'Construction & permits', 'Employment', 'Credit & confidence']) {
  await demoPage.getByRole('tab', { name: label }).click();
  await demoPage.waitForTimeout(500);
  check(`demo tab "${label}" renders charts`, (await demoPage.locator('.recharts-surface').count()) > 0);
}

// The tabs backed by sources demo mode does not generate must degrade, not crash.
for (const label of ['Compare sources', 'Releases']) {
  await demoPage.getByRole('tab', { name: label }).click();
  await demoPage.waitForTimeout(600);
  const crashed = await demoPage.locator('.notice.error', { hasText: 'unrecoverable' }).count();
  const content = await demoPage.locator('.card, .notice, table').count();
  check(`demo tab "${label}" degrades without crashing`, crashed === 0 && content > 0, `${content} nodes`);
}
// Demo promises no network at all — including the calendar.
check('demo mode still makes zero external requests after opening every tab', escaped.length === 0,
  escaped.slice(0, 3).join(', '));

// Demo mode must be synthetic all the way down: real Realtor.com/Zillow numbers
// left in state by a previous mode must not appear under the synthetic banner.
await demoPage.getByRole('tab', { name: 'Compare sources' }).click();
await demoPage.waitForTimeout(500);
const demoCompare = await demoPage.locator('.app').innerText();
check('demo mode does not leak real source data into the compare tab',
  !/1,126,252|1,389,936|428,950/.test(demoCompare), demoCompare.slice(0, 120).replace(/\s+/g, ' '));
await demoPage.getByRole('tab', { name: 'Overview' }).click();
await demoPage.waitForTimeout(700);
await demoPage.screenshot({ path: 'smoke-demo.png', fullPage: false });
check('no errors in demo mode', demoErrors.filter((e) => !/favicon|DevTools/i.test(e)).length === 0, demoErrors.join(' | ').slice(0, 300));
await demoPage.close();

// ---------------------------------------------------------------------------
// Snapshot mode: the default, and the only mode that fills every panel on a
// static host. Serves the same JSON shape scripts/fetch-data.mjs writes.
// ---------------------------------------------------------------------------
const snapSeries = (base, seasonal = 0) =>
  months.map((t, i) => ({ date: `${t}-01`, value: Number((base + Math.sin(i / 6) * base * 0.1 + seasonal).toFixed(3)) }));

const SNAP = {
  manifest: {
    generatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    historyYears: 12,
    sources: { census: { ok: true }, bls: { ok: true }, fred: { ok: true }, redfin: { ok: true } },
  },
  census: { generatedAt: new Date().toISOString(), series: {
    permitsTotal: snapSeries(1450), permitsSingle: snapSeries(950),
    startsTotal: snapSeries(1380), startsSingle: snapSeries(900),
    underConstruction: snapSeries(1600), completions: snapSeries(1500),
    newHomeSales: snapSeries(660), newHomeMonthsSupply: snapSeries(8),
    newHomesForSale: snapSeries(480), homeownerVacancy: snapSeries(1.1),
    rentalVacancy: snapSeries(7),
  }},
  bls: { generatedAt: new Date().toISOString(), series: {
    residentialConstructionJobs: snapSeries(900), residentialTradeJobs: snapSeries(2400),
    constructionJobs: snapSeries(8100), totalNonfarm: snapSeries(160000),
    unemploymentRate: snapSeries(4.3), cpiShelter: snapSeries(390),
    stateUnemploymentRate: null,
  }},
  fred: { generatedAt: new Date().toISOString(), series: {
    mortgage30yr: snapSeries(6.5), consumerSentiment: snapSeries(60),
    revolvingCredit: snapSeries(1351), creditCardDelinquency: snapSeries(3),
    caseShiller: snapSeries(330), existingHomeSales: snapSeries(4100000),
  }},
  calendar: {
    generatedAt: new Date().toISOString(),
    upcoming: [
      { title: 'New Residential Construction', url: 'https://www.census.gov/construction/nrc/', releaseAt: '2026-09-17T08:30:00-05:00',
        date: '2026-09-17', time: '8:30 AM', referencePeriod: 'August 2026', source: 'Census',
        indicators: ['permitsTotal', 'startsTotal'], affects: 'Permits, starts, completions', tracked: true },
      { title: 'Advance Retail Sales', releaseAt: '2026-09-15T08:30:00-05:00', date: '2026-09-15', time: '8:30 AM',
        referencePeriod: 'August 2026', source: 'Census', indicators: [], affects: null, tracked: false },
    ],
    recent: [
      { title: 'New Residential Sales', releaseAt: '2026-08-25T10:00:00-05:00', date: '2026-08-25', time: '10:00 AM',
        referencePeriod: 'July 2026', source: 'Census', indicators: ['newHomeSales'], affects: "New-home sales and months' supply", tracked: true },
    ],
    derivedRules: {},
    freshness: {
      monthsOfSupply: { group: 'redfin', ok: true, latest: '2026-05-01', latestValue: 3.36, ageDays: 116, intervalDays: 31, expectedMaxAgeDays: 93, overdue: true, cadence: 'monthly', rule: 'Mid-month for the prior month' },
      unemploymentRate: { group: 'bls', ok: true, latest: '2026-07-01', latestValue: 4.1, ageDays: 30, intervalDays: 31, expectedMaxAgeDays: 93, overdue: false, cadence: 'monthly', rule: 'First Friday' },
    },
    notes: { census: 'Published dates.', bls: 'BLS refuses automated clients; derived cadence shown.' },
  },
  zillow: { generatedAt: new Date().toISOString(), attribution: 'Zillow Group, Zillow Research', series: {
    homeValueIndex: snapSeries(371774), homeValueForecast: [{ date: '2027-07-01', value: 1.1 }],
    inventory: snapSeries(1389936), newListings: snapSeries(404817),
    daysToPending: snapSeries(21), priceCutShare: snapSeries(0.2557),
    medianSalePrice: snapSeries(371427),
  }},
  resale: { generatedAt: new Date().toISOString(), series: {
    activeListings: snapSeries(1126252), newListings: snapSeries(423732),
    medianDaysOnMarket: snapSeries(57), priceReducedShare: snapSeries(35.9),
    medianListPrice: snapSeries(428950), existingMonthsSupply: snapSeries(4.6),
    existingHomeSales: snapSeries(4060000), derivedMonthsOfSupply: snapSeries(3.33),
  }},
  redfin: { generatedAt: new Date().toISOString(), series: {
    medianSalePrice: snapSeries(400000), medianSalePriceYoY: snapSeries(2),
    homesSold: snapSeries(420000), homesSoldYoY: snapSeries(-5),
    newListings: snapSeries(500000), inventory: snapSeries(900000),
    inventoryYoY: snapSeries(15), monthsOfSupply: snapSeries(4.5),
    medianDaysOnMarket: snapSeries(40), saleToListRatio: snapSeries(99),
    soldAboveList: snapSeries(28), priceDrops: snapSeries(22),
  }},
};

const snapPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const snapErrors = [];
const snapExternal = [];
snapPage.on('console', (m) => { if (m.type() === 'error') snapErrors.push(m.text()); });
snapPage.on('pageerror', (e) => snapErrors.push(e.message));
snapPage.on('request', (r) => {
  const u = new URL(r.url());
  if (!['127.0.0.1', 'localhost'].includes(u.hostname)) snapExternal.push(r.url());
});
await snapPage.route('**/data/*.json', (route) => {
  const name = /data\/(\w+)\.json/.exec(route.request().url())?.[1];
  const body = SNAP[name];
  if (!body) return route.fulfill({ status: 404, body: 'nope' });
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});
await snapPage.addInitScript(() => { localStorage.clear(); });  // default mode = snapshot
await snapPage.goto(base, { waitUntil: 'networkidle' });
await snapPage.waitForTimeout(2000);

const snapScore = parseInt(await snapPage.locator('.gauge-value').first().innerText(), 10);
check('snapshot mode is the default and renders a score', Number.isFinite(snapScore), String(snapScore));
const snapCov = await snapPage.locator('.coverage').first().innerText();
check('snapshot mode resolves every indicator', /100%/.test(snapCov), snapCov.replace(/\s+/g, ' '));
check('snapshot mode needs no API key and no external host', snapExternal.length === 0, snapExternal.slice(0, 3).join(', '));
check('snapshot mode shows its build age', (await snapPage.locator('.notice.info').count()) > 0);

// Source substitution must be visible, not silent: the fixture's Redfin series
// are current, so Redfin should win; the assertion is that provenance is stated
// at all, which is what makes a fallback safe.
const breakdownText = await snapPage.locator('.app').innerText();
check('breakdown states which source each indicator used', /Redfin|Realtor\.com|NAR|BLS/.test(breakdownText));
for (const label of ['Inventory & demand', 'Construction & permits', 'Employment', 'Credit & confidence']) {
  await snapPage.getByRole('tab', { name: label }).click();
  await snapPage.waitForTimeout(400);
  check(`snapshot tab "${label}" renders charts`, (await snapPage.locator('.recharts-surface').count()) > 0);
}

// Compare tab: three sources, the forecast, and — most importantly — that the
// definitional differences are stated rather than presented as disagreement.
await snapPage.getByRole('tab', { name: 'Compare sources' }).click();
await snapPage.waitForTimeout(700);
const cmp = await snapPage.locator('.app').innerText();
check('compare tab shows all three portals', /Redfin/.test(cmp) && /Realtor\.com/.test(cmp) && /Zillow/.test(cmp));
check('compare tab surfaces the Zillow forecast', /1\.1%/.test(cmp));
check('compare tab flags non-comparable metrics', /Different definitions/.test(cmp));
check('compare tab explains days-on-market differs by definition', /days to PENDING|days to pending/i.test(cmp));
check('compare tab is honest that two forecasts are prose only', /prose only/.test(cmp));
check('compare tab credits Zillow', /Zillow Group/.test(cmp));
check('compare tab renders comparison charts', (await snapPage.locator('.recharts-surface').count()) >= 3);

// Releases tab: scheduled dates, overdue detection, and the BLS-refusal note.
await snapPage.getByRole('tab', { name: 'Releases' }).click();
await snapPage.waitForTimeout(600);
const relText = await snapPage.locator('.app').innerText();
check('releases tab lists a tracked upcoming release', /New Residential Construction/.test(relText));
check('releases tab excludes untracked releases from the main table',
  !/Advance Retail Sales/.test(relText.split('Freshness by series')[0]));
check('releases tab flags an overdue series', (await snapPage.locator('.badge.err', { hasText: 'overdue' }).count()) > 0);
check('releases tab marks a current series', (await snapPage.locator('.badge.ok', { hasText: 'current' }).count()) > 0);
check('releases tab states why BLS dates are derived', /BLS refuses automated clients/.test(relText));

// --- regressions for the audit round ---------------------------------------
// Snapshot data was badged green "live", indistinguishable from a direct fetch.
await snapPage.getByRole('tab', { name: 'Inventory & demand' }).click();
await snapPage.waitForTimeout(500);
const badgeText = (await snapPage.locator('.badge').allInnerTexts()).join(' ');
check('snapshot data is badged as a snapshot, not "live"',
  /snapshot/i.test(badgeText) && !/\blive\b/i.test(badgeText), badgeText.slice(0, 80));

// The state selector only scopes data in live mode; labelling national numbers
// with a state name was user-visible misinformation.
const stateSel = snapPage.locator('#state');
check('state selector is disabled when it cannot scope the data',
  await stateSel.isDisabled());

// Tabs are role="tab" and must therefore behave like tabs.
await snapPage.locator('[role="tab"]').first().focus();
await snapPage.keyboard.press('ArrowRight');
await snapPage.waitForTimeout(300);
check('arrow keys move tab selection',
  (await snapPage.locator('[role="tab"][aria-selected="true"]').innerText()) !== 'Overview');
check('exactly one tab is in the tab order (roving tabindex)',
  (await snapPage.evaluate(() => [...document.querySelectorAll('[role="tab"]')].filter((t) => t.tabIndex === 0).length)) === 1);
// Sweep every tab: a table with no accessible name is announced as
// "table, N columns" and is indistinguishable from the five beside it.
{
  let tablesSeen = 0;
  const unnamed = [];
  for (const t of ['Overview', 'Compare sources', 'Releases', 'Data sources', 'Settings']) {
    await snapPage.getByRole('tab', { name: t }).click();
    await snapPage.waitForTimeout(400);
    const found = await snapPage.evaluate(() => {
      const all = [...document.querySelectorAll('table')];
      return { total: all.length, bad: all.filter((x) => !x.getAttribute('aria-label')).length };
    });
    tablesSeen += found.total;
    if (found.bad) unnamed.push(`${t}:${found.bad}`);
  }
  check('every table has an accessible name', tablesSeen > 0 && unnamed.length === 0,
    `${tablesSeen} tables, unnamed: ${unnamed.join(',') || 'none'}`);
}

// Regression: snapshot meta is one flat object per source, but the UI indexes it
// per series/dataset. Without fanning it out, every provenance badge outside the
// Redfin panels silently vanished in the default mode.
await snapPage.getByRole('tab', { name: 'Credit & confidence' }).click();
await snapPage.waitForTimeout(500);
check('snapshot mode shows provenance badges on per-series panels',
  (await snapPage.locator('.badge').count()) >= 4, `${await snapPage.locator('.badge').count()} badges`);

// Regression: the Census resolution table only means something for live API
// calls. Rendering it from a snapshot marked all eleven series "no match".
await snapPage.getByRole('tab', { name: 'Data sources' }).click();
await snapPage.waitForTimeout(500);
check('snapshot mode does not claim Census codes failed to resolve',
  (await snapPage.locator('.badge.err', { hasText: 'no match' }).count()) === 0);
const srcText = await snapPage.locator('.app').innerText();
check('data sources tab lists Realtor.com and Zillow', /Realtor\.com/.test(srcText) && /Zillow Research/.test(srcText));
// Opening every table view on a phone used to push 159px of horizontal scroll
// onto the page, because a `1fr` grid track sizes to the table's min-content.
const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
await phone.route('**/data/*.json', (route) => {
  const name = /data\/(\w+)\.json/.exec(route.request().url())?.[1];
  const body = SNAP[name];
  if (!body) return route.fulfill({ status: 404, body: 'nope' });
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});
await phone.addInitScript(() => { localStorage.clear(); });
await phone.goto(base, { waitUntil: 'networkidle' });
await phone.waitForTimeout(1500);
await phone.getByRole('tab', { name: 'Inventory & demand' }).click();
await phone.waitForTimeout(700);
for (const btn of await phone.getByRole('button', { name: 'Table view' }).all()) {
  await btn.click();
  await phone.waitForTimeout(80);
}
await phone.waitForTimeout(500);
const overflow = await phone.evaluate(() => ({
  s: document.documentElement.scrollWidth,
  c: document.documentElement.clientWidth,
}));
check('no horizontal overflow at 390px with every table open',
  overflow.s <= overflow.c + 1, `scrollWidth ${overflow.s} vs client ${overflow.c}`);
await phone.close();

await snapPage.getByRole('tab', { name: 'Overview' }).click();
await snapPage.waitForTimeout(600);
await snapPage.screenshot({ path: 'smoke-snapshot.png', fullPage: false });
check('no errors in snapshot mode', snapErrors.filter((e) => !/favicon|DevTools/i.test(e)).length === 0, snapErrors.join(' | ').slice(0, 300));
await snapPage.close();

const ignorable = /favicon|Download the React DevTools/i;
const realConsole = consoleErrors.filter((e) => !ignorable.test(e));
check('no page exceptions', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400));
check('no console errors', realConsole.length === 0, realConsole.join(' | ').slice(0, 400));

await browser.close();
server.close();

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
