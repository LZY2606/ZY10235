import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: '.',
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  }
});
