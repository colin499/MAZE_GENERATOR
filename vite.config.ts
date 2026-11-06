import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

// The build is one self-contained HTML file (scripts, styles and three.js inlined) so the editor opens
// straight from disk (file://) or any static host without a dev server. `base: './'` keeps paths relative.
export default defineConfig({
  base: './',
  plugins: [preact(), viteSingleFile()],
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@editor': fileURLToPath(new URL('./src/editor', import.meta.url)),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: { port: 5173, open: false },
});
