import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import licenceNotices from './scripts/licence-notices.js';

// Control plane the dev server proxies /api and /health to. Point it at a
// remote one (e.g. WAFIO_API_TARGET=https://demo-cp.wafio.cloud) with
// VITE_API_BASE_URL left empty, so the browser stays same-origin and the
// remote control plane needs no CORS.
const apiTarget = process.env.WAFIO_API_TARGET || 'http://127.0.0.1:9087';

// Sub-path the dashboard is served under; the release build sets a placeholder
// that the control plane replaces when it serves the files.
const base = process.env.BASE_PATH ?? '';

/** @type {import('vite').UserConfig} */
const config = {
  plugins: [
    sveltekit({
      adapter: adapter({
        pages: 'dist',
        assets: 'dist',
        fallback: 'index.html',
        precompress: false,
        strict: false
      }),
      paths: { base }
    }),
    licenceNotices()
  ],
  server: {
    allowedHosts: ['wafio.cloud', 'www.wafio.cloud', 'web.wafio.cloud', 'localhost', '127.0.0.1'],
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            // Disable buffering for SSE streams
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        }
      },
      '/health': {
        target: apiTarget,
        changeOrigin: true
      }
    }
  }
};

export default config;
