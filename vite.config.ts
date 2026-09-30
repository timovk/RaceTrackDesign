import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5183 },
  worker: { format: 'es' },
  // The 3D view (three.js, about 150 kB gzipped) is its own chunk, loaded when 3D is first opened.
  build: { chunkSizeWarningLimit: 700 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
