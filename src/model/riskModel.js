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

import { latest, pctChange, absChange, trailingMean, scaleToRisk, dropNulls, sortByDate, medianSpacingDays } from '../lib/stats.js';

/** Helper: latest value of a series, or null. */
const val = (s) => latest(s)?.value ?? null;
const asOf = (s) => latest(s)?.date ?? null;

/**
 * A source is only usable if it is still publishing.
 *
 * Redfin's public feed stalled in June 2026 — last-modified 2026-06-02, newest
 * period 2026-05 — while every other source stayed current. A stalled feed is
 * the most dangerous kind of failure here, because it does not error: the charts
 * render, the gauge computes, and the number is quietly three months old.
 * Indicators that can fall back to a live source do so automatically, and say
 * which one they used.
 */
/**
 * Staleness is judged against each series' OWN publication cadence.
 *
 * A fixed 75-day rule is wrong for a quarterly series: credit-card delinquency
 * and the vacancy rates cannot be fresher than roughly 90-120 days by
 * construction, so a flat threshold marks healthy series stale forever while
 * letting a stalled weekly series pass. Threshold = three intervals, floored at
 * 45 days — the same rule the pipeline uses for its freshness table.
 */
function staleAfterDays(series) {
  const spacing = medianSpacingDays(series);
  return spacing ? Math.max(45, Math.round(spacing * 3)) : 100;
}

function ageDays(series) {
  const l = latest(series);
  if (!l) return null;
  return (Date.now() - new Date(`${l.date}T00:00:00Z`).getTime()) / 86_400_000;
}

function isFresh(series) {
  const age = ageDays(series);
  return age !== null && age <= staleAfterDays(series);
}

/** Year-over-year percent change of a level series, as its own series. */
function yoyOf(series, periods = 12) {
  if (!series?.length) return null;
  return series.map((p, i) => {
    const prior = series[i - periods];
    return {
      date: p.date,
      value:
        prior && Number.isFinite(prior.value) && Number.isFinite(p.value) && prior.value !== 0
          ? ((p.value - prior.value) / Math.abs(prior.value)) * 100
          : null,
    };
  });
}

/**
 * Pick the first source that is both present and fresh, falling back to the
 * first present one if none are fresh (better a flagged stale number than a
 * hole). Each option carries its OWN thresholds: Redfin's price-drop share is a
 * monthly flow, Realtor.com's price-reduced share is a stock, and they sit on
 * different scales — reusing one source's calibration on another's series would
 * silently produce a wrong sub-score.
 */
/** A source needs enough history to be judged against, not just a latest value. */
const MIN_USABLE_OBSERVATIONS = 24;

/**
 * Rank sources on freshness FIRST, then on depth of history.
 *
 * Both properties matter and they trade off: FRED truncated the NAR series to 13
 * observations (current, but no context), while Redfin has 173 observations that
 * stopped three months ago. For a current-conditions gauge recency wins — a
 * stale number is wrong now, whereas a thin one is merely hard to contextualise
 * — so the order is:
 *
 *   fresh + deep  >  fresh  >  stale + deep  >  anything
 *
 * Requiring depth outright (an earlier attempt) inverted this and quietly put
 * three-month-old Redfin figures back in front of current ones. Indicators built
 * on year-over-year change are protected anyway: a 13-point input yields a
 * one-point YoY series, which sorts to the bottom on depth by construction.
 */
function pickSource(options) {
  const present = options.filter((o) => o.series?.length && Number.isFinite(latest(o.series)?.value));
  if (!present.length) return null;

  const rank = (o) => {
    const fresh = isFresh(o.series) ? 0 : 2;
    const deep = o.series.length >= MIN_USABLE_OBSERVATIONS ? 0 : 1;
    return fresh + deep;
  };
  const chosen = present.reduce((best, o) => (rank(o) < rank(best) ? o : best), present[0]);

  return {
    value: latest(chosen.series).value,
    asOf: asOf(chosen.series),
    low: chosen.low,
    high: chosen.high,
    sourceNote: chosen.note,
    stale: !isFresh(chosen.series),
  };
}

/**
 * The Sahm-style labour signal: current 3-month average unemployment rate minus
 * its minimum over the prior 12 months. A rise of ~0.5pp has historically
 * coincided with recession onset, and forced selling follows job loss.
 */
