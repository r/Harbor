import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    alias: {
      'webextension-polyfill': path.resolve(__dirname, 'src/provider/__tests__/__mocks__/webextension-polyfill.ts'),
    },
  },
});

