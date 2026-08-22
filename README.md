# Housing Market Risk Dashboard

A single-page React app that pulls US housing, construction, labour and credit data
**directly from public APIs in the browser** — no backend, no database, no server-side
code — and rolls fourteen indicators into one composite *price-decline pressure* gauge.

```
┌─ your browser ─────────────────────────────────────────────┐
│  React SPA                                                 │
│    ├── api.census.gov            permits, starts, vacancy  │
│    ├── api.bls.gov               employment, CPI shelter   │
│    ├── fred.stlouisfed.org       credit, sentiment, rates  │
│    └── redfin-public-data.s3…    inventory, price drops    │
│         (gunzipped + TSV-parsed in-page)                   │
└────────────────────────────────────────────────────────────┘
```

---

## Quick start

```bash
# 1. Install
npm install

# 2. Configure (only the Census key is required)
cp .env.example .env
#    Get a free Census key — instant, no approval:
#    https://api.census.gov/data/key_signup.html
#    Put it in .env as VITE_CENSUS_API_KEY=...
#    (Or skip .env entirely and paste the key into the app's Settings tab.)

# 3. Run
npm run dev          # http://localhost:5173

# Other commands
npm run build        # static production build into dist/
npm run preview      # serve the production build locally
node scripts/smoke-test.mjs   # headless end-to-end test with mocked upstreams
```

**Requirements:** Node 18+ and a browser with `DecompressionStream` (Chrome/Edge 80+,
Firefox 113+, Safari 16.4+) — that is what gunzips the Redfin file in-page.

---

## API keys and rate limits

