import { defineConfig } from 'vite';

// Glyph expects a cross-origin isolated page.
const isolation = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export default defineConfig({
  server: { port: 8731, strictPort: true, host: '127.0.0.1', allowedHosts: ['html-page.tuft.host'], headers: isolation },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ['@pmndrs/glyph'] },
  build: {
    target: 'es2022',
    rolldownOptions: { input: { main: 'index.html', tireLab: 'tire-lab.html' } },
  },
});
