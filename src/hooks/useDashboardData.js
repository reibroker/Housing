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

const emptySource = () => ({ data: null, meta: null, error: null, loading: false });

export default function useDashboardData({ stateFips = null, stateCode = null } = {}) {
  const [census, setCensus] = useState(emptySource);
  const [bls, setBls] = useState(emptySource);
  const [fred, setFred] = useState(emptySource);
  const [redfin, setRedfin] = useState(emptySource);
  const [redfinProgress, setRedfinProgress] = useState(null);

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
  }, [stateFips, loadRedfinSource]);

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
  }, [stateFips, stateCode]);

  const bundle = { census: census.data, bls: bls.data, fred: fred.data, redfin: redfin.data };
  const risk = computeRiskScore(bundle);
  const riskHistory = historicalScore(bundle);

  return {
    census,
    bls,
    fred,
    redfin,
    redfinProgress,
    bundle,
    risk,
    riskHistory,
    reload: loadAll,
    ingestRedfinFile,
    anyLoading: census.loading || bls.loading || fred.loading || redfin.loading,
  };
}