function unemploymentDrift(series) {
  const clean = dropNulls(sortByDate(series || []));
  if (clean.length < 15) return null;

  // The Sahm rule compares the current 3-month average against the MINIMUM OF
  // THE 3-MONTH AVERAGES over the prior twelve months — not against the minimum
  // of the raw monthly prints. Using raw minima is a one-sided upward bias,
  // because a single noisy low month drags the floor down and can never drag it
  // up. Measured across 97 computable months of the real series: mean absolute
  // error 0.13pp, worst overstatement 2.73pp (2021-04). On a [0, 1.0] scale that
  // is ~13 sub-points of systematic error.
  const ma3 = clean.map((p, i) =>
    i >= 2 ? { date: p.date, value: (clean[i].value + clean[i - 1].value + clean[i - 2].value) / 3 } : null
  ).filter(Boolean);
  if (ma3.length < 13) return null;

  const current = ma3[ma3.length - 1];

  // Window by CALENDAR DATE, not by array position. dropNulls has already
  // removed gaps, so "12 observations back" silently becomes 13+ months
  // whenever the series has an interior hole — and this series does (2025-10).
  const cutoff = new Date(`${current.date}T00:00:00Z`);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 12);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const prior = ma3.filter((p) => p.date >= cutoffIso && p.date < current.date);
  if (!prior.length) return null;

  return current.value - Math.min(...prior.map((p) => p.value));
}

/**
 * Supply pipeline pressure: units under construction relative to the current
 * sales pace. A large pipeline delivering into a slowing market is the classic
 * setup for builder price cuts.
 *
 * UNITS: `newHomeSales` is a seasonally adjusted ANNUAL rate while
 * `underConstruction` is a level, so this ratio is in YEARS of sales, not
 * months. The thresholds below are calibrated to that — 1.0 years is a lean
 * pipeline, 2.5 years is the kind of overhang that precedes builder discounting.
 * Dividing by twelve to make it monthly without recalibrating would pin the
 * indicator at 100 permanently.
 */
