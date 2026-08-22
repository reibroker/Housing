/**
 * The fetch layer.
 *
 * Everything remote in this app goes through `request()`, which layers on:
 *   - a hard timeout (browsers will otherwise hang for minutes on a dead host)
 *   - retry with exponential backoff + jitter, but ONLY for errors worth
 *     retrying (network blips, 429, 5xx) -- never for a 400 caused by a bad key
 *   - CORS-failure detection and a documented escalation ladder
 *   - typed errors so the UI can say something specific instead of "failed"
 *
 * On detecting CORS failure
 * -------------------------
 * The browser deliberately hides the difference between "host unreachable" and
 * "host answered but omitted Access-Control-Allow-Origin": both surface as an
 * opaque `TypeError: Failed to fetch`. We cannot inspect the response. What we
 * can do is probe with `mode: 'no-cors'` -- if that opaque request succeeds, the
 * server is alive and reachable, so the original failure was almost certainly
 * the CORS policy. That distinction is what drives the UI's advice: "this host
 * blocks browser reads, use the upload fallback" vs "you appear to be offline".
 */

import { getConfig } from '../config/env.js';
import { acquire, refund, RateLimitError } from './rateLimiter.js';
import { cacheGet, cacheSet, cacheGetStale } from './cache.js';

export class HttpError extends Error {
  constructor(message, { status, url, kind, cause } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    /** 'cors' | 'network' | 'timeout' | 'http' | 'parse' | 'quota' | 'config' */
    this.kind = kind || 'network';
    this.cause = cause;
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Probe whether a host is reachable at all, ignoring CORS.
 * A `no-cors` request yields an opaque response we cannot read -- but the fact
 * that it resolves at all tells us the TCP/TLS handshake and HTTP round trip
 * worked, which is exactly what we want to know.
 */
async function isReachableIgnoringCors(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(url, { mode: 'no-cors', signal: ctrl.signal, cache: 'no-store' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Build the ordered list of URLs to try for a given upstream URL.
 *
 * 1. The direct URL -- the pure client-side path, always tried first.
 * 2. Vite's dev-server proxy, if enabled and we are actually in dev.
 * 3. A user-supplied CORS proxy, if configured.
 *
 * `proxyPath` is the /proxy/* prefix declared in vite.config.js for this host,
 * or null for hosts that are known to send proper CORS headers.
 */
export function buildAttemptUrls(directUrl, proxyPath) {
  const cfg = getConfig();
  const urls = [{ url: directUrl, via: 'direct' }];

  if (proxyPath && cfg.useDevProxy && cfg.isDev) {
    const u = new URL(directUrl);
    urls.push({ url: `${proxyPath}${u.pathname}${u.search}`, via: 'dev-proxy' });
  }

  if (proxyPath && cfg.corsProxy) {
    urls.push({ url: `${cfg.corsProxy}${encodeURIComponent(directUrl)}`, via: 'cors-proxy' });
  }

  return urls;
}

/**
 * Core request function.
 *
 * @param {string} url            Upstream URL.
 * @param {object} opts
 * @param {string} opts.source    Rate-limiter bucket: census | bls | fred | redfin
 * @param {boolean} opts.hasKey   Whether an API key is in play (affects BLS quota)
 * @param {'json'|'text'|'arrayBuffer'} opts.as  How to decode a successful body
 * @param {string|null} opts.proxyPath  /proxy/* prefix for CORS-hostile hosts
 * @param {number} opts.timeoutMs
 * @param {number} opts.retries
 * @param {RequestInit} opts.init  Extra fetch options (method, body, headers)
 * @returns {Promise<{data:any, via:string, url:string}>}
 */
export async function request(url, opts = {}) {
  const {
    source,
    hasKey = false,
    as = 'json',
    proxyPath = null,
    timeoutMs = 30_000,
    retries = 2,
    init = {},
  } = opts;

  const attempts = buildAttemptUrls(url, proxyPath);
  let lastError = null;

  for (const attempt of attempts) {
    for (let tryNo = 0; tryNo <= retries; tryNo++) {
      let reserved = false;
      try {
        if (source) {
          await acquire(source, hasKey);
          reserved = true;
        }

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);

        let res;
        try {
          res = await fetch(attempt.url, {
            ...init,
            signal: ctrl.signal,
            // `omit` avoids sending cookies cross-origin, which would force a
            // preflight and make a permissive `*` CORS header invalid.
            credentials: 'omit',
          });
        } finally {
          clearTimeout(timer);
        }

        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          const snippet = bodyText.slice(0, 300);

          // Census returns 400 + an HTML "Missing Key" page rather than a 401,
          // so detect the auth case by content, not status.
          if (/valid\s*key|missing\s*key|invalid\s*key|API key/i.test(snippet) || res.status === 401 || res.status === 403) {
            throw new HttpError(
              `${res.status} from ${new URL(attempt.url, location.href).hostname}: the API key was rejected or missing. ${snippet ? `Server said: ${snippet.replace(/<[^>]+>/g, ' ').trim().slice(0, 160)}` : ''}`,
              { status: res.status, url: attempt.url, kind: 'config' }
            );
          }

          const err = new HttpError(
            `HTTP ${res.status} ${res.statusText} from ${new URL(attempt.url, location.href).hostname}${snippet ? ` -- ${snippet.replace(/<[^>]+>/g, ' ').trim().slice(0, 160)}` : ''}`,
            { status: res.status, url: attempt.url, kind: 'http' }
          );

          if (RETRYABLE_STATUS.has(res.status) && tryNo < retries) {
            lastError = err;
            await sleep(backoff(tryNo));
            continue;
          }
          throw err;
        }

        let data;
        try {
          if (as === 'json') data = await res.json();
          else if (as === 'arrayBuffer') data = await res.arrayBuffer();
          else data = await res.text();
        } catch (e) {
          throw new HttpError(
            `Response from ${new URL(attempt.url, location.href).hostname} could not be decoded as ${as}. The endpoint may have returned an error page instead of data.`,
            { url: attempt.url, kind: 'parse', cause: e }
          );
        }

        return { data, via: attempt.via, url: attempt.url };
      } catch (e) {
        if (reserved && (e.kind === 'network' || e.kind === 'cors' || e.name === 'AbortError')) {
          // The request never produced a server response, so do not charge it
          // against the daily budget.
          refund(source);
        }

        if (e instanceof RateLimitError) throw e;
        if (e instanceof HttpError && (e.kind === 'config' || e.kind === 'parse')) throw e;

        if (e.name === 'AbortError') {
          lastError = new HttpError(
            `Request to ${new URL(attempt.url, location.href).hostname} timed out after ${timeoutMs / 1000}s.`,
            { url: attempt.url, kind: 'timeout', cause: e }
          );
        } else if (e instanceof HttpError) {
          lastError = e;
        } else {
          // The opaque `TypeError: Failed to fetch`. Work out which flavour.
          const reachable = attempt.via === 'direct' ? await isReachableIgnoringCors(url) : false;
          lastError = new HttpError(
            reachable
              ? `${new URL(url).hostname} is reachable but refused the browser read: it did not send an ` +
                `Access-Control-Allow-Origin header. This is a browser security policy, not a server outage.`
              : `Could not reach ${new URL(url).hostname}. Check your network connection, or the host may be down.`,
            { url: attempt.url, kind: reachable ? 'cors' : 'network', cause: e }
          );
        }

        if (tryNo < retries && lastError.kind !== 'cors') {
          await sleep(backoff(tryNo));
          continue;
        }
        break; // move on to the next attempt URL (proxy), if any
      }
    }
  }

  throw lastError || new HttpError(`Request to ${url} failed for an unknown reason.`, { url, kind: 'network' });
}

/** Exponential backoff with full jitter, capped at 8s. */
function backoff(tryNo) {
  const base = Math.min(8000, 500 * 2 ** tryNo);
  return Math.random() * base;
}

/**
 * Cache-aware wrapper. On a live failure it falls back to a stale cache entry
 * (flagged as such) rather than leaving the panel empty.
 */
export async function cachedRequest(cacheKey, url, opts = {}) {
  const { cacheTtlMinutes } = getConfig();

  const hit = cacheGet(cacheKey, cacheTtlMinutes);
  if (hit) return { data: hit.value, via: `cache:${hit.tier}`, cached: true, ageMs: hit.ageMs, stale: false };

  try {
    const res = await request(url, opts);
    cacheSet(cacheKey, res.data);
    return { ...res, cached: false, ageMs: 0, stale: false };
  } catch (err) {
    const stale = cacheGetStale(cacheKey);
    if (stale) {
      return { data: stale.value, via: `cache:stale`, cached: true, ageMs: stale.ageMs, stale: true, error: err };
    }
    throw err;
  }
}
