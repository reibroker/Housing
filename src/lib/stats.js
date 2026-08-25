/**
 * Small statistics helpers used by the charts and the risk model.
 *
 * Every function here tolerates missing values (null/undefined/NaN) because
 * real government time series have gaps: revisions, suppressed cells, series
 * that start late, and months that simply have not been published yet.
 */

/** A time series point is { date: 'YYYY-MM-DD', value: number|null }. */

/**
 * Every helper below tolerates a missing series, not just missing values.
 *
 * A source that is absent entirely — `resale` and `zillow` exist only in
 * snapshot mode — arrives as `undefined`, and spreading that threw
 * "series is not iterable", which the error boundary turned into a blank page.
 * A chart with no data is a normal state; it must never be an exception.
 */
export function sortByDate(series) {
  return [...(series || [])].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function dropNulls(series) {
  return (series || []).filter((p) => p.value !== null && p.value !== undefined && Number.isFinite(p.value));
}

/** Most recent point with an actual value. */
export function latest(series) {
  const clean = dropNulls(sortByDate(series));
  return clean.length ? clean[clean.length - 1] : null;
}

/**
 * Value `periods` observations before the latest one.
 * For a monthly series, periods=12 is the year-ago comparison.
 */
export function lagged(series, periods) {
  const clean = dropNulls(sortByDate(series));
  if (!clean.length) return null;

  // Positional lookup silently becomes a longer span whenever the series has an
  // interior gap: dropNulls removes the hole, so "12 observations back" can mean
  // 13+ calendar months. Anchor on the date instead, and accept the nearest
  // observation within half a period of the target.
  const last = clean[clean.length - 1];
  const spacing = medianSpacingDays(clean);
  if (!spacing) {
    const i = clean.length - 1 - periods;
    return i >= 0 ? clean[i] : null;
  }
  const targetMs = new Date(`${last.date}T00:00:00Z`).getTime() - periods * spacing * 86_400_000;
  const tolerance = (spacing / 2) * 86_400_000;

  let best = null;
  let bestGap = Infinity;
  for (const p of clean) {
    const gap = Math.abs(new Date(`${p.date}T00:00:00Z`).getTime() - targetMs);
    if (gap < bestGap) { bestGap = gap; best = p; }
  }
  return best && bestGap <= tolerance ? best : null;
}

/** Median gap between consecutive observations, in days. Null if undeterminable. */
export function medianSpacingDays(series) {
  const clean = dropNulls(sortByDate(series)).slice(-24);
  if (clean.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < clean.length; i++) {
    gaps.push(
      (new Date(`${clean[i].date}T00:00:00Z`) - new Date(`${clean[i - 1].date}T00:00:00Z`)) / 86_400_000
    );
  }
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] || null;
}

/** Percent change from `periods` ago to latest. Null if either end is missing. */
export function pctChange(series, periods) {
  const now = latest(series);
  const then = lagged(series, periods);
  if (!now || !then || then.value === 0) return null;
  return ((now.value - then.value) / Math.abs(then.value)) * 100;
}

/** Absolute change from `periods` ago to latest. */
export function absChange(series, periods) {
  const now = latest(series);
  const then = lagged(series, periods);
  if (!now || !then) return null;
  return now.value - then.value;
}

/** Trailing n-observation mean, ending at the latest point. */
export function trailingMean(series, n) {
  const clean = dropNulls(sortByDate(series));
  if (clean.length === 0) return null;
  const slice = clean.slice(Math.max(0, clean.length - n));
  return slice.reduce((s, p) => s + p.value, 0) / slice.length;
}

export function mean(values) {
  const v = values.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function stdev(values) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

/**
 * Add a `yoy` field (percent change vs 12 observations prior) to each point.
 * Used by the charts so a level series and its growth rate can share an axis.
 */
export function withYoY(series, periods = 12) {
  const clean = sortByDate(series);
  return clean.map((p, i) => {
    const prior = clean[i - periods];
    const yoy =
      prior && Number.isFinite(prior.value) && Number.isFinite(p.value) && prior.value !== 0
        ? ((p.value - prior.value) / Math.abs(prior.value)) * 100
        : null;
    return { ...p, yoy };
  });
}

/**
 * Map a raw value onto a 0-100 scale by linear interpolation between two
 * thresholds, clamped at both ends.
 *
 * This is deliberately the simplest possible normalization. A z-score would be
 * more statistically fashionable, but it makes the resulting score depend on
 * the length of history you happened to load, and it is much harder to explain.
 * Fixed, published thresholds mean the number means the same thing every time,
 * and every threshold in the model can be pointed at and argued with.
 *
 * @param {number} value
 * @param {number} low   Value scoring 0.
 * @param {number} high  Value scoring 100.
 */
export function scaleToRisk(value, low, high) {
  if (!Number.isFinite(value)) return null;
  if (low === high) return 50;
  const t = (value - low) / (high - low);
  return Math.max(0, Math.min(100, t * 100));
}

/** Align several named series onto one array of rows keyed by date, for charts. */
export function alignSeries(map) {
  const dates = new Set();
  Object.values(map).forEach((s) => (s || []).forEach((p) => dates.add(p.date)));
  const sorted = [...dates].sort();

  const index = {};
  Object.entries(map).forEach(([k, s]) => {
    index[k] = new Map((s || []).map((p) => [p.date, p.value]));
  });

  return sorted.map((date) => {
    const row = { date };
    Object.keys(map).forEach((k) => {
      const v = index[k].get(date);
      row[k] = v === undefined ? null : v;
    });
    return row;
  });
}

/** Keep only points on or after a cutoff date. */
export function since(series, isoDate) {
  return (series || []).filter((p) => p.date >= isoDate);
}
