#!/usr/bin/env node
/**
 * OPTIONAL standalone CORS proxy.  `npm run proxy`
 *
 * The app is designed to need no backend, and in normal use it doesn't: Census
 * works directly, and Redfin has the file-drop fallback. This script exists for
 * one specific case -- you want to run `npm run preview` (or a deployed static
 * build, which has no Vite dev server) and BLS or FRED are blocking browser
 * reads from your origin.
 *
 * Usage:
 *     npm run proxy                       # listens on http://localhost:8787
 *     # then set, in .env or the app's Settings tab:
 *     VITE_CORS_PROXY=http://localhost:8787/?url=
 *
 * Deliberately restrictive: it forwards only to an explicit host allowlist and
 * only GET/POST, so it cannot be turned into an open relay if you leave it
 * running. It is a local development tool -- do not expose it to the internet.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8787);

const ALLOWED_HOSTS = new Set([
  'api.bls.gov',
  'fred.stlouisfed.org',
  'api.stlouisfed.org',
  'api.census.gov',
  'redfin-public-data.s3.us-west-2.amazonaws.com',
]);

const server = createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.writeHead(405, { ...cors, 'Content-Type': 'text/plain' });
    return res.end('Only GET and POST are proxied.');
  }

  const target = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('url');
  if (!target) {
    res.writeHead(400, { ...cors, 'Content-Type': 'text/plain' });
    return res.end('Pass the upstream URL as ?url=<encoded>');
  }

  let upstream;
  try {
    upstream = new URL(target);
  } catch {
    res.writeHead(400, { ...cors, 'Content-Type': 'text/plain' });
    return res.end('Malformed target URL.');
  }

  if (upstream.protocol !== 'https:' || !ALLOWED_HOSTS.has(upstream.hostname)) {
    res.writeHead(403, { ...cors, 'Content-Type': 'text/plain' });
    return res.end(
      `Refusing to proxy ${upstream.hostname}. Allowed hosts: ${[...ALLOWED_HOSTS].join(', ')}`
    );
  }

  // Buffer the request body for POST (BLS's batch endpoint).
  const body = req.method === 'POST'
    ? await new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
      })
    : undefined;

  try {
    const upstreamRes = await fetch(upstream, {
      method: req.method,
      headers: req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {},
      body,
    });

    const buf = Buffer.from(await upstreamRes.arrayBuffer());
    res.writeHead(upstreamRes.status, {
      ...cors,
      'Content-Type': upstreamRes.headers.get('content-type') || 'application/octet-stream',
      // Pass gzip through untouched -- the browser gunzips Redfin files itself.
      ...(upstreamRes.headers.get('content-encoding')
        ? { 'Content-Encoding': upstreamRes.headers.get('content-encoding') }
        : {}),
    });
    res.end(buf);
    console.log(`${upstreamRes.status} ${req.method} ${upstream.hostname}${upstream.pathname}`);
  } catch (e) {
    res.writeHead(502, { ...cors, 'Content-Type': 'text/plain' });
    res.end(`Upstream request failed: ${e.message}`);
    console.error(`502 ${req.method} ${upstream.href} -- ${e.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`CORS proxy listening on http://localhost:${PORT}`);
  console.log(`Set VITE_CORS_PROXY=http://localhost:${PORT}/?url=`);
  console.log(`Allowed upstreams: ${[...ALLOWED_HOSTS].join(', ')}`);
});
