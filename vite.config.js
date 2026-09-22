import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig(({ command }) => ({
  // Dev server serves index.html (the demo page). Build produces the embeddable library bundle.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    copyPublicDir: true, // copies public/hdri/*.hdr next to the bundle
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.js'),
      formats: ['es'],
      fileName: () => 'grass-field.js',
    },
    rollupOptions: { output: { codeSplitting: false } },
  },
  server: { host: true },
}));
