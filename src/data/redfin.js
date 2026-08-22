/**
 * Redfin Data Center -- public market tracker files.
 *
 * Redfin publishes its market tracker as gzipped, tab-separated files in a
 * public S3 bucket. There is no API and no key. The files are plain objects:
 *
 *   national : redfin_market_tracker/us_national_market_tracker.tsv000.gz
 *   state    : redfin_market_tracker/state_market_tracker.tsv000.gz
 *   metro    : redfin_market_tracker/redfin_metro_market_tracker.tsv000.gz
 *   county   : redfin_market_tracker/county_market_tracker.tsv000.gz
 *
 * ---------------------------------------------------------------------------
 * The CORS problem, and how this module handles it
 * ---------------------------------------------------------------------------
 * S3 buckets only send `Access-Control-Allow-Origin` if the bucket owner has
 * configured a CORS policy, and Redfin's is a data-distribution bucket, not a
 * web API. It may or may not allow browser reads from your origin, and that can
 * change without notice. So this module does not assume either way -- it tries
 * the direct fetch and, if the browser blocks it, hands control to a file-drop
 * fallback:
 *
 *   1. Direct streamed fetch from S3.
 *   2. Dev-server or user-supplied proxy, if configured.
 *   3. `loadRedfinFromFile()` -- the user downloads the .tsv.gz themselves and
 *      drags it onto the page. It is gunzipped and parsed in the browser by
 *      exactly the same code path, so the dashboard is identical either way.
 *
 * Option 3 is why this app can stay backend-free without depending on a third
 * party's CORS configuration.
 *
 * ---------------------------------------------------------------------------
 * Memory
 * ---------------------------------------------------------------------------
 * The national file is a few MB; county and ZIP files are hundreds of MB
 * uncompressed. We stream-parse and filter row by row (see lib/tsv.js) and keep
 * only the ~8 columns and the region rows we actually chart, so peak memory
 * stays in the low megabytes even for the large files.
 */

import { parseTsvStream, num, HAS_DECOMPRESSION_STREAM } from '../lib/tsv.js';
import { buildAttemptUrls } from '../lib/http.js';
import { cacheGet, cacheSet, cacheGetStale } from '../lib/cache.js';
import { getConfig } from '../config/env.js';
import { acquire } from '../lib/rateLimiter.js';

const S3 = 'https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_market_tracker';

export const REDFIN_FILES = {
  national: { url: `${S3}/us_national_market_tracker.tsv000.gz`, label: 'US national', approxMB: 3 },
  state: { url: `${S3}/state_market_tracker.tsv000.gz`, label: 'By state', approxMB: 60 },
  metro: { url: `${S3}/redfin_metro_market_tracker.tsv000.gz`, label: 'By metro', approxMB: 120 },
};

/** The only columns we need. Restricting them keeps parsed rows small. */
const COLUMNS = [
  'period_begin',
  'period_end',
  'period_duration',
  'region_type',
  'region',
  'state_code',
  'property_type',
  'is_seasonally_adjusted',
  'median_sale_price',
  'median_sale_price_yoy',
  'homes_sold',
  'homes_sold_yoy',
  'new_listings',
  'inventory',
  'inventory_yoy',
  'months_of_supply',
  'median_dom',
  'avg_sale_to_list',
  'sold_above_list',
  'price_drops',
];

/**
 * Row filter. Redfin ships every property type and both seasonal-adjustment
 * flavours in the same file, so without this you get 8 overlapping series.
 */
function makeFilter({ propertyType = 'All Residential', stateCode = null, region = null }) {
  return (row) => {
    if (row.property_type !== propertyType) return false;
    // Monthly rows only (period_duration is in days: 1, 7, 30, 90).
    if (row.period_duration && row.period_duration !== '30') return false;
    if (stateCode && row.state_code !== stateCode) return false;
    if (region && row.region !== region) return false;
    return true;
  };
}

