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
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
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
await page.route('**/redfin-public-data.s3**', (route) => {
  route.fulfill({ status: 200, contentType: 'application/gzip', headers: { 'access-control-allow-origin': '*' }, body: REDFIN_GZ });
});

// A key must be present or the Census panels short-circuit by design.
await page.addInitScript(() => {
  localStorage.setItem('hmd:settings:censusKey', 'TEST_KEY');
  localStorage.setItem('hmd:settings:blsKey', 'TEST_KEY');
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

// Every tab must mount.
for (const label of ['Inventory & demand', 'Construction & permits', 'Employment', 'Credit & confidence', 'Data sources', 'Settings']) {
  await page.getByRole('tab', { name: label }).click();
  await page.waitForTimeout(700);
  const charts = await page.locator('.recharts-surface, table').count();
  check(`tab "${label}" mounts with content`, charts > 0, `${charts} chart/table nodes`);
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
  localStorage.setItem('hmd:demo', 'true');
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
await demoPage.getByRole('tab', { name: 'Overview' }).click();
await demoPage.waitForTimeout(700);
await demoPage.screenshot({ path: 'smoke-demo.png', fullPage: false });
check('no errors in demo mode', demoErrors.filter((e) => !/favicon|DevTools/i.test(e)).length === 0, demoErrors.join(' | ').slice(0, 300));
await demoPage.close();

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
