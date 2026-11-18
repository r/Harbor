/**
 * Example Vitest config for unit tests that use the Web Agent API mock.
 * Copy to vitest.config.ts (or merge into your existing config).
 *
 * npm i -D vitest
 * npx vitest run
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.js', '**/*.test.mjs', '**/*.test.ts'],
  },
});
