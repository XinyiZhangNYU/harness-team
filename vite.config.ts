import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(import.meta.dirname, 'web'),
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'web/dist'),
    emptyOutDir: true,
  },
});
