import { defineConfig } from 'vite';

// Glyph expects a cross-origin isolated page.
const isolation = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// Vite leaves its own headers off 304 (not modified) replies. Safari then refuses a module that a
// second worker imports (the physics and chunk workers share modules) for lack of COEP, so every
// reply gets the headers.
const isolationEverywhere = {
  name: 'cross-origin-isolation',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      for (const [key, value] of Object.entries(isolation)) res.setHeader(key, value);
      next();
    });
  },
};

// The page is played through the tuft.host tunnel, which drops long-lived websockets now and then.
// Vite's client then waits for the server and reloads the page, so the drive restarted every so
// often. This takes the reload out: a lost socket only ends live updates until the next reload by
// hand. (`server.ws: false` is no help: the client still connects and fails.)
const RELOAD_ON_RECONNECT = /await waitForSuccessfulPing\(url\.href\);\s*location\.reload\(\);/;
const noReloadOnReconnect = {
  name: 'no-reload-on-reconnect',
  apply: 'serve',
  transform(code, id) {
    if (!id.includes('vite/dist/client/client.mjs')) return;
    if (!RELOAD_ON_RECONNECT.test(code)) {
      this.warn('Vite client changed: the reload after a lost HMR connection is still in');
      return;
    }
    return code.replace(RELOAD_ON_RECONNECT, 'console.log("[vite] not reloading; reload the page by hand to get updates again");');
  },
};

export default defineConfig({
  plugins: [isolationEverywhere, noReloadOnReconnect],
  server: { port: 8731, strictPort: true, host: '127.0.0.1', allowedHosts: ['endless-drift.tuft.host', 'endless-drift-audio.tuft.host'], headers: isolation },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ['@pmndrs/glyph'] },
  build: {
    target: 'es2022',
    rolldownOptions: { input: { main: 'index.html', tireLab: 'tire-lab.html', engineLab: 'engine-lab.html' } },
  },
});
