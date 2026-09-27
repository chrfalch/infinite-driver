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

export default defineConfig({
  plugins: [isolationEverywhere],
  server: { port: 8731, strictPort: true, host: '127.0.0.1', allowedHosts: ['html-page.tuft.host'], headers: isolation },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ['@pmndrs/glyph'] },
  build: {
    target: 'es2022',
    rolldownOptions: { input: { main: 'index.html', tireLab: 'tire-lab.html' } },
  },
});
