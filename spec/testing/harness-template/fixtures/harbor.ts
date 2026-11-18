/**
 * Playwright fixtures that load the Harbor extension so every page has
 * window.ai and window.agent. Use with playwright.harbor.config.example.ts.
 *
 * Set HARBOR_EXTENSION_PATH (path to the unpacked extension directory). If
 * unset, context launches without the extension.
 *
 * Usage in your specs:
 *   import { test, expect } from './harbor-test/fixtures/harbor.js';
 *   test('page has the Web Agent API', async ({ page }) => {
 *     await page.goto('http://localhost:3000/my-app');
 *     const has = await page.evaluate(() => typeof (window as any).ai !== 'undefined');
 *     expect(has).toBe(true);
 *   });
 */

import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

if (process.env.WEB_AGENTS_EXTENSION_PATH) {
  console.log('[harbor-test] WEB_AGENTS_EXTENSION_PATH is no longer needed: Harbor serves window.ai and window.agent itself. Ignoring it.');
}

const harborPath = process.env.HARBOR_EXTENSION_PATH || '';
const hasExtensions = harborPath && fs.existsSync(harborPath);

export const test = base.extend<{
  context: BrowserContext;
}>({
  context: async ({}, use) => {
    const userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'harbor-e2e-'));
    const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless: !!process.env.CI,
      channel: 'chromium',
    };
    if (hasExtensions) {
      launchOptions.args = [
        `--disable-extensions-except=${harborPath}`,
        `--load-extension=${harborPath}`,
      ];
    }
    const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    await use(context);
    await context.close();
    try {
      await fs.promises.rm(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  },
});

export { expect } from '@playwright/test';
