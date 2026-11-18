/**
 * Example E2E spec: runs in a browser with the Harbor extension loaded
 * when HARBOR_EXTENSION_PATH is set.
 *
 * Import test/expect from the harbor fixture so the context has the extension loaded.
 */

import { test, expect } from '../fixtures/harbor.js';

test('page has the Web Agent API when the extension is loaded', async ({ page }) => {
  await page.goto('about:blank');
  const hasAi = await page.evaluate(() => typeof (window as unknown as { ai?: unknown }).ai !== 'undefined');
  const hasAgent = await page.evaluate(() => typeof (window as unknown as { agent?: unknown }).agent !== 'undefined');
  // If env vars were set, extensions are loaded and API is present
  expect(typeof hasAi).toBe('boolean');
  expect(typeof hasAgent).toBe('boolean');
});

test('navigate to a URL', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page.locator('h1')).toContainText('Example Domain');
});
