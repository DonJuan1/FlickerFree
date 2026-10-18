import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // Relative base so the build works on GitHub Pages regardless of repo-name casing.
  base: './',
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        probe: resolve(import.meta.dirname, 'probe.html'),
        target: resolve(import.meta.dirname, 'target.html'),
      },
    },
  },
});
