/**
 * Per-source rate limiting: a client-side token bucket for burst control plus a
 * persisted daily counter for the published quotas.
 *
 * The published limits this guards against:
 *   BLS v2 (with key)    : 500 requests/day, 50 series/request, 20 years/request
 *   BLS v1 (no key)      : 25 requests/day, 25 series/request, 10 years/request
 *   Census (with key)    : no published hard cap; we self-impose a courtesy cap
 *   FRED csv endpoint    : no published cap; courtesy cap
 *   Redfin S3            : plain object storage; the cost is bandwidth, not calls
 *
 * A limiter cannot enforce anything the server does not, but it does two useful
 * things: it stops a render loop from hammering an endpoint, and it lets the UI
 * tell the user "you have 12 BLS calls left today" instead of surfacing an
 * opaque 429 later.
 */

const DAY_KEY = 'hmd:quota:';

export const QUOTAS = {
  census: { perDay: 400, minIntervalMs: 250, label: 'Census Bureau' },
  bls: { perDay: 500, perDayNoKey: 25, minIntervalMs: 400, label: 'BLS' },
  fred: { perDay: 300, minIntervalMs: 250, label: 'FRED' },
  redfin: { perDay: 60, minIntervalMs: 1000, label: 'Redfin S3' },
};

function todayStamp() {
  return new Date().toISOString().slice(0, 10); // UTC day; quotas reset on the provider's clock, this is close enough
}

function readCount(source) {
  try {
    const raw = window.localStorage.getItem(DAY_KEY + source);
    if (!raw) return 0;
    const { day, n } = JSON.parse(raw);
    return day === todayStamp() ? n : 0;
  } catch {
    return 0;
  }
}

function writeCount(source, n) {
  try {
    window.localStorage.setItem(DAY_KEY + source, JSON.stringify({ day: todayStamp(), n }));
  } catch {
    /* non-persistent session */
  }
}

const lastCallAt = new Map();

export class RateLimitError extends Error {
  constructor(source, used, limit) {
    super(
      `Daily request budget for ${QUOTAS[source]?.label || source} is exhausted ` +
        `(${used}/${limit} used). Cached data is still available; the counter resets at midnight UTC.`
    );
    this.name = 'RateLimitError';
    this.source = source;
    this.used = used;
    this.limit = limit;
  }
}

/** Effective daily limit, which for BLS depends on whether a key is present. */
export function limitFor(source, hasKey) {
  const q = QUOTAS[source];
  if (!q) return Infinity;
  if (source === 'bls') return hasKey ? q.perDay : q.perDayNoKey;
  return q.perDay;
}

export function quotaStatus(source, hasKey) {
  const limit = limitFor(source, hasKey);
  const used = readCount(source);
  return { source, used, limit, remaining: Math.max(0, limit - used), label: QUOTAS[source]?.label || source };
}

/**
 * Reserve one request slot. Throws RateLimitError if the daily budget is spent,
 * and awaits the minimum inter-request interval otherwise.
 */
export async function acquire(source, hasKey = false) {
  const q = QUOTAS[source];
  if (!q) return;

  const limit = limitFor(source, hasKey);
  const used = readCount(source);
  if (used >= limit) throw new RateLimitError(source, used, limit);

  const last = lastCallAt.get(source) || 0;
  const wait = q.minIntervalMs - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  lastCallAt.set(source, Date.now());
  writeCount(source, used + 1);
}

/** Called when a request never actually reached the network, so the slot is refunded. */
export function refund(source) {
  const used = readCount(source);
  if (used > 0) writeCount(source, used - 1);
}

export function resetQuotas() {
  Object.keys(QUOTAS).forEach((s) => writeCount(s, 0));
}
