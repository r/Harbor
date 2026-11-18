/**
 * Tests for extension loading and basic functionality.
 * 
 * Note: Full extension loading tests require web-ext or manual setup.
 * These tests are marked as skipped until extension automation is implemented.
 */

import { test, expect } from '../fixtures/index.js';

test.describe('Extension Loading', () => {
  test('Firefox launches successfully', async ({ browserContext }) => {
    // Basic smoke test - Firefox should launch
    const page = await browserContext.newPage();
    await page.goto('about:blank');
    expect(page).toBeTruthy();
  });

  test.skip('Harbor extension loads successfully (requires web-ext setup)', async ({ extensionContext, extensionId }) => {
    expect(extensionId).toBeTruthy();
    expect(extensionId).not.toBe('extension-not-loaded');
    expect(extensionId).toMatch(/^[a-f0-9-]+$/); // UUID format
    
    const page = await extensionContext.newPage();
    await page.goto(`moz-extension://${extensionId}/sidebar.html`);
    await page.waitForLoadState('domcontentloaded');
    
    const title = await page.title();
    expect(title).toBeTruthy();
  });

  test.skip('sidebar page renders (requires extension)', async ({ sidebarPage }) => {
    await sidebarPage.waitForLoadState('domcontentloaded');
    const body = sidebarPage.locator('body');
    await expect(body).toBeVisible();
  });

  test.skip('extension is listed in about:debugging (requires web-ext setup)', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    await page.goto('about:debugging#/runtime/this-firefox');
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('text=Harbor').first()).toBeVisible({ timeout: 10000 });
  });
});
