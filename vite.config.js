import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config.
 *
 * NOTE ON THE DEV PROXY:
 * This app is designed to run with NO backend. However, a handful of the public
 * data hosts we read (BLS, FRED's CSV endpoint, Redfin's S3 bucket) do not
 * reliably send `Access-Control-Allow-Origin` headers, which means the *browser*
 * refuses to hand us the response body even though the server answered fine.
 *
 * Vite's built-in dev server proxy is a zero-extra-process way to work around
 * that *during local development only*. It is opt-in: the app only routes
 * through these paths when VITE_USE_DEV_PROXY=true. With it off (the default),
 * every request goes straight from the browser to the upstream host and the app
 * is a genuine pure-client SPA.
 *
 * The proxy is a development convenience, not an architectural dependency --
 * `npm run build` produces static files that work without it (see README for how
 * the file-upload fallback covers CORS-blocked sources in a static deploy).
 */
export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves a project site from /<repo>/, not /. The Pages workflow
  // sets VITE_BASE=/Housing/; local dev and root deploys keep '/'.
  base: process.env.VITE_BASE || '/',
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/proxy/bls': {
        target: 'https://api.bls.gov',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/proxy\/bls/, ''),
      },
      '/proxy/fred': {
        target: 'https://fred.stlouisfed.org',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/proxy\/fred/, ''),
      },
      '/proxy/redfin': {
        target: 'https://redfin-public-data.s3.us-west-2.amazonaws.com',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/proxy\/redfin/, ''),
      },
      '/proxy/census': {
        target: 'https://api.census.gov',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/proxy\/census/, ''),
      },
    },
  },
  build: {
    outDir: process.env.VITE_SINGLEFILE === 'true' ? 'dist-single' : 'dist',
    // Single-file mode collapses everything into one chunk so scripts/inline-single.mjs
    // can fold the whole app into one self-contained HTML document (used for the
    // hosted demo preview, where no separate asset requests are allowed).
    cssCodeSplit: process.env.VITE_SINGLEFILE !== 'true',
    sourcemap: true,
    // The charts chunk is ~530KB raw / ~150KB gzipped and that is simply how big
    // recharts + d3 are. Raising the threshold documents that as expected rather
    // than leaving a permanent warning everyone learns to ignore.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Recharts + D3 are most of the bundle and change far less often than
        // app code. Splitting them means editing a panel invalidates ~40KB of
        // cache instead of ~180KB.
        inlineDynamicImports: process.env.VITE_SINGLEFILE === 'true',
        manualChunks: process.env.VITE_SINGLEFILE === 'true' ? undefined : (id) => {
          if (!id.includes('node_modules')) return undefined;
          // Recharts pulls in a large slice of d3. It is the bulk of the bundle
          // and changes only when the dependency is upgraded, so it gets its own
          // long-lived chunk; editing a panel then invalidates ~32KB of cache
          // rather than ~185KB.
          if (/[\\/]node_modules[\\/](recharts|d3-|victory-|decimal\.js)/.test(id)) return 'charts';
          return 'vendor';
        },
      },
    },
  },
});
