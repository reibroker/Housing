/**
 * Orchestrates every data source and exposes one state object to the UI.
 *
 * Design notes:
 *  - Sources load in parallel via Promise.allSettled. One dead source must never
 *    blank the dashboard, so each keeps its own status and error.
 *  - Redfin can be satisfied either by a network fetch or by a file the user
 *    dropped in, so its state is kept separately and can be replaced without
 *    disturbing anything else.
 *  - Selecting a state re-fetches only what actually varies by state (Redfin's
 *    state file and the BLS LAUS series); Census construction series are
 *    national and are left alone.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCensus } from '../data/census.js';
import { loadBls } from '../data/bls.js';
import { loadFred } from '../data/fred.js';
import { loadRedfin, loadRedfinFromFile } from '../data/redfin.js';
import { computeRiskScore, historicalScore } from '../model/riskModel.js';
import { generateDemoData } from '../data/demo.js';
import { loadSnapshot } from '../data/snapshot.js';
import { getConfig } from '../config/env.js';

const emptySource = () => ({ data: null, meta: null, error: null, loading: false });

/**
 * @param {object} opts
 * @param {'snapshot'|'live'|'demo'} opts.mode
 *   snapshot -- read the CI-built JSON from our own origin (default; the only
 *               mode that can assemble a complete dashboard on a static host,
 *               because FRED and Redfin send no CORS headers)
 *   live     -- fetch each API directly from the browser (needs a Census key;
 *               expect FRED and Redfin to be blocked)
 *   demo     -- locally generated synthetic data, no network at all
 */
