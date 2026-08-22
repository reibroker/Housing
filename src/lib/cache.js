/**
 * TTL cache backed by localStorage, with an in-memory tier in front of it.
 *
 * Why this exists: every source here publishes monthly or weekly at best, but
 * a React dev server hot-reloads constantly. Without a cache you would burn
 * through the BLS keyless quota (25 requests/day) in about ten minutes of
 * editing. The in-memory tier also keeps re-renders from re-parsing the ~50MB
 * Redfin TSV.
 *
 * Storage failures are never fatal -- if localStorage is unavailable or full,
 * we silently fall back to memory-only for the session.
 */

const PREFIX = 'hmd:cache:';
const memory = new Map();

/** Rough guard so one huge payload cannot blow the ~5MB localStorage quota. */
const MAX_PERSIST_BYTES = 1_500_000;

export function cacheGet(key, ttlMinutes) {
  const ttlMs = ttlMinutes * 60_000;

  const mem = memory.get(key);
  if (mem && Date.now() - mem.t < ttlMs) {
    return { value: mem.v, ageMs: Date.now() - mem.t, tier: 'memory' };
  }

  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const age = Date.now() - parsed.t;
    if (age >= ttlMs) {
      window.localStorage.removeItem(PREFIX + key);
      return null;
    }
    memory.set(key, parsed);
    return { value: parsed.v, ageMs: age, tier: 'storage' };
  } catch {
    return null;
  }
}

/**
 * Read a cached value regardless of age. Used as a last-resort fallback when a
 * live fetch fails: showing month-old data with a visible "stale" badge is more
 * useful than showing an empty panel.
 */
export function cacheGetStale(key) {
  const mem = memory.get(key);
  if (mem) return { value: mem.v, ageMs: Date.now() - mem.t, tier: 'memory' };
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { value: parsed.v, ageMs: Date.now() - parsed.t, tier: 'storage' };
  } catch {
    return null;
  }
}

export function cacheSet(key, value) {
  const entry = { t: Date.now(), v: value };
  memory.set(key, entry);

  let serialized;
  try {
    serialized = JSON.stringify(entry);
  } catch {
    return; // non-serializable payload: memory tier only
  }
  if (serialized.length > MAX_PERSIST_BYTES) return;

  try {
    window.localStorage.setItem(PREFIX + key, serialized);
  } catch {
    // Most likely QuotaExceededError. Evict our own entries and retry once.
    try {
      clearCache();
      window.localStorage.setItem(PREFIX + key, serialized);
    } catch {
      /* memory-only from here */
    }
  }
}

export function clearCache() {
  memory.clear();
  try {
    const doomed = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(PREFIX)) doomed.push(k);
    }
    doomed.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* nothing to clear */
  }
}

export function cacheStats() {
  let entries = 0;
  let bytes = 0;
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(PREFIX)) {
        entries++;
        bytes += (window.localStorage.getItem(k) || '').length;
      }
    }
  } catch {
    /* ignore */
  }
  return { entries, bytes, memoryEntries: memory.size };
}