/** Collapse filtered rows into the named time series the dashboard charts. */
function toSeries(rows) {
  const pick = (field, transform = num) => {
    const byDate = new Map();
    for (const r of rows) {
      const date = normalizeDate(r.period_begin);
      if (!date) continue;
      const v = transform(r[field]);
      if (v !== null) byDate.set(date, v);
    }
    return [...byDate.entries()]
      .map(([date, value]) => ({ date, value }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  };

  // Redfin stores rates as fractions (0.0834); charts want percent.
  const pct = (v) => {
    const n = num(v);
    return n === null ? null : n * 100;
  };

  return {
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
}

function normalizeDate(v) {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v).trim());
  return m ? `${m[1]}-${m[2]}-01` : null;
}

/**
 * Fetch and parse a Redfin file straight from S3.
 *
 * @param {'national'|'state'|'metro'} level
 * @param {object} opts  { stateCode, region, onProgress }
 */
export async function loadRedfin(level = 'national', opts = {}) {
  const cfg = getConfig();
  const file = REDFIN_FILES[level];
  if (!file) throw new Error(`Unknown Redfin level "${level}".`);

  const cacheKey = `redfin:${level}:${opts.stateCode || 'us'}:${opts.region || 'all'}`;
  const hit = cacheGet(cacheKey, cfg.cacheTtlMinutes);
  if (hit) {
    return { series: hit.value, meta: { via: `cache:${hit.tier}`, cached: true, stale: false, ageMs: hit.ageMs, level } };
  }

  if (!HAS_DECOMPRESSION_STREAM) {
    const e = new Error(
      'This browser cannot decompress gzip in-page, so the Redfin file cannot be read directly. ' +
        'Use a current Chrome, Edge, Firefox 113+ or Safari 16.4+.'
    );
    e.kind = 'config';
    throw e;
  }

  const attempts = buildAttemptUrls(file.url, '/proxy/redfin');
  const errors = [];

  for (const attempt of attempts) {
    try {
      await acquire('redfin', false);

      // A long timeout: these files are large and the S3 transfer dominates.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 180_000);

      let res;
      try {
        res = await fetch(attempt.url, { signal: ctrl.signal, credentials: 'omit' });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from the Redfin data bucket.`);
      if (!res.body) throw new Error('This browser did not expose a readable response stream.');

      const { rows, totalRows } = await parseTsvStream(res.body, {
        gzipped: true,
        columns: COLUMNS,
        filter: makeFilter(opts),
        onProgress: opts.onProgress,
      });

      if (rows.length === 0) {
        throw new Error(
          `Parsed ${totalRows.toLocaleString()} rows but none matched the filter ` +
            `(property type "All Residential"${opts.stateCode ? `, state ${opts.stateCode}` : ''}). ` +
            'Redfin may have changed its column values.'
        );
      }

      const series = toSeries(rows);
      cacheSet(cacheKey, series);
      return {
        series,
        meta: { via: attempt.via, cached: false, stale: false, ageMs: 0, level, rowsParsed: totalRows, rowsKept: rows.length },
      };
    } catch (e) {
      const isCors = e instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(e.message || '');
      errors.push(
        isCors
          ? new Error(
              "The browser blocked the read from Redfin's S3 bucket (no Access-Control-Allow-Origin header). " +
                'This is expected for a data bucket rather than an API.'
            )
          : e
      );
    }
  }

  const stale = cacheGetStale(cacheKey);
  if (stale) {
    return { series: stale.value, meta: { via: 'cache:stale', cached: true, stale: true, ageMs: stale.ageMs, level, error: errors[0] } };
  }

  const err = new Error(
    `Could not load the Redfin ${file.label} file.\n` +
      errors.map((e) => `- ${e.message}`).join('\n') +
      `\n\nFallback: download ${file.url} yourself and drop the .tsv.gz onto the panel below. ` +
      'It will be gunzipped and parsed in your browser by the same code, with no upload to any server.'
  );
  err.kind = 'cors';
  err.fallbackUrl = file.url;
  throw err;
}

/**
 * Parse a Redfin file the user dropped onto the page.
 *
 * The File object exposes `.stream()`, so this is the identical streaming path
 * used for the network fetch -- nothing is uploaded anywhere, and a 200MB file
 * never lands in memory as a whole.
 */
export async function loadRedfinFromFile(file, opts = {}) {
  const gzipped = /\.gz$/i.test(file.name);
  if (gzipped && !HAS_DECOMPRESSION_STREAM) {
    const e = new Error('This browser cannot gunzip in-page. Decompress the file first, then drop the .tsv.');
    e.kind = 'config';
    throw e;
  }

  const { rows, totalRows } = await parseTsvStream(file.stream(), {
    gzipped,
    columns: COLUMNS,
    filter: makeFilter(opts),
    onProgress: opts.onProgress,
  });

  if (rows.length === 0) {
    throw new Error(
      `Parsed ${totalRows.toLocaleString()} rows from "${file.name}" but none matched the filter. ` +
        'Check that this is a Redfin market tracker file and that the state selection matches its contents.'
    );
  }

  const series = toSeries(rows);
  const cacheKey = `redfin:${opts.level || 'upload'}:${opts.stateCode || 'us'}:${opts.region || 'all'}`;
  cacheSet(cacheKey, series);

  return {
    series,
    meta: { via: 'file-upload', cached: false, stale: false, ageMs: 0, fileName: file.name, rowsParsed: totalRows, rowsKept: rows.length },
  };
}