export default function useDashboardData({ stateFips = null, stateCode = null, mode = 'snapshot' } = {}) {
  const demo = mode === 'demo';
  const [census, setCensus] = useState(emptySource);
  const [bls, setBls] = useState(emptySource);
  const [fred, setFred] = useState(emptySource);
  const [redfin, setRedfin] = useState(emptySource);
  const [redfinProgress, setRedfinProgress] = useState(null);
  const [calendar, setCalendar] = useState(null);
  const [resale, setResale] = useState(emptySource);
  const [zillow, setZillow] = useState(emptySource);

  // Guards against a slow response from a previous state selection landing
  // after a newer one and overwriting it.
  const generation = useRef(0);

  const loadRedfinSource = useCallback(
    async (gen) => {
      setRedfin((s) => ({ ...s, loading: true, error: null }));
      setRedfinProgress(null);
      try {
        const res = await loadRedfin(stateCode ? 'state' : 'national', {
          stateCode: stateCode || null,
          onProgress: (p) => {
            if (generation.current === gen) setRedfinProgress(p);
          },
        });
        if (generation.current !== gen) return;
        setRedfin({ data: res.series, meta: res.meta, error: null, loading: false });
      } catch (e) {
        if (generation.current !== gen) return;
        setRedfin({ data: null, meta: null, error: e, loading: false });
      } finally {
        if (generation.current === gen) setRedfinProgress(null);
      }
    },
    [stateCode]
  );

  const loadAll = useCallback(async () => {
    const gen = ++generation.current;

    // Demo mode short-circuits every network call. Nothing is fetched, so the
    // whole UI works with no key, no CORS and no connectivity -- see
    // src/data/demo.js for why this exists and what the numbers are (and
    // are not).
    if (mode === 'snapshot') {
      setCensus((s) => ({ ...s, loading: true, error: null }));
      setBls((s) => ({ ...s, loading: true, error: null }));
      setFred((s) => ({ ...s, loading: true, error: null }));
      setRedfin((s) => ({ ...s, loading: true, error: null }));
      try {
        const snap = await loadSnapshot();
        if (generation.current !== gen) return;
        const put = (setter, key) =>
          setter({
            data: snap.series[key],
            meta: { ...(snap.meta[key] || {}), manifest: snap.manifest },
            errors: {},
            error: snap.errors[key] || null,
            loading: false,
          });
        put(setCensus, 'census');
        put(setBls, 'bls');
        put(setFred, 'fred');
        put(setRedfin, 'redfin');
        put(setResale, 'resale');
        put(setZillow, 'zillow');
        setCalendar(snap.calendar);
      } catch (e) {
        if (generation.current !== gen) return;
        // A missing or unreadable manifest is one failure, not four -- report it
        // identically on every panel so the cause is obvious.
        const fail = (setter) => setter({ data: null, meta: null, error: e, loading: false });
        [setCensus, setBls, setFred, setRedfin].forEach(fail);
      }
      return;
    }

    if (demo) {
      const d = generateDemoData(getConfig().historyYears);
      setCensus({ data: d.census, meta: { ...d.meta, ...d.censusMeta, resolution: {}, rawSeries: {} }, error: null, loading: false });
      setBls({ data: d.bls, meta: d.meta, error: null, loading: false });
      setFred({ data: d.fred, meta: { ...d.meta, ...d.fredMeta }, errors: {}, error: null, loading: false });
      setRedfin({ data: d.redfin, meta: d.meta, error: null, loading: false });
      return;
    }

    setCensus((s) => ({ ...s, loading: true, error: null }));
    setBls((s) => ({ ...s, loading: true, error: null }));
    setFred((s) => ({ ...s, loading: true, error: null }));

    // Kick everything off together; each settles independently.
    loadCensus()
      .then((r) => {
        if (generation.current !== gen) return;
        setCensus({ data: r.series, meta: { ...r.meta, resolution: r.resolution, rawSeries: r.rawSeries }, error: null, loading: false });
      })
      .catch((e) => {
        if (generation.current !== gen) return;
        setCensus({ data: null, meta: null, error: e, loading: false });
      });

    loadBls({ stateFips })
      .then((r) => {
        if (generation.current !== gen) return;
        setBls({ data: r.series, meta: r.meta, error: null, loading: false });
      })
      .catch((e) => {
        if (generation.current !== gen) return;
        setBls({ data: null, meta: null, error: e, loading: false });
      });

    loadFred()
      .then((r) => {
        if (generation.current !== gen) return;
        setFred({ data: r.series, meta: r.meta, error: null, loading: false });
      })
      .catch((e) => {
        if (generation.current !== gen) return;
        setFred({ data: null, meta: null, error: e, loading: false });
      });

    loadRedfinSource(gen);
  }, [stateFips, loadRedfinSource, demo, mode]);

  /** Accept a Redfin file the user dropped in, bypassing the network entirely. */
  const ingestRedfinFile = useCallback(
    async (file) => {
      const gen = generation.current;
      setRedfin((s) => ({ ...s, loading: true, error: null }));
      setRedfinProgress(null);
      try {
        const res = await loadRedfinFromFile(file, {
          stateCode: stateCode || null,
          level: stateCode ? 'state' : 'national',
          onProgress: setRedfinProgress,
        });
        if (generation.current !== gen) return;
        setRedfin({ data: res.series, meta: res.meta, error: null, loading: false });
      } catch (e) {
        setRedfin((s) => ({ ...s, loading: false, error: e }));
      } finally {
        setRedfinProgress(null);
      }
    },
    [stateCode]
  );

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateFips, stateCode, demo, mode]);

  const bundle = { census: census.data, bls: bls.data, fred: fred.data, redfin: redfin.data, resale: resale.data, zillow: zillow.data };
  const risk = computeRiskScore(bundle);
  const riskHistory = historicalScore(bundle);

  return {
    demo,
    mode,
    calendar,
    census,
    bls,
    fred,
    redfin,
    resale,
    zillow,
    redfinProgress,
    bundle,
    risk,
    riskHistory,
    reload: loadAll,
    ingestRedfinFile,
    anyLoading: census.loading || bls.loading || fred.loading || redfin.loading,
  };
}
