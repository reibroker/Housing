/**
 * ============================================================================
 * Composite Housing Price-Decline Pressure Score
 * ============================================================================
 *
 * WHAT THIS IS
 * A weighted average of fourteen published indicators, each mapped onto a
 * 0-100 scale where 100 means "maximum downward pressure on house prices".
 *
 * WHAT THIS IS NOT
 * A forecast. Nothing here is a trained model, a probability, or a prediction
 * of what prices will do. It is a scoreboard: it reads the conditions that have
 * historically preceded price weakness and summarizes how many of them are
 * currently flashing. Housing is local, slow-moving and policy-sensitive, and
 * every indicator below is revised after publication. Treat the number as a
 * structured way to look at fourteen charts at once, not as advice. It is not
 * investment advice and should not be used as the basis for a transaction.
 *
 * DESIGN PRINCIPLES
 *
 * 1. Transparent over clever. Each indicator is normalized by linear
 *    interpolation between two published, arguable thresholds -- not a z-score
 *    against whatever history you happened to load. That means the number means
 *    the same thing on every machine, and every threshold can be pointed at and
 *    disagreed with. The breakdown table shows the raw value, both thresholds,
 *    the resulting sub-score and the weight, so the total is fully auditable.
 *
 * 2. Degrade honestly. If a source fails, its indicators drop out and the
 *    remaining weights are renormalized. The UI reports coverage (the share of
 *    total weight that actually resolved) so a score computed from four of
 *    fourteen indicators is never mistaken for a complete one.
 *
 * 3. Balance leading and confirming signals. Price drops and months of supply
 *    move first; construction employment and delinquencies confirm later. Both
 *    are included, weighted toward the leading ones.
 *
 * THRESHOLD SOURCES
 * The balanced-market anchors come from long-run norms in the underlying
 * series: roughly 4-6 months of supply as the traditional balanced range,
 * ~1.5% homeowner vacancy as the pre-2006 norm, ~0.5pp Sahm-rule unemployment
 * drift as a recession marker. They are judgement calls, deliberately visible
 * and deliberately editable -- change any number in INDICATORS and the gauge
 * updates with it.
 */

import { latest, pctChange, absChange, trailingMean, scaleToRisk, dropNulls, sortByDate } from '../lib/stats.js';

/** Helper: latest value of a series, or null. */
const val = (s) => latest(s)?.value ?? null;
const asOf = (s) => latest(s)?.date ?? null;

/**
 * The Sahm-style labour signal: current 3-month average unemployment rate minus
 * its minimum over the prior 12 months. A rise of ~0.5pp has historically
 * coincided with recession onset, and forced selling follows job loss.
 */
function unemploymentDrift(series) {
  const clean = dropNulls(sortByDate(series || []));
  if (clean.length < 15) return null;
  const recent3 = trailingMean(clean, 3);
  const priorYear = clean.slice(Math.max(0, clean.length - 15), clean.length - 3);
  if (!recent3 || priorYear.length === 0) return null;
  const min = Math.min(...priorYear.map((p) => p.value));
  return recent3 - min;
}

/**
 * Supply pipeline pressure: units under construction relative to the current
 * pace of sales. A large pipeline delivering into a slowing market is the
 * classic setup for builder price cuts.
 */
function pipelineRatio(underConstruction, newHomeSales) {
  const uc = val(underConstruction);
  const sales = val(newHomeSales);
  if (uc === null || sales === null || sales === 0) return null;
  return uc / sales;
}

/**
 * INDICATOR DEFINITIONS
 *
 * `low`  : the value that scores 0 (no downward pressure)
 * `high` : the value that scores 100 (maximum downward pressure)
 * When `high < low`, the relationship is inverted -- e.g. consumer sentiment,
 * where a LOW reading means MORE pressure. scaleToRisk handles both directions.
 */
