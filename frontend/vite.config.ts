import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// El cliente se sirve bajo /app-react/ desde el mismo server.mjs, que sigue siendo el dueño de
// auth, endpoints auxiliares, assets y proxy ACP. `base` tiene que coincidir con PUBLIC_BASE.
const PUBLIC_BASE = '/app-react/';

export default defineConfig({
  base: PUBLIC_BASE,
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    assetsInlineLimit: 4096,
    // `AEGIS_MINIFY=0` deja el bundle legible para diagnosticar errores de React en producción.
    minify: process.env['AEGIS_MINIFY'] === '0' ? false : 'esbuild',
  },
  server: {
    port: 5174,
    strictPort: true,
    // En desarrollo el backend Node vive en 3788; /acp y los endpoints auxiliares se proxean
    // para que la app corra contra el motor real sin tocar el server.
    proxy: {
      '/acp': { target: 'ws://127.0.0.1:3788', ws: true },
      '/config.js': 'http://127.0.0.1:3788',
      '/healthz': 'http://127.0.0.1:3788',
      '/session': 'http://127.0.0.1:3788',
      '/ws': 'http://127.0.0.1:3788',
      '/memory.json': 'http://127.0.0.1:3788',
      '/pending.json': 'http://127.0.0.1:3788',
      '/changes.json': 'http://127.0.0.1:3788',
      '/file.json': 'http://127.0.0.1:3788',
      '/outbox.json': 'http://127.0.0.1:3788',
      '/doctor.json': 'http://127.0.0.1:3788',
      '/goals.json': 'http://127.0.0.1:3788',
      '/search.json': 'http://127.0.0.1:3788',
      '/stats.json': 'http://127.0.0.1:3788',
      '/prices.json': 'http://127.0.0.1:3788',
      '/tts': 'http://127.0.0.1:3788',
      '/dl': 'http://127.0.0.1:3788',
      '/client-log': 'http://127.0.0.1:3788',
    },
  },
});
