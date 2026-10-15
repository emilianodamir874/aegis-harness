// Web build of the aegis Desktop renderer (for aegis-web: browser + aegis serve backend).
// Differences vs the electron build: only index.html is an input (no electron main),
// output goes to dist-web/ and is copied to C:/Aegis-Proyects/web/dist by scripts/copy-web-build.sh.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    react(),
    {
      // Changes the entry chunk content on every build so asset filenames
      // change and stale browser caches are bypassed (aegis-web deploy).
      name: 'aegis-web-build-stamp',
      renderChunk(code, chunk) {
        return chunk.isEntry ? code + `\n// aegis-web build ${Date.now()}\n` : null;
      },
    },
  ],
  base: './',
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
      },
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
    'process.env.AEGIS_BUNDLE_NAME': JSON.stringify('Aegis Web'),
    'process.env.GITHUB_OWNER': JSON.stringify('aaif-goose'),
    'process.env.GITHUB_REPO': JSON.stringify('aegis'),
  },
});