export const INDICATORS = [
  // ---------------- Resale supply and demand (leading) ---------------------
  {
    key: 'monthsOfSupply',
    group: 'Resale supply',
    label: 'Months of supply (existing homes)',
    unit: 'months',
    weight: 0.13,
    source: 'Redfin',
    low: 2.5,
    high: 8,
    rationale:
      'The single most direct measure of market balance. Under ~4 months is a seller\'s market; above ~6 months buyers set the price. Above 8 months, price cuts are usually already underway.',
    extract: (d) => ({ value: val(d.redfin?.monthsOfSupply), asOf: asOf(d.redfin?.monthsOfSupply) }),
  },
  {
    key: 'priceDrops',
    group: 'Resale supply',
    label: 'Share of listings with a price drop',
    unit: '%',
    weight: 0.12,
    source: 'Redfin',
    low: 12,
    high: 30,
    rationale:
      'The earliest visible seller capitulation. Sellers cut asking prices months before closed-sale medians reflect it, so this leads the reported price data.',
    extract: (d) => ({ value: val(d.redfin?.priceDrops), asOf: asOf(d.redfin?.priceDrops) }),
  },
  {
    key: 'inventoryYoY',
    group: 'Resale supply',
    label: 'Active inventory, year-over-year change',
    unit: '%',
    weight: 0.09,
    source: 'Redfin',
    low: -10,
    high: 35,
    rationale:
      'Rising inventory means listings are accumulating faster than they clear. Sustained double-digit growth has preceded every regional price decline in the Redfin record.',
    extract: (d) => {
      const direct = val(d.redfin?.inventoryYoY);
      if (direct !== null) return { value: direct, asOf: asOf(d.redfin?.inventoryYoY) };
      // Fall back to computing it ourselves if Redfin's precomputed column is absent.
      return { value: pctChange(d.redfin?.inventory, 12), asOf: asOf(d.redfin?.inventory) };
    },
  },
  {
    key: 'demandTrend',
    group: 'Resale demand',
    label: 'Homes sold, year-over-year change',
    unit: '%',
    weight: 0.07,
    source: 'Redfin',
    low: 8,
    high: -20,
    rationale:
      'Volume turns before price. Transactions falling year over year while inventory builds is the combination that forces price discovery downward.',
    extract: (d) => {
      const direct = val(d.redfin?.homesSoldYoY);
      if (direct !== null) return { value: direct, asOf: asOf(d.redfin?.homesSoldYoY) };
      return { value: pctChange(d.redfin?.homesSold, 12), asOf: asOf(d.redfin?.homesSold) };
    },
  },
  {
    key: 'saleToList',
    group: 'Resale demand',
    label: 'Average sale-to-list price ratio',
    unit: '%',
    weight: 0.06,
    source: 'Redfin',
    low: 101,
    high: 96,
    rationale:
      'Buyers paying above asking signals excess demand; sustained sales below list means sellers are conceding at the closing table.',
    extract: (d) => ({ value: val(d.redfin?.saleToListRatio), asOf: asOf(d.redfin?.saleToListRatio) }),
  },

  // ---------------- New construction supply --------------------------------
  {
    key: 'newHomeMonthsSupply',
    group: 'New construction',
    label: "New-home months' supply",
    unit: 'months',
    weight: 0.08,
    source: 'Census (New Home Sales)',
    low: 4,
    high: 10,
    rationale:
      'Builders carry inventory they must move, so they discount and buy down mortgage rates faster than individual sellers. Elevated new-home supply pulls the whole local price level down.',
    extract: (d) => ({ value: val(d.census?.newHomeMonthsSupply), asOf: asOf(d.census?.newHomeMonthsSupply) }),
  },
  {
    key: 'constructionPipeline',
    group: 'New construction',
    label: 'Units under construction per unit of monthly new-home sales',
    unit: 'ratio',
    weight: 0.07,
    source: 'Census (Residential Construction + New Home Sales)',
    low: 1.0,
    high: 2.5,
    rationale:
      'Measures how much supply is already committed and must be delivered regardless of demand. A large pipeline meeting a slowing market is what turns a slowdown into price cuts.',
    extract: (d) => ({
      value: pipelineRatio(d.census?.underConstruction, d.census?.newHomeSales),
      asOf: asOf(d.census?.underConstruction),
    }),
  },
  {
    key: 'permitsTrend',
    group: 'New construction',
    label: 'Building permits, year-over-year change',
    unit: '%',
    weight: 0.06,
    source: 'Census (Building Permits)',
    low: 10,
    high: -25,
    rationale:
      'Permits are the earliest published read on builder conviction. Builders see contract cancellations and traffic before any price index does, and they stop pulling permits first.',
    extract: (d) => ({ value: pctChange(d.census?.permitsTotal, 12), asOf: asOf(d.census?.permitsTotal) }),
  },
  {
    key: 'homeownerVacancy',
    group: 'New construction',
    label: 'Homeowner vacancy rate',
    unit: '%',
    weight: 0.04,
    source: 'Census (Housing Vacancies)',
    low: 0.8,
    high: 2.2,
    rationale:
      'Empty owned homes are latent supply. The rate ran near 1.5-1.7% before 2006 and peaked near 2.9% in the crash; sustained increases signal genuine oversupply rather than a pause.',
    extract: (d) => ({ value: val(d.census?.homeownerVacancy), asOf: asOf(d.census?.homeownerVacancy) }),
  },

  // ---------------- Labour market (confirming) ------------------------------
  {
    key: 'unemploymentDrift',
    group: 'Labour market',
    label: 'Unemployment rate drift (3-mo avg vs prior-year low)',
    unit: 'pp',
    weight: 0.10,
    source: 'BLS',
    low: 0,
    high: 1.0,
    rationale:
      'Job loss is what converts a soft market into a distressed one: it turns discretionary sellers into forced sellers. A rise of ~0.5pp above the prior-year low is the Sahm-rule recession marker.',
    extract: (d) => ({ value: unemploymentDrift(d.bls?.unemploymentRate), asOf: asOf(d.bls?.unemploymentRate) }),
  },
  {
    key: 'residentialJobs',
    group: 'Labour market',
    label: 'Residential construction employment, year-over-year change',
    unit: '%',
    weight: 0.06,
    source: 'BLS',
    low: 4,
    high: -8,
    rationale:
      'Builders cut crews before they cut prices publicly. Falling residential construction payrolls is an insider signal that the people closest to the market expect less work.',
    extract: (d) => {
      const resi = d.bls?.residentialConstructionJobs;
      const fallback = d.bls?.constructionJobs;
      const series = resi && resi.length ? resi : fallback;
      return { value: pctChange(series, 12), asOf: asOf(series) };
    },
  },

  // ---------------- Affordability and household finances -------------------
  {
    key: 'mortgageRate',
    group: 'Affordability & credit',
    label: '30-year fixed mortgage rate, change vs 12 months ago',
    unit: 'pp',
    weight: 0.06,
    source: 'Freddie Mac via FRED',
    low: -1.0,
    high: 1.5,
    rationale:
      'Buyers shop by monthly payment, so rate increases cut purchasing power directly. Rising rates compress what a given household can bid, which shows up in prices with a lag of a few months.',
    extract: (d) => ({ value: absChange(d.fred?.mortgage30yr, 52), asOf: asOf(d.fred?.mortgage30yr) }),
  },
  {
    key: 'consumerSentiment',
    group: 'Affordability & credit',
    label: 'Consumer sentiment (U. Michigan)',
    unit: 'index',
    weight: 0.03,
    source: 'U. Michigan via FRED',
    low: 95,
    high: 55,
    rationale:
      'Buying a house is the largest discretionary commitment most households make, and they defer it when they feel insecure. Low sentiment thins the buyer pool even when rates and jobs look fine.',
    extract: (d) => ({ value: val(d.fred?.consumerSentiment), asOf: asOf(d.fred?.consumerSentiment) }),
  },
  {
    key: 'creditStress',
    group: 'Affordability & credit',
    label: 'Credit card delinquency rate',
    unit: '%',
    weight: 0.03,
    source: 'Federal Reserve via FRED',
    low: 2.0,
    high: 5.0,
    rationale:
      'Households fall behind on cards well before they fall behind on a mortgage. Rising card delinquency is an early read on the balance-sheet stress that eventually produces distressed listings.',
    extract: (d) => ({ value: val(d.fred?.creditCardDelinquency), asOf: asOf(d.fred?.creditCardDelinquency) }),
  },
];

