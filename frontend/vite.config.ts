import path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Inject `preconnect` for the API origin into index.html at build time.
 *
 * The first API call measured 88ms to connect and a further 95ms for TLS before any
 * byte of a response — ~185ms spent on setup, serialised in front of a request that
 * itself takes 450ms. Those handshakes can happen while the JS bundle is still
 * downloading instead.
 *
 * Done as a build-time transform rather than a literal tag because the origin differs
 * per environment (localhost in dev, Railway in production) and belongs in
 * VITE_API_URL, not hardcoded in markup. Skipped when the variable is unset, which is
 * the same-origin dev case where there is nothing to warm.
 */
function preconnectApi(): Plugin {
  let apiUrl = '';

  return {
    name: 'tixlock-preconnect-api',
    configResolved(config) {
      // `loadEnv`, not `process.env`. Vite reads .env files into `import.meta.env` and
      // does not populate `process.env`, so reading that directly worked only when the
      // variable happened to be exported in the shell — which silently skipped the tag
      // for every normal local build. A platform-provided variable (Vercel) is picked
      // up here too, since loadEnv merges it.
      apiUrl = loadEnv(config.mode, config.root, 'VITE_').VITE_API_URL ?? '';
    },
    transformIndexHtml(html) {
      if (!apiUrl) return html;
      let origin: string;
      try {
        origin = new URL(apiUrl).origin;
      } catch {
        return html;
      }
      // `crossorigin` matters: the app's API calls are CORS requests, and a
      // preconnect whose credentials mode disagrees opens a second connection
      // instead of reusing the warmed one.
      return html.replace(
        '</head>',
        `    <link rel="preconnect" href="${origin}" crossorigin />\n  </head>`
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), preconnectApi()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    // The API base URL is supplied by VITE_API_URL, so no dev proxy is required.
    // A proxy is still configured for /api as a convenience: it means a developer
    // who leaves VITE_API_URL unset gets same-origin relative requests that work
    // out of the box against a backend on :3000.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        /**
         * Collapse the long tail of tiny shared chunks.
         *
         * Rollup's default splitting produced ~40 single-icon chunks (376–576 bytes
         * each) plus small shared modules like `datetime`, `eventTheme` and `types`.
         * Bytes were never the problem; *discovery* was. A module is only requested
         * once its importer has been parsed, so those chunks formed a third waterfall
         * wave — traced on the live site at 650ms, holding the first API call back to
         * 1133ms on a cold load. Every wave costs a full round trip, and the API is
         * already 450ms away.
         *
         * Folding them into two predictable vendor chunks means the browser learns
         * about everything it needs one wave earlier. Route chunks stay split, so a
         * customer still never downloads recharts or socket.io.
         */
        manualChunks(id) {
          // Deliberately narrow. A catch-all `vendor` bucket was tried first and made
          // things worse: it hoisted react-hook-form and zod out of their lazy `form`
          // chunk into an eagerly loaded one, adding ~88 kB to first paint to save a
          // few requests. Rollup's default grouping already keeps recharts, socket.io
          // and the form stack scoped to the routes that import them, so the only thing
          // worth overriding is the icon fan-out.
          if (id.includes('node_modules/lucide-react')) return 'icons';
        },
      },
    },
  },
});
