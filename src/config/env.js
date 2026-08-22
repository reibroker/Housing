/**
 * Runtime configuration resolution.
 *
 * Precedence for every setting, highest first:
 *   1. Value saved by the user in the Settings panel (localStorage)
 *   2. Build-time Vite env var (`.env` file)
 *   3. Hard-coded default
 *
 * Putting localStorage first means someone can deploy the built bundle without
 * baking keys into it, and each visitor supplies their own. It also means you
 * can fix a bad key without a rebuild.
 */

const LS_PREFIX = 'hmd:settings:';

/** Read a user-supplied override. Wrapped because localStorage throws in
 *  private-browsing modes and in sandboxed iframes. */
function readOverride(key) {
  try {
    const v = window.localStorage.getItem(LS_PREFIX + key);
    return v === null || v === '' ? undefined : v;
  } catch {
    return undefined;
  }
}

export function writeOverride(key, value) {
  try {
    if (value === undefined || value === null || value === '') {
      window.localStorage.removeItem(LS_PREFIX + key);
    } else {
      window.localStorage.setItem(LS_PREFIX + key, String(value));
    }
    return true;
  } catch {
    // Storage unavailable (private mode / quota). The setting still applies for
    // this page load via the in-memory layer below; it just will not persist.
    return false;
  }
}

/** In-memory overrides so settings take effect even when storage is blocked. */
const memory = new Map();
export function setMemoryOverride(key, value) {
  if (value === undefined || value === null || value === '') memory.delete(key);
  else memory.set(key, String(value));
}

function resolve(key, envValue, fallback) {
  if (memory.has(key)) return memory.get(key);
  const stored = readOverride(key);
  if (stored !== undefined) return stored;
  if (envValue !== undefined && envValue !== '') return envValue;
  return fallback;
}

const asBool = (v) => String(v).toLowerCase() === 'true';
const asInt = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

/**
 * Returns a snapshot of current config. Called fresh on each data load rather
 * than captured once at module scope, so Settings-panel edits apply immediately
 * without a page reload.
 */
export function getConfig() {
  const e = import.meta.env;
  const historyYears = asInt(resolve('historyYears', e.VITE_HISTORY_YEARS, '12'), 12);

  return {
    censusKey: resolve('censusKey', e.VITE_CENSUS_API_KEY, ''),
    blsKey: resolve('blsKey', e.VITE_BLS_API_KEY, ''),
    fredKey: resolve('fredKey', e.VITE_FRED_API_KEY, ''),
    fredMode: resolve('fredMode', e.VITE_FRED_MODE, 'csv'),

    useDevProxy: asBool(resolve('useDevProxy', e.VITE_USE_DEV_PROXY, 'false')),
    corsProxy: resolve('corsProxy', e.VITE_CORS_PROXY, ''),

    // Clamp to the BLS v2 ceiling so a typo in .env cannot silently produce
    // an API error that looks like a network failure.
    historyYears: Math.min(Math.max(historyYears, 2), 20),
    cacheTtlMinutes: asInt(resolve('cacheTtlMinutes', e.VITE_CACHE_TTL_MINUTES, '720'), 720),

    // True when Vite's dev server is running, i.e. when the /proxy/* routes in
    // vite.config.js actually exist. In a production build they do not.
    isDev: Boolean(e.DEV),
  };
}

/** Settings the user may edit at runtime, with metadata for the Settings UI. */
export const EDITABLE_SETTINGS = [
  {
    key: 'censusKey',
    label: 'Census API key',
    type: 'password',
    required: true,
    help: 'Required. Free at api.census.gov/data/key_signup.html',
  },
  {
    key: 'blsKey',
    label: 'BLS API key',
    type: 'password',
    required: false,
    help: 'Optional. Raises the daily limit from 25 to 500 requests and history from 10 to 20 years.',
  },
  {
    key: 'corsProxy',
    label: 'CORS proxy prefix',
    type: 'text',
    required: false,
    help: 'Optional. e.g. https://my-worker.workers.dev/?url= — used only if a direct request is blocked.',
  },
  {
    key: 'historyYears',
    label: 'Years of history',
    type: 'number',
    required: false,
    help: 'Between 2 and 20. Longer windows are slower to parse in the browser.',
  },
];