export const RISK_BANDS = [
  { min: 0, max: 20, label: 'Low', tone: 'low', blurb: 'Conditions favour sellers. Supply is tight relative to demand and the financing and labour backdrop is supportive.' },
  { min: 20, max: 40, label: 'Moderate', tone: 'moderate', blurb: 'A normalizing market. Some measures have loosened from their tightest readings but nothing points to broad price declines.' },
  { min: 40, max: 60, label: 'Elevated', tone: 'elevated', blurb: 'Meaningful softening. Supply is building and demand indicators are rolling over. Flat to modestly negative prices are consistent with this reading.' },
  { min: 60, max: 80, label: 'High', tone: 'high', blurb: 'Multiple leading indicators are signalling downward pressure at once. Markets with these readings have generally seen nominal price declines.' },
  { min: 80, max: 100, label: 'Severe', tone: 'severe', blurb: 'Broad-based stress across supply, demand, labour and credit simultaneously. Historically rare outside 2007-2011.' },
];

export function bandFor(score) {
  if (!Number.isFinite(score)) return null;
  return RISK_BANDS.find((b) => score >= b.min && score <= b.max) || RISK_BANDS[RISK_BANDS.length - 1];
}

/**
 * Compute the composite score.
 *
 * @param {object} data  { redfin, census, bls, fred } -- each a map of series
 * @returns {{
 *   score: number|null,
 *   band: object|null,
 *   coverage: number,
 *   available: number,
 *   total: number,
 *   contributions: Array<object>,
 *   byGroup: Array<object>
 * }}
 */
