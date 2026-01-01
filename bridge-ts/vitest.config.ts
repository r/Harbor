import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/host/**/*.ts'],
      exclude: ['src/host/__tests__/**'],
    },
    // Increase timeout for integration tests
    testTimeout: 10000,
  },
});

