/**
 * Three-portal comparison: Redfin, Realtor.com, Zillow.
 *
 * THE POINT OF THIS PAGE is not that the numbers differ — it is WHY they differ.
 * Put side by side, these sources disagree wildly, and most of the gap is
 * definitional rather than substantive:
 *
 *   - "Days on market" is days-to-PENDING at Zillow and days-to-SOLD at Redfin
 *     and Realtor.com. That alone is most of a 30-day spread.
 *   - "Price cuts" is a monthly FLOW at Redfin (listings that cut this month) and
 *     a STOCK at Realtor.com and Zillow (listings currently showing a cut).
 *   - Median price is a SALE price at Redfin and Zillow but a LIST price at
 *     Realtor.com, and each applies its own smoothing and mix adjustment.
 *
 * Presenting those as a straight league table would manufacture a disagreement
 * that is not there. So every row states its definition, and the comparison the
 * page leads with is year-over-year change, which normalizes away most of the
 * methodology and leaves the part that is genuinely about the market.
 */

import { useMemo, useState } from 'react';
import TimeSeriesChart, { formatValue } from './TimeSeriesChart.jsx';
import ChartCard from './ChartCard.jsx';
import { latest, pctChange } from '../lib/stats.js';

/** Fixed source order → fixed colour slots. Never reassigned by value. */
const SOURCES = [
  { key: 'redfin', label: 'Redfin' },
  { key: 'realtor', label: 'Realtor.com' },
  { key: 'zillow', label: 'Zillow' },
];

/**
 * Metrics that are comparable enough to line up, each with an explicit note on
 * how the three definitions differ.
 */
const METRICS = [
  {
    id: 'inventory',
    label: 'Active listings',
    unit: '',
    decimals: 0,
    comparable: 'high',
    note: 'Closest to like-for-like: all three count homes actively listed. Coverage of the underlying MLS feeds still differs.',
    pick: (d) => ({
      redfin: d.redfin?.inventory,
      realtor: d.resale?.activeListings,
      zillow: d.zillow?.inventory,
    }),
  },
  {
    id: 'newListings',
    label: 'New listings',
    unit: '',
    decimals: 0,
    comparable: 'high',
    note: 'Homes newly listed in the month. Differences are mostly market coverage rather than definition.',
    pick: (d) => ({
      redfin: d.redfin?.newListings,
      realtor: d.resale?.newListings,
      zillow: d.zillow?.newListings,
    }),
  },
  {
    id: 'daysOnMarket',
    label: 'Days on market',
    unit: 'days',
    decimals: 0,
    comparable: 'low',
    note: 'NOT like-for-like. Zillow measures days to PENDING (accepted offer); Redfin and Realtor.com measure days to SOLD, which adds the whole escrow period. Expect Zillow to read roughly a month lower for that reason alone.',
    pick: (d) => ({
      redfin: d.redfin?.medianDaysOnMarket,
      realtor: d.resale?.medianDaysOnMarket,
      zillow: d.zillow?.daysToPending,
    }),
  },
  {
    id: 'priceCuts',
    label: 'Share of listings with a price cut',
    unit: '%',
    decimals: 1,
    comparable: 'low',
    note: 'NOT like-for-like. Redfin reports a monthly FLOW — listings that cut price during the month. Realtor.com and Zillow report a STOCK — listings currently showing a reduction — which is cumulative and therefore always higher.',
    pick: (d) => ({
      redfin: d.redfin?.priceDrops,
      realtor: d.resale?.priceReducedShare,
      zillow: d.zillow?.priceCutShare?.map((p) => ({ ...p, value: p.value * 100 })),
    }),
  },
  {
    id: 'medianPrice',
    label: 'Median price',
    unit: '$',
    decimals: 0,
    comparable: 'medium',
    note: 'Redfin and Zillow report median SALE price; Realtor.com reports median LIST price, which runs above sale in a soft market and below it in a hot one. Each applies its own mix adjustment and smoothing.',
    pick: (d) => ({
      redfin: d.redfin?.medianSalePrice,
      realtor: d.resale?.medianListPrice,
      zillow: d.zillow?.medianSalePrice,
    }),
  },
];

const COMPARABILITY = {
  high: { label: 'Like-for-like', cls: 'ok' },
  medium: { label: 'Similar, adjusted differently', cls: 'warn' },
  low: { label: 'Different definitions', cls: 'err' },
};

