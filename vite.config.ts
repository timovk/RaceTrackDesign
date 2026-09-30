import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5183 },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
