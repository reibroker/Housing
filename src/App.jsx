/**
 * Application shell: filter row, tabs, and the panels.
 *
 * Layout rule being followed: ONE filter row above everything it scopes. There
 * are no per-card filters, so every chart on screen always shows the same slice
 * and two cards can never silently disagree about what they are showing.
 */

import { useMemo, useState } from 'react';
import useDashboardData from './hooks/useDashboardData.js';
import { STATES } from './config/states.js';
import { getConfig } from './config/env.js';


import TimeSeriesChart from './components/TimeSeriesChart.jsx';
import ChartCard from './components/ChartCard.jsx';
import RiskGauge from './components/RiskGauge.jsx';
import RiskBreakdown from './components/RiskBreakdown.jsx';
import RedfinFallback from './components/RedfinFallback.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import DataSourcesPanel from './components/DataSourcesPanel.jsx';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'supply', label: 'Inventory & demand' },
  { id: 'construction', label: 'Construction & permits' },
  { id: 'employment', label: 'Employment' },
  { id: 'credit', label: 'Credit & confidence' },
  { id: 'sources', label: 'Data sources' },
  { id: 'settings', label: 'Settings' },
];

/** Derive a year-over-year series from a level series, for charts that compare
 *  growth rates across measures whose levels are on wildly different scales.
 *  This is the alternative to a dual axis, not a workaround for it. */
function yoySeries(series, periods = 12) {
  if (!series?.length) return [];
  return series.map((p, i) => {
    const prior = series[i - periods];
    const value =
      prior && Number.isFinite(prior.value) && Number.isFinite(p.value) && prior.value !== 0
        ? ((p.value - prior.value) / Math.abs(prior.value)) * 100
        : null;
    return { date: p.date, value };
  });
}

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('hmd:theme') || 'system'; } catch { return 'system'; }
  });
  const apply = (t) => {
    setTheme(t);
    try { localStorage.setItem('hmd:theme', t); } catch { /* non-persistent */ }
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  };
  return [theme, apply];
}