| Source | Key | Limit | Notes |
|---|---|---|---|
| **Census Bureau** | **Required** | No published hard cap (app self-limits to 400/day) | Census now rejects *every* unkeyed request with a 400 + HTML "Missing Key" page. Free and instant. |
| **BLS** | Optional | 25/day without, **500/day with** | A key also raises history from 10 to 20 years. [Register here](https://data.bls.gov/registrationEngine/). |
| **FRED** | Not needed | App self-limits to 300/day | Read through the keyless `fredgraph.csv` endpoint. Set `VITE_FRED_MODE=api` + a key to use the JSON API instead. |
| **Redfin** | None | Bandwidth-bound | Plain public S3 objects. |

### Where keys live, and why it matters

This app has no backend, so **anything in `.env` is compiled into the shipped JavaScript
bundle** and is readable by anyone who loads the page. That is acceptable for these three
specifically — they are free, read-only, rate-limit identifiers, not credentials that
grant access to private data.

If you deploy the built site anywhere public, prefer the **Settings tab**: keys entered
there go to that visitor's `localStorage`, never into the bundle. Settings values override
`.env` and take effect without a rebuild.

### How rate limits are handled

`src/lib/rateLimiter.js` implements a token bucket (minimum spacing between calls) plus a
daily counter persisted per source. Hitting the cap raises a typed `RateLimitError` with a
readable message and the current count, instead of letting you discover an opaque 429 later.
Live counters are visible in **Settings → Rate limits**.

Responses are cached in `localStorage` for 12 hours by default (`VITE_CACHE_TTL_MINUTES`).
These series publish monthly at best, so a long TTL costs nothing in freshness and keeps a
full dashboard load at roughly **six HTTP requests**. On a failed refetch the app falls back
to a stale cache entry and flags it in the UI rather than blanking the panel.

---

## The CORS problem — read this before filing a bug

A browser will not hand JavaScript a cross-origin response unless the server sends
`Access-Control-Allow-Origin`. Some public data hosts do; some don't. Crucially, the browser
hides the difference: a blocked read and a dead host both surface as
`TypeError: Failed to fetch`.

This app disambiguates them (`src/lib/http.js`) by re-probing with `mode: 'no-cors'` — if the
opaque request succeeds, the host is alive and the original failure was the CORS policy. That
distinction drives the advice the UI shows you.

| Host | Expected | If blocked |
|---|---|---|
| `api.census.gov` | Sends `ACAO: *` — works directly | — |
| `api.bls.gov` | Undocumented, often absent | App retries as a batch POST with `Content-Type: text/plain` (a CORS-safelisted type, so **no preflight**), then per-series GET, then a proxy |
| `fred.stlouisfed.org` | CSV endpoint usually readable | Proxy |
| `redfin-public-data.s3…` | A data bucket, not an API — may block | **Drag-and-drop fallback** (below) |

### Three escape hatches, in order of preference

**1. The Redfin file-drop fallback (no configuration).**
If the S3 fetch is blocked, the Inventory tab shows a drop zone. Download the file yourself
and drag it in — `File.stream()` feeds the *same* streaming gunzip + TSV parser used for the
network path, so the charts are identical. Nothing is uploaded anywhere.

```
https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_market_tracker/us_national_market_tracker.tsv000.gz
```

**2. Vite's dev-server proxy (local development).**
Set `VITE_USE_DEV_PROXY=true`. `vite.config.js` declares `/proxy/bls`, `/proxy/fred`,
`/proxy/census` and `/proxy/redfin` routes. This is a dev convenience only — `npm run build`
produces static files that do not depend on it.

**3. Your own CORS proxy (any deployment).**
Set `VITE_CORS_PROXY=https://your-worker.example.dev/?url=` (or paste it into Settings). The
target URL is appended, URL-encoded. Only used after a direct attempt fails.

---

## The risk gauge

### What it is

A weighted average of fourteen indicators, each mapped to 0–100 where **100 = maximum
downward pressure on prices**, grouped into five categories:

| Category | Weight | Indicators |
|---|---|---|
| Resale supply | 34% | Months of supply, price-drop share, inventory YoY |
| New construction | 25% | New-home months' supply, construction pipeline ratio, permits YoY, homeowner vacancy |
| Labour market | 16% | Unemployment drift (Sahm-style), residential construction employment YoY |
| Resale demand | 13% | Homes sold YoY, sale-to-list ratio |
| Affordability & credit | 12% | Mortgage rate change, consumer sentiment, credit card delinquency |

### What it is *not*

**Not a forecast.** It is not a trained model, not a probability, and has not been validated
out of sample. It is a scoreboard: it reads conditions that have historically preceded price
weakness and summarises how many are currently flashing. Housing is local and slow-moving,
every series here is revised after publication, and several are released with a one- to
three-month lag. **This is not investment, financial or legal advice.**

### Design choices worth knowing

**Fixed thresholds, not z-scores.** Each indicator is scaled linearly between two published,
arguable thresholds (e.g. months of supply: 2.5 → score 0, 8.0 → score 100). A z-score would
make the result depend on how much history you happened to load and would be far harder to
explain. Every threshold lives in `INDICATORS` in `src/model/riskModel.js` — change a number,
and the gauge changes with it.

**Honest degradation.** If a source fails, its indicators drop out and the remaining weights
are renormalised. The UI reports **coverage** (share of total weight that resolved), so a
score built from four of fourteen indicators is never mistaken for a complete one, and the
breakdown lists exactly which inputs are missing and why.

**Fully auditable.** The Overview tab shows every indicator's raw value, both thresholds, its
sub-score, its renormalised weight, and its contribution to the total.

### Tuning it

```js
// src/model/riskModel.js
{
  key: 'monthsOfSupply',
  weight: 0.13,   // ← relative importance; weights are renormalised, so they need not sum to 1
  low: 2.5,       // ← value that scores 0
  high: 8,        // ← value that scores 100
  // When high < low the relationship is inverted (e.g. consumer sentiment).
}
```

---

## Project layout

```
src/
├── config/
│   ├── env.js            Config resolution: localStorage → .env → default
│   └── states.js         State FIPS + postal codes for the geography filter
├── lib/
│   ├── http.js           Fetch layer: timeout, retry+jitter, CORS detection, proxy ladder
│   ├── rateLimiter.js    Token bucket + persisted daily quota per source
│   ├── cache.js          Two-tier TTL cache (memory + localStorage), stale fallback
│   ├── tsv.js            Streaming gunzip + TSV/CSV parsers
│   └── stats.js          YoY, percentile, moving average, threshold scaling
├── data/
│   ├── census.js         EITS resconst / ressales / hv + runtime code resolution
│   ├── bls.js            v1/v2 with the preflight-free request ladder
│   ├── fred.js           Keyless CSV endpoint (or JSON API)
│   └── redfin.js         Streamed S3 fetch + file-drop fallback
├── model/riskModel.js    Indicator definitions, weights, thresholds, scoring
├── hooks/useDashboardData.js
└── components/           Charts, gauge, breakdown, settings, diagnostics
```

### Why `census.js` discovers series codes at runtime

Census identifies each EITS series by a `(category_code, data_type_code)` pair, and **does not
publish the valid values through the API** — `variables/category_code.json` returns the field's
schema, not its domain. The codes also differ per dataset and have changed across survey
revisions.

Hard-coding a guessed pair gives you a chart that silently goes blank the day Census renames
something. Instead the app fetches the whole national time slice in **one request**, groups it
into series in the browser, and resolves each chart against an ordered candidate list. The
**Data sources** tab shows which candidate matched and lets you browse every series the API
actually returned — so an unmatched chart is a 30-second fix (add the real pair to that
entry's `candidates` array), not a debugging session.

---

## Memory: how a 200 MB file is parsed in a browser tab

The Redfin national file is a few MB; the county and ZIP files are hundreds of MB uncompressed.
`src/lib/tsv.js` never materialises the whole thing:

```
response.body
  → DecompressionStream('gzip')
  → TextDecoderStream
  → split on newlines as chunks arrive
  → keep only the ~20 requested columns
  → keep only rows passing the filter
```

Peak memory stays proportional to the *result set*, not the file. Progress (rows parsed, MB
decompressed) is reported live.

---

## Charts

Recharts, with a few rules enforced by the shared `TimeSeriesChart` component rather than left
to each panel:

- **One y-axis, always.** Measures on different scales become separate charts, or are expressed
  as year-over-year growth rates so they legitimately share an axis. A dual-axis chart invents a
  correlation that isn't in the data.
- **Colours are assigned by series identity in fixed slot order**, never by rank — filtering
  never repaints the survivors. The palette is validated for colour-vision deficiency.
- **Every chart has a table view** behind a toggle, so no value is reachable only by hovering.
- **Legend for ≥ 2 series; selective end-point labels**, never a number on every point.
- **Light and dark themes** are both explicitly designed, not an automatic inversion.

---

## Testing

```bash
npm run build && node scripts/smoke-test.mjs
```

Loads the built app in headless Chromium with all four upstream hosts intercepted and served
synthetic-but-correctly-shaped payloads, then asserts: no console errors or page exceptions,
each parser (Census JSON, BLS envelope, FRED CSV, gzipped TSV) produces charts, the gauge
renders a numeric score at 100% coverage, all Census codes resolve, every tab mounts, and the
table-view toggle works. This catches the class of bug `vite build` cannot — render-time
Recharts props, parsers that silently yield zero rows, null dereferences in the model.

---

## Deploying

`npm run build` emits a fully static `dist/`. Drop it on Netlify, Vercel, GitHub Pages, S3 —
anywhere that serves files. Two caveats:

1. The Vite dev proxy does **not** exist in production. Configure `VITE_CORS_PROXY`, or rely on
   the Redfin file-drop fallback.
2. Don't bake keys into a public build — let visitors supply their own via Settings.

---

## Data sources

- **US Census Bureau**, Economic Indicators Time Series API — [developer docs](https://www.census.gov/data/developers/data-sets/economic-indicators.html)
- **US Bureau of Labor Statistics**, Public Data API v2 — [docs](https://www.bls.gov/developers/)
- **FRED**, Federal Reserve Bank of St. Louis — Freddie Mac PMMS, U. Michigan sentiment, Federal Reserve G.19, S&P CoreLogic Case-Shiller, NAR existing home sales
- **Redfin Data Center** — [redfin.com/news/data-center](https://www.redfin.com/news/data-center/). Redfin data is provided free with attribution; see their terms.

## Licence

MIT for the application code. The underlying data is subject to each publisher's terms.