function yoy(series, periods = 12) {
  if (!series?.length) return [];
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

export default function ComparePanel({ bundle, zillowMeta, loading }) {
  const [basis, setBasis] = useState('yoy');

  const rows = useMemo(
    () =>
      METRICS.map((m) => {
        const picked = m.pick(bundle);
        const cells = SOURCES.map((s) => {
          const series = picked[s.key];
          const l = latest(series);
          return {
            ...s,
            value: l?.value ?? null,
            date: l?.date ?? null,
            yoy: pctChange(series, 12),
            series,
          };
        });
        const vals = cells.map((c) => c.value).filter(Number.isFinite);
        const spread = vals.length > 1 ? ((Math.max(...vals) - Math.min(...vals)) / Math.min(...vals)) * 100 : null;
        return { ...m, cells, spread };
      }),
    [bundle]
  );

  const forecast = latest(bundle.zillow?.homeValueForecast);

  return (
    <div className="stack">
      <div className="notice info">
        <strong>Why these numbers disagree</strong>
        Most of the gap between the three portals is definitional, not a difference of opinion about the market.
        Each row below is labelled with how comparable it actually is, and the default view is year-over-year change,
        which cancels most of the methodology and leaves the part that is genuinely about housing.
      </div>

      <section className="card full">
        <div className="card-head">
          <div>
            <h3>Current readings, all three sources</h3>
            <p className="card-sub">Latest published value from each portal, with the as-of date — they are rarely the same month.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Metric</th>
                {SOURCES.map((s) => (<th className="num" key={s.key}>{s.label}</th>))}
                <th className="num">Spread</th>
                <th>Comparability</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{r.label}</div>
                    <details>
                      <summary>How the definitions differ</summary>
                      <p className="tiny-text muted" style={{ margin: '6px 0 0', maxWidth: '60ch' }}>{r.note}</p>
                    </details>
                  </td>
                  {r.cells.map((c) => (
                    <td className="num" key={c.key}>
                      {formatValue(c.value, { unit: r.unit === '$' ? '' : r.unit, decimals: r.decimals, compact: r.decimals === 0 })}
                      <div className="tiny-text muted">{c.date ? c.date.slice(0, 7) : '—'}</div>
                    </td>
                  ))}
                  <td className="num">{r.spread === null ? '—' : `${r.spread.toFixed(0)}%`}</td>
                  <td>
                    <span className={`badge ${COMPARABILITY[r.comparable].cls}`}>
                      {COMPARABILITY[r.comparable].label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="card-note">
          &ldquo;Spread&rdquo; is the gap between the highest and lowest reading, as a percentage of the lowest. A large
          spread on a row marked &ldquo;different definitions&rdquo; tells you about the definitions, not the market.
        </p>
      </section>

      <section className="card full">
        <div className="card-head">
          <div>
            <h3>Forecasts</h3>
            <p className="card-sub">What each portal expects home values to do over the next year.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Source</th><th className="num">Forecast</th><th>Horizon</th><th>Availability</th></tr></thead>
            <tbody>
              <tr>
                <td>Zillow &mdash; Home Value Forecast (ZHVF)</td>
                <td className="num">{forecast ? formatValue(forecast.value, { unit: '%', decimals: 1 }) : '—'}</td>
                <td className="small">{forecast ? `through ${forecast.date.slice(0, 7)}` : '—'}</td>
                <td><span className="badge ok">published as data</span></td>
              </tr>
              <tr>
                <td>Redfin &mdash; annual housing predictions</td>
                <td className="num muted">—</td>
                <td className="small muted">varies</td>
                <td><span className="badge">prose only</span></td>
              </tr>
              <tr>
                <td>Realtor.com &mdash; annual housing forecast</td>
                <td className="num muted">—</td>
                <td className="small muted">calendar year</td>
                <td><span className="badge">prose only</span></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="card-note">
          Only Zillow publishes its forecast as a machine-readable series. Redfin and Realtor.com publish theirs as
          written outlooks, which are not something to parse into a number &mdash; a forecast pulled out of prose by
          pattern-matching would look authoritative and be unreliable. Read those two directly:{' '}
          <a href="https://www.redfin.com/news/" target="_blank" rel="noreferrer">Redfin News</a> and{' '}
          <a href="https://www.realtor.com/research/" target="_blank" rel="noreferrer">Realtor.com Research</a>.
        </p>
      </section>

      <div className="filterbar" style={{ marginTop: 0 }}>
        <div className="field">
          <label htmlFor="basis">Compare on</label>
          <select id="basis" value={basis} onChange={(e) => setBasis(e.target.value)}>
            <option value="yoy">Year-over-year change (recommended)</option>
            <option value="level">Raw levels</option>
          </select>
        </div>
        <div className="spacer" />
        <div className="small muted" style={{ maxWidth: '52ch', textAlign: 'right' }}>
          {basis === 'yoy'
            ? 'Growth rates cancel most of the methodology difference, so the lines should track each other closely. Where they do not, the market signal is genuinely ambiguous.'
            : 'Raw levels show the definitional gaps at full size — useful for understanding the sources, misleading as a league table.'}
        </div>
      </div>

      <div className="grid">
        {rows.map((r) => {
          const series = r.cells.map((c) => ({
            key: c.key,
            label: c.label,
            data: basis === 'yoy' ? yoy(c.series) : c.series || [],
          }));
          return (
            <ChartCard
              key={r.id}
              title={r.label}
              subtitle={basis === 'yoy' ? 'Year-over-year change' : 'Raw level'}
              loading={loading}
              unit={basis === 'yoy' ? '%' : r.unit === '$' ? '' : r.unit}
              decimals={basis === 'yoy' ? 1 : r.decimals}
              series={series}
              note={r.note}
              actions={<span className={`badge ${COMPARABILITY[r.comparable].cls}`}>{COMPARABILITY[r.comparable].label}</span>}
            >
              <TimeSeriesChart
                unit={basis === 'yoy' ? '%' : ''}
                decimals={basis === 'yoy' ? 1 : r.decimals}
                height={240}
                compactAxis={basis !== 'yoy' && r.decimals === 0}
                referenceLine={basis === 'yoy' ? 0 : null}
                series={series}
              />
            </ChartCard>
          );
        })}
      </div>

      <div className="disclaimer">
        <strong>Attribution.</strong> Zillow figures are from Zillow Research public data, © Zillow Group, used with
        attribution. Realtor.com residential-listings series are read via FRED. Redfin figures are from the Redfin Data
        Center. Each portal sees a different slice of the market — different MLS coverage, different geographic
        weighting, different revision policies — so none of them is the market, and the spread between them is a fair
        measure of how much of &ldquo;the number&rdquo; is method.
        {zillowMeta?.attribution ? ` Source file: ${zillowMeta.attribution}.` : ''}
      </div>
    </div>
  );
}