function pipelineRatio(underConstruction, newHomeSales) {
  // Both legs must describe the SAME month. Taking latest() of each
  // independently silently mixes periods the moment one series is revised or
  // published ahead of the other.
  const ucClean = dropNulls(sortByDate(underConstruction || []));
  const salesByDate = new Map(dropNulls(sortByDate(newHomeSales || [])).map((p) => [p.date, p.value]));
  for (let i = ucClean.length - 1; i >= 0; i--) {
    const sales = salesByDate.get(ucClean[i].date);
    if (Number.isFinite(sales) && sales !== 0) {
      return { value: ucClean[i].value / sales, asOf: ucClean[i].date };
    }
  }
  return null;
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
    extract: (d) =>
      pickSource([
        { series: d.redfin?.monthsOfSupply, low: 2.5, high: 8, note: 'Redfin' },
        // NAR runs ~0.67 months above Redfin on the overlap (mean 4.24 vs 3.56
        // across 11 shared months), so the whole band shifts rather than just
        // its floor — otherwise switching source alone added ~0.7 points to the
        // composite. NOTE the overlap is only 11 months: this is a level
        // correction, not a fitted calibration.
        { series: d.resale?.existingMonthsSupply, low: 3.2, high: 8.7, note: "NAR months' supply via FRED" },
        // `derivedMonthsOfSupply` (listings ÷ sales pace) is deliberately NOT
        // ranked here. It is a different construct from NAR's months' supply and
        // read 16.9 sub-points apart from it on the same month, which meant the
        // composite moved by 2.2 points depending on array order. Two
        // incompatible definitions must not share one indicator.
      ]) || {},
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
    extract: (d) =>
      pickSource([
        // Redfin: share of listings that CUT price this month (a flow).
        // Calibrated to the actual 173-month Redfin record: min 4.1, p25 8.5,
        // median 11.6, max 19.96. The old [12, 30] put the all-time high at
        // sub-score 44 and pinned 56% of history at 0 — a quarter of the
        // historical line's weight, dead half the time.
        { series: d.redfin?.priceDrops, low: 8, high: 20, note: 'Redfin, monthly price cuts' },
        // Realtor.com: share of active listings currently marked reduced (a
        // stock). Runs materially higher, so it gets its own calibration.
        { series: d.resale?.priceReducedShare, low: 18, high: 45, note: 'Realtor.com, listings currently reduced' },
      ]) || {},
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
    // A growth rate is scale-free, so both sources share one calibration here.
    extract: (d) =>
      pickSource([
        { series: d.redfin?.inventoryYoY, low: -10, high: 35, note: 'Redfin' },
        { series: yoyOf(d.resale?.activeListings), low: -10, high: 35, note: 'Realtor.com active listings' },
        { series: yoyOf(d.redfin?.inventory), low: -10, high: 35, note: 'Redfin, computed' },
      ]) || {},
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
    extract: (d) =>
      pickSource([
        { series: d.redfin?.homesSoldYoY, low: 8, high: -20, note: 'Redfin' },
        { series: yoyOf(d.resale?.existingHomeSales), low: 8, high: -20, note: 'NAR existing home sales via FRED' },
        { series: yoyOf(d.redfin?.homesSold), low: 8, high: -20, note: 'Redfin, computed' },
      ]) || {},
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
    // No live equivalent exists: Realtor.com publishes list prices, not the
    // sale-to-list ratio. Routed through pickSource anyway so that when Redfin
    // is stalled this indicator is visibly flagged rather than quietly carrying
    // a months-old value at full weight.
    extract: (d) =>
      pickSource([{ series: d.redfin?.saleToListRatio, low: 101, high: 96, note: 'Redfin (no live substitute)' }]) || {},
  },

  // ---------------- New construction supply --------------------------------
  {
    key: 'newHomeMonthsSupply',
    // Published monthly; flagged stale after roughly three missed periods.
    staleAfterDays: 93,
    group: 'New construction',
    label: "New-home months' supply",
    unit: 'months',
    // Reduced from 0.08. This is algebraically 12 x forSale/sales while
    // constructionPipeline is underConstruction/sales — the same denominator,
    // measured r = 0.809. At their old weights the pair put 0.15 of the model on
    // one series and contributed 28% of the score. constructionPipeline is the
    // stronger of the two (committed supply rather than a subset), so it keeps
    // the larger share.
    weight: 0.05,
    source: 'Census (New Home Sales)',
    low: 4,
    high: 10,
    rationale:
      'Builders carry inventory they must move, so they discount and buy down mortgage rates faster than individual sellers. Elevated new-home supply pulls the whole local price level down.',
    extract: (d) => ({ value: val(d.census?.newHomeMonthsSupply), asOf: asOf(d.census?.newHomeMonthsSupply) }),
  },
  {
    key: 'constructionPipeline',
    // Published monthly; flagged stale after roughly three missed periods.
    staleAfterDays: 93,
    group: 'New construction',
    label: 'Construction pipeline, in years of new-home sales',
    unit: 'years',
    weight: 0.08,
    source: 'Census (Residential Construction + New Home Sales)',
    low: 1.0,
    high: 2.5,
    rationale:
      'Units under construction divided by the annualized new-home sales rate: how long the committed pipeline would take to absorb at today\'s pace. It measures supply that must be delivered regardless of demand, which is what turns a slowdown into price cuts.',
    extract: (d) => pipelineRatio(d.census?.underConstruction, d.census?.newHomeSales) || {},
  },
  {
    key: 'permitsTrend',
    // Published monthly; flagged stale after roughly three missed periods.
    staleAfterDays: 93,
    group: 'New construction',
    label: 'Building permits, year-over-year change',
    unit: '%',
    weight: 0.07,
    source: 'Census (Building Permits)',
    low: 10,
    high: -25,
    rationale:
      'Permits are the earliest published read on builder conviction. Builders see contract cancellations and traffic before any price index does, and they stop pulling permits first.',
    extract: (d) => ({ value: pctChange(d.census?.permitsTotal, 12), asOf: asOf(d.census?.permitsTotal) }),
  },
  {
    key: 'homeownerVacancy',
    // Published quarterly; flagged stale after roughly three missed periods.
    staleAfterDays: 280,
    group: 'New construction',
    label: 'Homeowner vacancy rate',
    unit: '%',
    weight: 0.05,
    source: 'Census (Housing Vacancies)',
    // Observed range over the loaded window is 0.70-1.90; 2.2 encoded the
    // post-crash peak and capped the attainable sub-score at 79.
    low: 0.8,
    high: 2.0,
    rationale:
      'Empty owned homes are latent supply. The rate ran near 1.5-1.7% before 2006 and peaked near 2.9% in the crash; sustained increases signal genuine oversupply rather than a pause. Thresholds are set to the 12-year window the dashboard loads.',
    extract: (d) => ({ value: val(d.census?.homeownerVacancy), asOf: asOf(d.census?.homeownerVacancy) }),
  },

  // ---------------- Labour market (confirming) ------------------------------
  {
    key: 'unemploymentDrift',
    // Published monthly; flagged stale after roughly three missed periods.
    staleAfterDays: 93,
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
    // Published monthly; flagged stale after roughly three missed periods.
    staleAfterDays: 93,
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
    // Published weekly; flagged stale after roughly three missed periods.
    staleAfterDays: 30,
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
    // Published monthly; flagged stale after roughly three missed periods.
    staleAfterDays: 93,
    group: 'Affordability & credit',
    label: 'Consumer sentiment (U. Michigan)',
    unit: 'index',
    weight: 0.03,
    source: 'U. Michigan via FRED',
    // UMich has printed at or below 55 for four consecutive months and its
    // 143-month minimum is 44.8, so a `high` of 55 sat ABOVE the actual floor:
    // the indicator was clamped at 100 and contributed a constant, carrying no
    // information at all. 45 sits just under the record low, restoring
    // discrimination across the current regime.
    low: 90,
    high: 45,
    rationale:
      'Buying a house is the largest discretionary commitment most households make, and they defer it when they feel insecure. Low sentiment thins the buyer pool even when rates and jobs look fine.',
    extract: (d) => ({ value: val(d.fred?.consumerSentiment), asOf: asOf(d.fred?.consumerSentiment) }),
  },
  {
    key: 'creditStress',
    // Published quarterly; flagged stale after roughly three missed periods.
    staleAfterDays: 280,
    group: 'Affordability & credit',
    label: 'Credit card delinquency rate',
    unit: '%',
    weight: 0.03,
    source: 'Federal Reserve via FRED',
    // [2.0, 5.0] encoded the 2009 peak, but the app only loads 12 years, where
    // the observed max is 3.22 — the top 59% of the range was unreachable in any
    // data the user can see. Scaled to the visible window.
    low: 2.0,
    high: 3.6,
    rationale:
      'Households fall behind on cards well before they fall behind on a mortgage. Rising card delinquency is an early read on the balance-sheet stress that eventually produces distressed listings. Calibrated to the 12-year window the dashboard loads, not to the 2009 peak.',
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
  // Half-open intervals. The ranges share endpoints, so an inclusive test made
  // every published boundary resolve to the LOWER band — 40 read "Moderate",
  // 60 read "Elevated", 80 read "High", each one band off.
  const last = RISK_BANDS[RISK_BANDS.length - 1];
  return RISK_BANDS.find((b) => score >= b.min && (b === last ? score <= b.max : score < b.max)) || last;
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

    let low = ind.low;
    let high = ind.high;
    let sourceNote = null;
    let stale = false;

    try {
      const got = ind.extract(data) || {};
      value = Number.isFinite(got.value) ? got.value : null;
      observedAt = got.asOf || null;
      // An indicator that fell back to a different source brings that source's
      // own thresholds with it — see pickSource.
      if (Number.isFinite(got.low)) low = got.low;
      if (Number.isFinite(got.high)) high = got.high;
      sourceNote = got.sourceNote || null;
      // pickSource reports its own; for the plain-extract indicators derive it
      // from the observation date, so a quietly ageing series is never presented
      // as current just because it never needed a fallback.
      stale = got.stale !== undefined ? Boolean(got.stale) : false;
      if (got.stale === undefined && observedAt) {
        const age = (Date.now() - new Date(`${observedAt}T00:00:00Z`).getTime()) / 86_400_000;
        stale = age > (Number.isFinite(ind.staleAfterDays) ? ind.staleAfterDays : 100);
      }
    } catch (e) {
      // A malformed series must never take down the whole gauge.
      error = e.message;
    }

    const subScore = value === null ? null : scaleToRisk(value, low, high);

    return {
      ...ind,
      low,
      high,
      value,
      observedAt,
      subScore,
      sourceNote,
      stale,
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
  /**
   * Back-computed score, for eyeballing whether the gauge has led price turns.
   *
   * REWRITTEN after an audit found the old version was not comparable to the
   * live gauge in three separate ways, which together put a 19-point gap at the
   * exact point where the line meets the needle:
   *
   *  1. It used the unemployment LEVEL on [3.5, 7.5] while the live model uses
   *     the Sahm-style DRIFT on [0, 1.0]. Different constructs entirely.
   *  2. Its weights were hand-written and drifted from the live model's, leaving
   *     labour under-weighted by 5pp relative to intent.
   *  3. A `w >= 0.5` guard was supposed to suppress months with too little
   *     coverage, but the four Redfin specs alone clear 0.85, so it never bound:
   *     2012-2016 published with NO labour input at all, understating the whole
   *     recovery by ~8 points — precisely the stretch a reader uses to judge
   *     whether the score leads.
   *
   * It now derives its specs FROM `INDICATORS`, so thresholds and relative
   * weights can never drift again, and it requires labour coverage before
   * publishing a point.
   */
  const clean = (s) => dropNulls(sortByDate(s || []));

  // Only indicators available as a full monthly history are usable here.
  const byKey = Object.fromEntries(INDICATORS.map((i) => [i.key, i]));
  const specs = [
    { key: 'monthsOfSupply', series: clean(data.redfin?.monthsOfSupply) },
    { key: 'priceDrops', series: clean(data.redfin?.priceDrops) },
    { key: 'inventoryYoY', series: clean(data.redfin?.inventoryYoY) },
    { key: 'saleToList', series: clean(data.redfin?.saleToListRatio) },
    { key: 'unemploymentDrift', series: null, labour: true },
  ].filter((sp) => sp.labour || sp.series?.length);

  const unemployment = clean(data.bls?.unemploymentRate);
  if (!unemployment.length) return [];

  // Rolling Sahm drift, the same construct the live model uses.
  const ma3 = unemployment
    .map((p, i) => (i >= 2 ? { date: p.date, value: (unemployment[i].value + unemployment[i - 1].value + unemployment[i - 2].value) / 3 } : null))
    .filter(Boolean);
  const driftAt = (date) => {
    const idx = ma3.findIndex((p) => p.date === date);
    if (idx < 12) return null;
    const prior = ma3.slice(Math.max(0, idx - 12), idx);
    return prior.length ? ma3[idx].value - Math.min(...prior.map((p) => p.value)) : null;
  };

  const lookup = specs
    .filter((sp) => !sp.labour)
    .map((sp) => ({ ...sp, ind: byKey[sp.key], map: new Map(sp.series.map((p) => [p.date, p.value])) }));
  const labourInd = byKey.unemploymentDrift;

  const dates = new Set();
  lookup.forEach((sp) => sp.series.forEach((p) => dates.add(p.date)));
  ma3.forEach((p) => dates.add(p.date));

  return [...dates]
    .sort()
    .map((date) => {
      let weight = 0;
      let acc = 0;

      for (const sp of lookup) {
        const v = sp.map.get(date);
        if (!Number.isFinite(v) || !sp.ind) continue;
        const sub = scaleToRisk(v, sp.ind.low, sp.ind.high);
        if (sub === null) continue;
        acc += sub * sp.ind.weight;
        weight += sp.ind.weight;
      }

      // Labour is required, not optional: publishing a point without it is what
      // silently flattened 2012-2016.
      const drift = driftAt(date);
      if (!Number.isFinite(drift)) return { date, value: null };
      const labourSub = scaleToRisk(drift, labourInd.low, labourInd.high);
      if (labourSub === null) return { date, value: null };
      acc += labourSub * labourInd.weight;
      weight += labourInd.weight;

      // Require most of the available weight before publishing a point.
      const maxWeight = lookup.reduce((t, sp) => t + (sp.ind?.weight || 0), 0) + labourInd.weight;
      return weight >= maxWeight * 0.8 ? { date, value: acc / weight } : { date, value: null };
    })
    .filter((p) => p.value !== null);
}
