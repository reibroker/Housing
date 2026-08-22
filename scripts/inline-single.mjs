/**
 * Fold the single-file build into one self-contained HTML fragment.
 *
 * Used for the hosted demo preview, where the page must carry its own CSS and
 * JS inline -- no separate asset requests are permitted. Run after:
 *
 *     VITE_SINGLEFILE=true VITE_DEFAULT_DEMO=true npm run build
 *
 * Emits `housing-dashboard-demo.html` containing everything the app needs.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('../dist-single/assets/', import.meta.url).pathname;
const files = readdirSync(DIST);

const js = files.filter((f) => f.endsWith('.js'));
const css = files.filter((f) => f.endsWith('.css'));
if (js.length !== 1) throw new Error(`Expected exactly one JS chunk, found ${js.length}: ${js.join(', ')}`);

const jsSource = readFileSync(join(DIST, js[0]), 'utf8');
const cssSource = css.map((f) => readFileSync(join(DIST, f), 'utf8')).join('\n');

// The published page is wrapped in a doctype/head/body skeleton by the host, so
// this file contains page *content* only -- no <html>, <head> or <body> tags.
const html = `<title>Housing Market Risk Dashboard</title>
<style>
${cssSource}
</style>
<div id="root"></div>
<script type="module">
${jsSource}
</script>
`;

const out = new URL('../housing-dashboard-demo.html', import.meta.url).pathname;
writeFileSync(out, html, 'utf8');
console.log(`Wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