export default function App() {
  const [tab, setTab] = useState('overview');
  const [stateFips, setStateFips] = useState('');
  const [theme, setTheme] = useTheme();
  const cfg = getConfig();

  const selectedState = STATES.find((s) => s.fips === stateFips) || null;

  const {
    census, bls, fred, redfin, redfinProgress,
    risk, riskHistory, reload, ingestRedfinFile, anyLoading,
  } = useDashboardData({
    stateFips: selectedState?.fips || null,
    stateCode: selectedState?.code || null,
  });

  const scope = selectedState ? selectedState.name : 'United States';

  const caseShillerYoY = useMemo(() => yoySeries(fred.data?.caseShiller), [fred.data]);

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1>Housing Market Risk Dashboard</h1>
          <p>
            Inventory, construction, employment, credit and confidence, pulled live from four public data sources
            straight into your browser. No server, no database &mdash; every request below leaves from this page.
          </p>
        </div>
        <div className="masthead-actions">
          <button
            className="ghost tiny"
            onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')}
            title="Cycle theme: system, dark, light"
          >
            Theme: {theme}
          </button>
          <button className="primary" onClick={reload} disabled={anyLoading}>
            {anyLoading ? 'Loading…' : 'Refresh data'}
          </button>
        </div>
      </header>

      {!cfg.censusKey && (
        <div className="notice error">
          <strong>A Census API key is required</strong>
          Census rejects unkeyed requests, so the permits, housing starts and new-home panels will stay empty until you
          add one. Get a free key at <code>api.census.gov/data/key_signup.html</code> and paste it into the Settings tab
          (or set <code>VITE_CENSUS_API_KEY</code> in <code>.env</code>). Everything else on this page works without it.
        </div>
      )}

      {/* One filter row above everything it scopes. */}
      <div className="filterbar">
        <div className="field">
          <label htmlFor="state">Geography</label>
          <select id="state" value={stateFips} onChange={(e) => setStateFips(e.target.value)}>
            <option value="">United States (national)</option>
            {STATES.map((s) => (
              <option key={s.fips} value={s.fips}>{s.name}</option>
            ))}
          </select>
        </div>
        <div className="spacer" />
        <div className="small muted" style={{ maxWidth: '46ch', textAlign: 'right' }}>
          {selectedState
            ? `Resale and unemployment panels show ${selectedState.name}. Construction, permits, credit and confidence are published nationally only.`
            : 'Showing national data. Pick a state to scope the resale and unemployment panels.'}
        </div>
      </div>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <div className="stack">
          <section className="card full">
            <div className="gauge-card">
              <RiskGauge
                score={risk.score}
                band={risk.band}
                coverage={risk.coverage}
                available={risk.available}
                total={risk.total}
              />
              <div>
                <h2 style={{ margin: '0 0 6px', fontSize: '1.125rem' }}>
                  Price-decline pressure &mdash; {scope}
                </h2>
                <p className="gauge-blurb">
                  {risk.band
                    ? risk.band.blurb
                    : 'Not enough data has loaded to compute a score. Check the Data sources tab to see which source failed.'}
                </p>
                <p className="gauge-blurb">
                  This is a weighted composite of {risk.total} published indicators, each rescaled to 0&ndash;100 where
                  higher means more downward pressure on prices. It is a scoreboard of current conditions, not a
                  forecast &mdash; the full arithmetic is in the breakdown below and every threshold is editable in{' '}
                  <code>src/model/riskModel.js</code>.
                </p>
                {risk.coverage < 0.75 && risk.coverage > 0 && (
                  <div className="notice">
                    <strong>Partial coverage</strong>
                    Only {Math.round(risk.coverage * 100)}% of the model&rsquo;s weight resolved to live data. The score
                    is renormalized over what loaded, so treat it as indicative until the missing sources are fixed.
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Two measures on different scales get two charts sharing an x-axis --
              never one chart with two y-scales. */}
          <div className="grid">
            <ChartCard
              title="Composite pressure score, back-computed"
              subtitle="A five-indicator subset of the model, recomputed for each historical month"
              meta={redfin.meta}
              loading={redfin.loading}
              series={[{ key: 'score', label: 'Pressure score', data: riskHistory }]}
              unit=""
              decimals={0}
              note="Uses only the indicators available as a full monthly series, so it is a simplified version of the live gauge. Compare its turns against the price chart beside it."
            >
              <TimeSeriesChart
                type="area"
                unit=""
                decimals={0}
                height={230}
                series={[{ key: 'score', label: 'Pressure score', data: riskHistory }]}
                bands={[{ y1: 60, y2: 100, label: 'High / severe' }]}
              />
            </ChartCard>

            <ChartCard
              title="Actual national home prices, year-over-year"
              subtitle="S&P CoreLogic Case-Shiller US national index"
              meta={fred.meta?.caseShiller}
              error={fred.errors?.caseShiller}
              loading={fred.loading}
              series={[{ key: 'yoy', label: 'Case-Shiller YoY', data: caseShillerYoY }]}
              unit="%"
              note="The outcome the gauge is trying to anticipate. Case-Shiller is a three-month moving average released with about a two-month lag, so it confirms turns rather than calling them."
            >
              <TimeSeriesChart
                unit="%"
                height={230}
                referenceLine={0}
                series={[{ key: 'yoy', label: 'Case-Shiller YoY', data: caseShillerYoY }]}
              />
            </ChartCard>
          </div>

          <section className="card full">
            <div className="card-head"><h3>How the score is built</h3></div>
            <p className="card-sub">
              Every input, its raw value, the thresholds it was scaled between, and exactly what it contributed.
            </p>
            <RiskBreakdown result={risk} />
          </section>

          <div className="disclaimer">
            <strong>What this is and is not.</strong> The gauge is a weighted average of public indicators using
            fixed, visible thresholds. It is not a trained model, a probability, or a forecast, and it has not been
            validated against out-of-sample outcomes. Housing markets are local, slow-moving and policy-sensitive;
            every series here is revised after publication, and several are released with a one- to three-month lag.
            Use it as a structured way to read fourteen charts at once. It is not investment, financial or legal
            advice, and no one should buy, sell or hold property on the strength of a single number &mdash; including
            this one.
          </div>
        </div>
      )}

      {tab === 'supply' && (
        <div className="stack">
          {(redfin.error || !redfin.data) && (
            <section className="card full">
              <div className="card-head"><h3>Redfin market data</h3></div>
              <RedfinFallback
                error={redfin.error}
                level={selectedState ? 'state' : 'national'}
                onFile={ingestRedfinFile}
                progress={redfinProgress}
                loading={redfin.loading}
              />
            </section>
          )}

          <div className="grid">
            <ChartCard
              title="Months of supply"
              subtitle={`Active inventory divided by the monthly sales pace — ${scope}`}
              meta={redfin.meta} error={redfin.error} loading={redfin.loading}
              unit="months"
              series={[{ key: 'mos', label: 'Months of supply', data: redfin.data?.monthsOfSupply || [] }]}
              note="Roughly 4–6 months is the traditional balanced range (shaded). Below it, sellers set the price; above it, buyers do."
            >
              <TimeSeriesChart
                unit="" decimals={1} height={230}
                bands={[{ y1: 4, y2: 6, label: 'Balanced' }]}
                series={[{ key: 'mos', label: 'Months of supply', data: redfin.data?.monthsOfSupply || [] }]}
              />
            </ChartCard>

            <ChartCard
              title="Active inventory"
              subtitle={`Homes listed for sale — ${scope}`}
              meta={redfin.meta} error={redfin.error} loading={redfin.loading}
              unit="" decimals={0}
              series={[
                { key: 'inv', label: 'Active inventory', data: redfin.data?.inventory || [] },
                { key: 'new', label: 'New listings', data: redfin.data?.newListings || [] },
              ]}
              note="Inventory accumulating faster than new listings arrive means homes are sitting rather than selling."
            >
              <TimeSeriesChart
                unit="" decimals={0} height={230} compactAxis
                series={[
                  { key: 'inv', label: 'Active inventory', data: redfin.data?.inventory || [] },
                  { key: 'new', label: 'New listings', data: redfin.data?.newListings || [] },
                ]}
              />
            </ChartCard>

            <ChartCard
              title="Seller concessions"
              subtitle={`Share of listings with a price drop, and share selling above list — ${scope}`}
              meta={redfin.meta} error={redfin.error} loading={redfin.loading}
              unit="%"
              series={[
                { key: 'drops', label: 'Listings with a price drop', data: redfin.data?.priceDrops || [] },
                { key: 'above', label: 'Sold above list price', data: redfin.data?.soldAboveList || [] },
              ]}
              note="The earliest visible sign of a turn. Sellers cut asking prices months before closed-sale medians move."
            >
              <TimeSeriesChart
                unit="%" height={230}
                series={[
                  { key: 'drops', label: 'Listings with a price drop', data: redfin.data?.priceDrops || [] },
                  { key: 'above', label: 'Sold above list price', data: redfin.data?.soldAboveList || [] },
                ]}
              />
            </ChartCard>

            <ChartCard
              title="Demand and market speed"
              subtitle={`Homes sold and median days on market — ${scope}`}
              meta={redfin.meta} error={redfin.error} loading={redfin.loading}
              unit="" decimals={0}
              series={[{ key: 'dom', label: 'Median days on market', data: redfin.data?.medianDaysOnMarket || [] }]}
              note="Days on market is the cleanest single read on how quickly demand is clearing supply."
            >
              <TimeSeriesChart
                unit="" decimals={0} height={230}
                series={[{ key: 'dom', label: 'Median days on market', data: redfin.data?.medianDaysOnMarket || [] }]}
              />
            </ChartCard>

            <ChartCard
              title="Median sale price"
              subtitle={`Closed sales — ${scope}`}
              meta={redfin.meta} error={redfin.error} loading={redfin.loading}
              unit="$" decimals={0}
              series={[{ key: 'price', label: 'Median sale price', data: redfin.data?.medianSalePrice || [] }]}
            >
              <TimeSeriesChart
                unit="" decimals={0} height={230} compactAxis
                series={[{ key: 'price', label: 'Median sale price', data: redfin.data?.medianSalePrice || [] }]}
              />
            </ChartCard>

            <ChartCard
              title="Growth rates, indexed for comparison"
              subtitle={`Year-over-year change in price, sales volume and inventory — ${scope}`}
              meta={redfin.meta} error={redfin.error} loading={redfin.loading}
              unit="%"
              series={[
                { key: 'p', label: 'Median sale price', data: redfin.data?.medianSalePriceYoY || [] },
                { key: 's', label: 'Homes sold', data: redfin.data?.homesSoldYoY || [] },
                { key: 'i', label: 'Inventory', data: redfin.data?.inventoryYoY || [] },
              ]}
              note="Three measures with completely different levels, put on one axis by expressing each as a growth rate — the honest alternative to a second y-axis."
            >
              <TimeSeriesChart
                unit="%" height={230} referenceLine={0}
                series={[
                  { key: 'p', label: 'Median sale price', data: redfin.data?.medianSalePriceYoY || [] },
                  { key: 's', label: 'Homes sold', data: redfin.data?.homesSoldYoY || [] },
                  { key: 'i', label: 'Inventory', data: redfin.data?.inventoryYoY || [] },
                ]}
              />
            </ChartCard>
          </div>
        </div>
      )}

      {tab === 'construction' && (
        <div className="grid">
          <ChartCard
            title="Building permits and housing starts"
            subtitle="Privately-owned housing units, seasonally adjusted annual rate"
            meta={census.meta?.resconst} error={census.error} loading={census.loading}
            unit="" decimals={0}
            series={[
              { key: 'permits', label: 'Permits authorized', data: census.data?.permitsTotal || [] },
              { key: 'starts', label: 'Housing starts', data: census.data?.startsTotal || [] },
              { key: 'comps', label: 'Completions', data: census.data?.completions || [] },
            ]}
            note="Permits lead starts by one to two months and completions by roughly a year. All three share a unit, so they belong on one axis."
          >
            <TimeSeriesChart
              unit="" decimals={0} height={250} compactAxis
              series={[
                { key: 'permits', label: 'Permits authorized', data: census.data?.permitsTotal || [] },
                { key: 'starts', label: 'Housing starts', data: census.data?.startsTotal || [] },
                { key: 'comps', label: 'Completions', data: census.data?.completions || [] },
              ]}
            />
          </ChartCard>

          <ChartCard
            title="Single-family vs total"
            subtitle="Permits and starts, single-family only"
            meta={census.meta?.resconst} error={census.error} loading={census.loading}
            unit="" decimals={0}
            series={[
              { key: 'sfPermits', label: 'Single-family permits', data: census.data?.permitsSingle || [] },
              { key: 'sfStarts', label: 'Single-family starts', data: census.data?.startsSingle || [] },
            ]}
            note="Single-family tracks the owner-occupied market directly; multifamily is driven by rents and cap rates, which move on a different cycle."
          >
            <TimeSeriesChart
              unit="" decimals={0} height={250} compactAxis
              series={[
                { key: 'sfPermits', label: 'Single-family permits', data: census.data?.permitsSingle || [] },
                { key: 'sfStarts', label: 'Single-family starts', data: census.data?.startsSingle || [] },
              ]}
            />
          </ChartCard>

          <ChartCard
            title="The construction pipeline"
            subtitle="Units currently under construction"
            meta={census.meta?.resconst} error={census.error} loading={census.loading}
            unit="" decimals={0}
            series={[{ key: 'uc', label: 'Under construction', data: census.data?.underConstruction || [] }]}
            note="Supply already committed. A large pipeline delivering into a slowing market is what turns a slowdown into builder price cuts."
          >
            <TimeSeriesChart
              type="area" unit="" decimals={0} height={250} compactAxis
              series={[{ key: 'uc', label: 'Under construction', data: census.data?.underConstruction || [] }]}
            />
          </ChartCard>

          <ChartCard
            title="New-home market"
            subtitle="New single-family homes sold and inventory for sale"
            meta={census.meta?.ressales} error={census.error} loading={census.loading}
            unit="" decimals={0}
            series={[
              { key: 'sold', label: 'New homes sold', data: census.data?.newHomeSales || [] },
              { key: 'forSale', label: 'New homes for sale', data: census.data?.newHomesForSale || [] },
            ]}
          >
            <TimeSeriesChart
              unit="" decimals={0} height={250} compactAxis
              series={[
                { key: 'sold', label: 'New homes sold', data: census.data?.newHomeSales || [] },
                { key: 'forSale', label: 'New homes for sale', data: census.data?.newHomesForSale || [] },
              ]}
            />
          </ChartCard>

          <ChartCard
            title="New-home months' supply"
            subtitle="Inventory at the current sales rate"
            meta={census.meta?.ressales} error={census.error} loading={census.loading}
            unit="months" decimals={1}
            series={[{ key: 'ms', label: "Months' supply", data: census.data?.newHomeMonthsSupply || [] }]}
            note="Builders carry inventory they must move, so they discount faster than individual sellers — this leads the resale market."
          >
            <TimeSeriesChart
              unit="" decimals={1} height={250}
              bands={[{ y1: 4, y2: 6, label: 'Balanced' }]}
              series={[{ key: 'ms', label: "Months' supply", data: census.data?.newHomeMonthsSupply || [] }]}
            />
          </ChartCard>

          <ChartCard
            title="Vacancy rates"
            subtitle="Homeowner and rental vacancy, quarterly"
            meta={census.meta?.hv} error={census.error} loading={census.loading}
            unit="%"
            series={[
              { key: 'hv', label: 'Homeowner vacancy', data: census.data?.homeownerVacancy || [] },
              { key: 'rv', label: 'Rental vacancy', data: census.data?.rentalVacancy || [] },
            ]}
            note="Empty owned homes are latent supply. The homeowner rate ran near 1.5–1.7% before 2006 and peaked near 2.9% in the crash."
          >
            <TimeSeriesChart
              unit="%" height={250}
              series={[
                { key: 'hv', label: 'Homeowner vacancy', data: census.data?.homeownerVacancy || [] },
                { key: 'rv', label: 'Rental vacancy', data: census.data?.rentalVacancy || [] },
              ]}
            />
          </ChartCard>
        </div>
      )}

      {tab === 'employment' && (
        <div className="grid">
          <ChartCard
            title="Unemployment rate"
            subtitle={selectedState ? `National and ${selectedState.name}` : 'National, seasonally adjusted'}
            meta={bls.meta} error={bls.error} loading={bls.loading}
            unit="%"
            series={[
              { key: 'us', label: 'United States', data: bls.data?.unemploymentRate || [] },
              ...(selectedState
                ? [{ key: 'st', label: selectedState.name, data: bls.data?.stateUnemploymentRate || [] }]
                : []),
            ]}
            note="Job loss is what converts a soft market into a distressed one — it turns discretionary sellers into forced sellers."
          >
            <TimeSeriesChart
              unit="%" height={250}
              series={[
                { key: 'us', label: 'United States', data: bls.data?.unemploymentRate || [] },
                ...(selectedState
                  ? [{ key: 'st', label: selectedState.name, data: bls.data?.stateUnemploymentRate || [] }]
                  : []),
              ]}
            />
          </ChartCard>

          <ChartCard
            title="Construction employment, year-over-year"
            subtitle="Residential building, residential trades, and construction overall"
            meta={bls.meta} error={bls.error} loading={bls.loading}
            unit="%"
            series={[
              { key: 'resi', label: 'Residential building', data: yoySeries(bls.data?.residentialConstructionJobs) },
              { key: 'trades', label: 'Residential trades', data: yoySeries(bls.data?.residentialTradeJobs) },
              { key: 'all', label: 'All construction', data: yoySeries(bls.data?.constructionJobs) },
            ]}
            note="Builders cut crews before they cut prices publicly. Expressed as growth rates so three differently-sized payrolls share one axis."
          >
            <TimeSeriesChart
              unit="%" height={250} referenceLine={0}
              series={[
                { key: 'resi', label: 'Residential building', data: yoySeries(bls.data?.residentialConstructionJobs) },
                { key: 'trades', label: 'Residential trades', data: yoySeries(bls.data?.residentialTradeJobs) },
                { key: 'all', label: 'All construction', data: yoySeries(bls.data?.constructionJobs) },
              ]}
            />
          </ChartCard>

          <ChartCard
            title="Residential construction payrolls"
            subtitle="All employees, thousands"
            meta={bls.meta} error={bls.error} loading={bls.loading}
            unit="" decimals={0}
            series={[
              { key: 'resi', label: 'Residential building', data: bls.data?.residentialConstructionJobs || [] },
              { key: 'trades', label: 'Residential trades', data: bls.data?.residentialTradeJobs || [] },
            ]}
          >
            <TimeSeriesChart
              unit="" decimals={0} height={250} compactAxis
              series={[
                { key: 'resi', label: 'Residential building', data: bls.data?.residentialConstructionJobs || [] },
                { key: 'trades', label: 'Residential trades', data: bls.data?.residentialTradeJobs || [] },
              ]}
            />
          </ChartCard>

          <ChartCard
            title="Shelter inflation"
            subtitle="CPI shelter component, year-over-year"
            meta={bls.meta} error={bls.error} loading={bls.loading}
            unit="%"
            series={[{ key: 'shelter', label: 'CPI shelter YoY', data: yoySeries(bls.data?.cpiShelter) }]}
            note="Shelter is roughly a third of headline CPI and follows market rents with a 9–12 month lag, which is why it keeps rising after housing has already cooled."
          >
            <TimeSeriesChart
              unit="%" height={250}
              series={[{ key: 'shelter', label: 'CPI shelter YoY', data: yoySeries(bls.data?.cpiShelter) }]}
            />
          </ChartCard>
        </div>
      )}

      {tab === 'credit' && (
        <div className="grid">
          <ChartCard
            title="30-year fixed mortgage rate"
            subtitle="Freddie Mac Primary Mortgage Market Survey, weekly"
            meta={fred.meta?.mortgage30yr} error={fred.errors?.mortgage30yr} loading={fred.loading}
            unit="%" decimals={2}
            series={[{ key: 'rate', label: '30-year fixed', data: fred.data?.mortgage30yr || [] }]}
            note="Buyers shop by monthly payment, so rate moves change purchasing power directly and show up in prices a few months later."
          >
            <TimeSeriesChart
              unit="%" decimals={2} height={250}
              series={[{ key: 'rate', label: '30-year fixed', data: fred.data?.mortgage30yr || [] }]}
            />
          </ChartCard>

          <ChartCard
            title="Consumer sentiment"
            subtitle="University of Michigan index, 1966 = 100"
            meta={fred.meta?.consumerSentiment} error={fred.errors?.consumerSentiment} loading={fred.loading}
            unit="" decimals={1}
            series={[{ key: 'sent', label: 'Consumer sentiment', data: fred.data?.consumerSentiment || [] }]}
            note="Buying a house is the largest discretionary commitment most households make, and they defer it when they feel insecure."
          >
            <TimeSeriesChart
              unit="" decimals={1} height={250}
              series={[{ key: 'sent', label: 'Consumer sentiment', data: fred.data?.consumerSentiment || [] }]}
            />
          </ChartCard>

          <ChartCard
            title="Revolving consumer credit"
            subtitle="Outstanding balances — mostly credit cards. Federal Reserve G.19"
            meta={fred.meta?.revolvingCredit} error={fred.errors?.revolvingCredit} loading={fred.loading}
            unit="$" decimals={0}
            series={[{ key: 'rev', label: 'Revolving credit ($B)', data: fred.data?.revolvingCredit || [] }]}
            note="Rising card balances alongside flat real income means households are funding consumption with credit — the stage before delinquency."
          >
            <TimeSeriesChart
              type="area" unit="" decimals={0} height={250} compactAxis
              series={[{ key: 'rev', label: 'Revolving credit ($B)', data: fred.data?.revolvingCredit || [] }]}
            />
          </ChartCard>

          <ChartCard
            title="Credit card delinquency rate"
            subtitle="All commercial banks, quarterly"
            meta={fred.meta?.creditCardDelinquency} error={fred.errors?.creditCardDelinquency} loading={fred.loading}
            unit="%" decimals={2}
            series={[{ key: 'del', label: 'Delinquency rate', data: fred.data?.creditCardDelinquency || [] }]}
            note="Households fall behind on cards well before they fall behind on a mortgage, which makes this an early read on the stress that eventually produces distressed listings."
          >
            <TimeSeriesChart
              unit="%" decimals={2} height={250}
              series={[{ key: 'del', label: 'Delinquency rate', data: fred.data?.creditCardDelinquency || [] }]}
            />
          </ChartCard>

          <ChartCard
            title="Existing home sales"
            subtitle="National Association of Realtors, seasonally adjusted annual rate"
            meta={fred.meta?.existingHomeSales} error={fred.errors?.existingHomeSales} loading={fred.loading}
            unit="" decimals={0}
            series={[{ key: 'ehs', label: 'Existing home sales', data: fred.data?.existingHomeSales || [] }]}
          >
            <TimeSeriesChart
              unit="" decimals={0} height={250} compactAxis
              series={[{ key: 'ehs', label: 'Existing home sales', data: fred.data?.existingHomeSales || [] }]}
            />
          </ChartCard>

          <ChartCard
            title="Credit and confidence, year-over-year"
            subtitle="Growth rates so three different units share one axis"
            meta={fred.meta?.revolvingCredit} loading={fred.loading}
            unit="%"
            series={[
              { key: 'rev', label: 'Revolving credit', data: yoySeries(fred.data?.revolvingCredit) },
              { key: 'sent', label: 'Consumer sentiment', data: yoySeries(fred.data?.consumerSentiment) },
              { key: 'ehs', label: 'Existing home sales', data: yoySeries(fred.data?.existingHomeSales) },
            ]}
          >
            <TimeSeriesChart
              unit="%" height={250} referenceLine={0}
              series={[
                { key: 'rev', label: 'Revolving credit', data: yoySeries(fred.data?.revolvingCredit) },
                { key: 'sent', label: 'Consumer sentiment', data: yoySeries(fred.data?.consumerSentiment) },
                { key: 'ehs', label: 'Existing home sales', data: yoySeries(fred.data?.existingHomeSales) },
              ]}
            />
          </ChartCard>
        </div>
      )}

      {tab === 'sources' && <DataSourcesPanel census={census} bls={bls} fred={fred} redfin={redfin} />}
      {tab === 'settings' && <SettingsPanel onApply={reload} />}
    </div>
  );
}
