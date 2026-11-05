import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [preact()],
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@editor': fileURLToPath(new URL('./src/editor', import.meta.url)),
    },
  },
  server: { port: 5173, open: false },
});
