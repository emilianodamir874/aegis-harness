import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  define: {
    'process.env.GITHUB_OWNER': JSON.stringify(process.env.GITHUB_OWNER || 'aaif-goose'),
    'process.env.GITHUB_REPO': JSON.stringify(process.env.GITHUB_REPO || 'aegis'),
    'process.env.AEGIS_BUNDLE_NAME': JSON.stringify(process.env.AEGIS_BUNDLE_NAME || 'Aegis'),
  },
});
