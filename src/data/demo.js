/**
 * Demo data generator.
 *
 * WHY THIS EXISTS
 * The app needs a Census API key and four reachable hosts before it shows
 * anything. That is a poor first run: you cannot tell whether an empty chart
 * means "no key", "CORS blocked" or "I built it wrong". Demo mode removes every
 * external dependency so the whole UI -- charts, gauge, breakdown, table views,
 * themes -- can be exercised offline, on a tablet, or in a static deploy with no
 * credentials at all.
 *
 * HONESTY REQUIREMENT
 * These numbers are SYNTHETIC. They are shaped to resemble a market that cools
 * over several years so the gauge has something meaningful to do, but they are
 * invented and must never be mistaken for published statistics. Every series
 * carries `synthetic: true` in its metadata, the UI shows a persistent banner
 * while demo mode is on, and the gauge is labelled DEMO. If you extend this
 * file, keep all three.
 *
 * The generator is deterministic (seeded PRNG), so screenshots and the smoke
 * test are reproducible across runs and machines.
 */

/** Mulberry32 -- small, fast, deterministic. Not cryptographic; doesn't need to be. */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Month starts from `years` ago through the current month. */
function monthAxis(years) {
  const out = [];
  const now = new Date();
  const start = new Date(now.getFullYear() - years, now.getMonth(), 1);
  const d = new Date(start);
  while (d <= now) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`);
    d.setMonth(d.getMonth() + 1);
  }
  return out;
}

/**
 * Build a series that travels from `from` to `to` along an S-curve, with a
 * seasonal cycle and a little noise. The S-curve matters: housing turns are
 * gradual then sudden, and a straight ramp makes every year-over-year
 * calculation suspiciously constant.
 *
 * @param {string[]} dates
 * @param {object} opts
 * @param {number} opts.from      value at the start of the window
 * @param {number} opts.to        value at the end
 * @param {number} opts.seasonal  amplitude of the 12-month cycle, as a fraction
 * @param {number} opts.noise     amplitude of random jitter, as a fraction
 * @param {number} opts.seed
 * @param {number} opts.midpoint  0-1, where the transition happens
 */
function curve(dates, { from, to, seasonal = 0, noise = 0.01, seed = 1, midpoint = 0.55, steepness = 9 }) {
  const rng = makeRng(seed);
  const n = dates.length;
  return dates.map((date, i) => {
    const t = n === 1 ? 1 : i / (n - 1);
    const s = 1 / (1 + Math.exp(-steepness * (t - midpoint)));
    const base = from + (to - from) * s;
    const month = Number(date.slice(5, 7));
    const season = seasonal ? Math.sin(((month - 3) / 12) * 2 * Math.PI) * seasonal * Math.abs(base) : 0;
    const jitter = (rng() - 0.5) * 2 * noise * Math.abs(base);
    return { date, value: Number((base + season + jitter).toFixed(4)) };
  });
}

/** Quarterly subset, for series Census and the Fed publish quarterly. */
const quarterly = (series) => series.filter((p) => [1, 4, 7, 10].includes(Number(p.date.slice(5, 7))));

/** Weekly-ish subset, for the mortgage rate series. */
function weekly(dates, opts) {
  const monthly = curve(dates, opts);
  const out = [];
  for (const p of monthly) {
    for (let w = 0; w < 4; w++) {
      const d = new Date(`${p.date}T00:00:00`);
      d.setDate(d.getDate() + w * 7);
      const rng = makeRng(opts.seed + w + Number(p.date.slice(0, 4)));
      out.push({
        date: d.toISOString().slice(0, 10),
        value: Number((p.value + (rng() - 0.5) * 0.12).toFixed(3)),
      });
    }
  }
  return out;
}

/**
 * Generate a full synthetic bundle in the exact shape the real adapters return.
 *
 * @param {number} years  history window
 * @returns {{census:object, bls:object, fred:object, redfin:object, meta:object}}
 */
export function generateDemoData(years = 12) {
  const m = monthAxis(years);

  // A market that runs hot, peaks, then cools -- so the gauge has a real arc.
  const redfin = {
    medianSalePrice: curve(m, { from: 258000, to: 402000, seasonal: 0.02, noise: 0.008, seed: 11, midpoint: 0.45 }),
    medianSalePriceYoY: curve(m, { from: 5.5, to: -1.8, seasonal: 0.05, noise: 0.06, seed: 12, midpoint: 0.62 }),
    homesSold: curve(m, { from: 465000, to: 352000, seasonal: 0.18, noise: 0.03, seed: 13, midpoint: 0.5 }),
    homesSoldYoY: curve(m, { from: 6.0, to: -9.5, seasonal: 0.08, noise: 0.09, seed: 14, midpoint: 0.55 }),
    newListings: curve(m, { from: 520000, to: 470000, seasonal: 0.22, noise: 0.03, seed: 15 }),
    inventory: curve(m, { from: 900000, to: 1180000, seasonal: 0.12, noise: 0.02, seed: 16, midpoint: 0.6 }),
    inventoryYoY: curve(m, { from: -8.0, to: 21.0, seasonal: 0.06, noise: 0.08, seed: 17, midpoint: 0.6 }),
    monthsOfSupply: curve(m, { from: 2.1, to: 5.4, seasonal: 0.09, noise: 0.03, seed: 18, midpoint: 0.6 }),
    medianDaysOnMarket: curve(m, { from: 21, to: 48, seasonal: 0.16, noise: 0.04, seed: 19, midpoint: 0.58 }),
    saleToListRatio: curve(m, { from: 101.4, to: 97.9, seasonal: 0.004, noise: 0.002, seed: 20, midpoint: 0.5 }),
    soldAboveList: curve(m, { from: 44, to: 17, seasonal: 0.12, noise: 0.05, seed: 21, midpoint: 0.52 }),
    priceDrops: curve(m, { from: 11.5, to: 25.0, seasonal: 0.14, noise: 0.05, seed: 22, midpoint: 0.6 }),
  };

  const census = {
    permitsTotal: curve(m, { from: 1310, to: 1265, seasonal: 0.03, noise: 0.025, seed: 31, midpoint: 0.5 }),
    permitsSingle: curve(m, { from: 880, to: 845, seasonal: 0.035, noise: 0.025, seed: 32 }),
    startsTotal: curve(m, { from: 1265, to: 1215, seasonal: 0.04, noise: 0.03, seed: 33 }),
    startsSingle: curve(m, { from: 855, to: 810, seasonal: 0.04, noise: 0.03, seed: 34 }),
    underConstruction: curve(m, { from: 1120, to: 1425, seasonal: 0.01, noise: 0.01, seed: 35, midpoint: 0.5 }),
    completions: curve(m, { from: 1180, to: 1490, seasonal: 0.035, noise: 0.025, seed: 36, midpoint: 0.65 }),
    newHomeSales: curve(m, { from: 690, to: 615, seasonal: 0.06, noise: 0.04, seed: 37 }),
    newHomeMonthsSupply: curve(m, { from: 5.1, to: 8.4, seasonal: 0.04, noise: 0.03, seed: 38, midpoint: 0.58 }),
    newHomesForSale: curve(m, { from: 330, to: 465, seasonal: 0.02, noise: 0.015, seed: 39, midpoint: 0.55 }),
    homeownerVacancy: quarterly(curve(m, { from: 0.9, to: 1.3, noise: 0.05, seed: 40, midpoint: 0.65 })),
    rentalVacancy: quarterly(curve(m, { from: 5.8, to: 7.1, noise: 0.04, seed: 41, midpoint: 0.6 })),
  };

  const bls = {
    residentialConstructionJobs: curve(m, { from: 855, to: 905, seasonal: 0.02, noise: 0.006, seed: 51, midpoint: 0.55, steepness: 6 }),
    residentialTradeJobs: curve(m, { from: 2280, to: 2410, seasonal: 0.025, noise: 0.006, seed: 52, midpoint: 0.55 }),
    constructionJobs: curve(m, { from: 7350, to: 8180, seasonal: 0.02, noise: 0.005, seed: 53 }),
    totalNonfarm: curve(m, { from: 150800, to: 160400, seasonal: 0.005, noise: 0.002, seed: 54 }),
    unemploymentRate: curve(m, { from: 3.6, to: 4.7, noise: 0.03, seed: 55, midpoint: 0.72, steepness: 12 }),
    cpiShelter: curve(m, { from: 305, to: 392, noise: 0.002, seed: 56, midpoint: 0.4 }),
    stateUnemploymentRate: null,
  };

  const fred = {
    mortgage30yr: weekly(m, { from: 3.4, to: 6.6, noise: 0.02, seed: 61, midpoint: 0.5, steepness: 11 }),
    consumerSentiment: curve(m, { from: 88, to: 62, noise: 0.05, seed: 62, midpoint: 0.45 }),
    revolvingCredit: curve(m, { from: 1010, to: 1372, seasonal: 0.006, noise: 0.004, seed: 63, midpoint: 0.5 }),
    creditCardDelinquency: quarterly(curve(m, { from: 2.1, to: 3.6, noise: 0.03, seed: 64, midpoint: 0.66 })),
    caseShiller: curve(m, { from: 205, to: 322, seasonal: 0.006, noise: 0.003, seed: 65, midpoint: 0.42 }),
    existingHomeSales: curve(m, { from: 5_380_000, to: 4_120_000, seasonal: 0.09, noise: 0.03, seed: 66, midpoint: 0.55 }),
  };

  const meta = { via: 'demo', synthetic: true, cached: false, stale: false, ageMs: 0 };

  return {
    census,
    bls,
    fred,
    redfin,
    meta,
    // Per-dataset meta so the Data Sources panel renders consistently.
    censusMeta: { resconst: meta, ressales: meta, hv: meta },
    fredMeta: Object.fromEntries(Object.keys(fred).map((k) => [k, meta])),
  };
}
