/**
 * Snapshot adapter — reads the JSON that CI fetched, from this app's own origin.
 *
 * WHY THIS IS THE DEFAULT
 * Verified against the live APIs from a GitHub runner on 2026-08-23:
 *
 *   api.census.gov  Access-Control-Allow-Origin: (needs a key to test further)
 *   api.bls.gov     Access-Control-Allow-Origin: *      <- browser CAN read
 *   fred…gov        Access-Control-Allow-Origin: absent <- browser CANNOT read
 *   redfin…s3       Access-Control-Allow-Origin: absent <- browser CANNOT read
 *
 * So direct client-side fetching can never assemble a complete dashboard on a
 * static host: two of the four sources refuse the browser outright, and no
 * amount of retrying changes that — it is the browser enforcing the publisher's
 * missing header, not a failure we can catch and work around.
 *
 * `.github/workflows/data.yml` fetches all four on a runner, where no CORS
 * policy applies, and commits the normalized series into public/data/. Loading
 * those from our own origin needs no preflight, no proxy, and no API key in the
 * bundle — the Census key stays a repository secret.
 *
 * The trade is freshness: the snapshot is as new as the last workflow run
 * (daily). Given that every series here publishes monthly except the weekly
 * mortgage rate, that costs nothing real, and `generatedAt` is surfaced in the
 * UI so the age is never hidden.
 */

/** Vite rewrites BASE_URL to the deploy subpath ('/Housing/' on Pages, '/' locally). */
function dataUrl(name) {
  const base = import.meta.env.BASE_URL || '/';
  return `${base}data/${name}.json`;
}

async function getJson(name) {
  const url = dataUrl(name);
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) {
    const e = new Error(
      res.status === 404
        ? `No data snapshot found at ${url}. The "Refresh data snapshot" workflow has not produced one yet — run it from the repository's Actions tab.`
        : `HTTP ${res.status} fetching ${url}.`
    );
    e.kind = res.status === 404 ? 'config' : 'http';
    throw e;
  }
  return res.json();
}

/**
 * Load the whole snapshot.
 *
 * Each source is settled independently: a manifest that reports Census missing
 * (no key configured) must still yield a working BLS/FRED/Redfin dashboard,
 * with the risk model renormalizing over what is present.
 */
export async function loadSnapshot() {
  const manifest = await getJson('manifest');

  // The release calendar is optional: a snapshot built before the calendar
  // existed, or a run where the Census listing was unreachable, must still
  // produce a working dashboard.
  const calendar = await getJson('calendar').catch(() => null);

  const names = ['census', 'bls', 'fred', 'redfin'];
  const results = await Promise.allSettled(names.map((n) => getJson(n)));

  const series = {};
  const errors = {};
  const meta = {};

  names.forEach((name, i) => {
    const r = results[i];
    const sourceStatus = manifest.sources?.[name] || {};

    if (r.status === 'fulfilled' && r.value?.series) {
      series[name] = r.value.series;
      meta[name] = {
        via: 'snapshot',
        snapshot: true,
        generatedAt: r.value.generatedAt || manifest.generatedAt,
        ageMs: Date.now() - new Date(r.value.generatedAt || manifest.generatedAt).getTime(),
        cached: false,
        stale: false,
      };
      if (!sourceStatus.ok && sourceStatus.error) {
        // The file exists but CI could not fill it — surface the real reason
        // rather than letting the panel read as an empty dataset.
        errors[name] = new Error(`${sourceStatus.error} (recorded when the snapshot was built)`);
      }
    } else {
      series[name] = null;
      errors[name] =
        r.status === 'rejected'
          ? r.reason
          : new Error(sourceStatus.error || `No data for ${name} in the snapshot.`);
    }
  });

  return { series, errors, meta, manifest, calendar };
}
