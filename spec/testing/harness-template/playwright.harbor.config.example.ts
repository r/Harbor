/**
 * Example Playwright config for E2E tests with the Harbor extension.
 *
 * 1. Copy this file to your project (e.g. playwright.config.ts).
 * 2. Set HARBOR_EXTENSION_PATH to your Harbor build:
 *    export HARBOR_EXTENSION_PATH=/path/to/harbor/extension/dist-chrome
 * 3. In your E2E specs, import test/expect from harbor-test/fixtures/harbor.js (not @playwright/test).
 * 4. Run: npx playwright test
 *
 * The extension is loaded via the harbor fixture (launchPersistentContext + Chromium).
 * Without the env var set, tests still run but window.ai/agent won't be present.
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './harbor-test/e2e',
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium-with-harbor',
      use: {
        browserName: 'chromium',
      },
    },
  ],
});