export function computeRiskScore(data) {
  const contributions = INDICATORS.map((ind) => {
    let value = null;
    let observedAt = null;
    let error = null;

    try {
      const got = ind.extract(data) || {};
      value = Number.isFinite(got.value) ? got.value : null;
      observedAt = got.asOf || null;
    } catch (e) {
      // A malformed series must never take down the whole gauge.
      error = e.message;
    }

    const subScore = value === null ? null : scaleToRisk(value, ind.low, ind.high);

    return {
      ...ind,
      value,
      observedAt,
      subScore,
      available: subScore !== null,
      error,
      // Filled in below, once we know the renormalized weights.
      effectiveWeight: 0,
      contribution: 0,
    };
  });

  const available = contributions.filter((c) => c.available);
  const availableWeight = available.reduce((s, c) => s + c.weight, 0);
  const totalWeight = INDICATORS.reduce((s, c) => s + c.weight, 0);

  if (availableWeight === 0) {
    return {
      score: null,
      band: null,
      coverage: 0,
      available: 0,
      total: INDICATORS.length,
      contributions,
      byGroup: [],
    };
  }

  // Renormalize over the indicators that actually resolved, so a missing source
  // shifts the mix rather than dragging the score toward zero.
  let score = 0;
  for (const c of contributions) {
    if (!c.available) continue;
    c.effectiveWeight = c.weight / availableWeight;
    c.contribution = c.subScore * c.effectiveWeight;
    score += c.contribution;
  }

  const groups = new Map();
  for (const c of contributions) {
    if (!groups.has(c.group)) groups.set(c.group, { group: c.group, weight: 0, contribution: 0, available: 0, total: 0 });
    const g = groups.get(c.group);
    g.total += 1;
    if (c.available) {
      g.available += 1;
      g.weight += c.effectiveWeight;
      g.contribution += c.contribution;
    }
  }

  const byGroup = [...groups.values()].map((g) => ({
    ...g,
    // The group's own average sub-score, independent of its share of the total.
    groupScore: g.weight > 0 ? g.contribution / g.weight : null,
  }));

  return {
    score,
    band: bandFor(score),
    coverage: availableWeight / totalWeight,
    available: available.length,
    total: INDICATORS.length,
    contributions: contributions.sort((a, b) => b.contribution - a.contribution),
    byGroup: byGroup.sort((a, b) => b.weight - a.weight),
  };
}

/**
 * Backtest-lite: recompute a simplified score at each historical month using
 * only the indicators available as a full time series, so the gauge can be
 * plotted against actual Case-Shiller year-over-year price change.
 *
 * This is intentionally a subset of the live model -- several indicators
 * (vacancy, delinquency) are quarterly and would force interpolation. It exists
 * to let you eyeball whether the score has led price turns historically, not as
 * a validated backtest.
 */
export function historicalScore(data) {
  const specs = [
    { series: data.redfin?.monthsOfSupply, low: 2.5, high: 8, weight: 0.28 },
    { series: data.redfin?.priceDrops, low: 12, high: 30, weight: 0.25 },
    { series: data.redfin?.inventoryYoY, low: -10, high: 35, weight: 0.19 },
    { series: data.redfin?.saleToListRatio, low: 101, high: 96, weight: 0.13 },
    { series: data.bls?.unemploymentRate, low: 3.5, high: 7.5, weight: 0.15 },
  ].filter((s) => s.series && s.series.length);

  if (specs.length === 0) return [];

  const dates = new Set();
  specs.forEach((s) => s.series.forEach((p) => Number.isFinite(p.value) && dates.add(p.date)));

  const lookup = specs.map((s) => ({ ...s, map: new Map(s.series.map((p) => [p.date, p.value])) }));

  return [...dates]
    .sort()
    .map((date) => {
      let w = 0;
      let acc = 0;
      for (const s of lookup) {
        const v = s.map.get(date);
        if (!Number.isFinite(v)) continue;
        const sub = scaleToRisk(v, s.low, s.high);
        if (sub === null) continue;
        acc += sub * s.weight;
        w += s.weight;
      }
      // Require at least half the weight present before publishing a point,
      // otherwise the early months read as artificially calm.
      return w >= 0.5 ? { date, value: acc / w } : { date, value: null };
    })
    .filter((p) => p.value !== null);
}
