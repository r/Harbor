/**
 * Tests for demo pages.
 * 
 * These tests verify that demo pages load correctly.
 * Tests that require the extension to be loaded are marked as such.
 */

import { test, expect } from '../../fixtures/index.js';

test.describe('Getting Started Demo', () => {
  test('demo page loads', async ({ browserContext, demoServer }) => {
    const page = await browserContext.newPage();
    await page.goto(`${demoServer.url}/web-agents/getting-started/`);
    await page.waitForLoadState('domcontentloaded');
    
    const body = page.locator('body');
    await expect(body).toBeVisible();
  });
});

test.describe('Summarizer Demo', () => {
  test('demo page loads', async ({ browserContext, demoServer }) => {
    const page = await browserContext.newPage();
    await page.goto(`${demoServer.url}/web-agents/summarizer/`);
    await page.waitForLoadState('domcontentloaded');
    
    const body = page.locator('body');
    await expect(body).toBeVisible();
  });
});

test.describe('Time Agent Demo', () => {
  test('demo page loads', async ({ browserContext, demoServer }) => {
    const page = await browserContext.newPage();
    await page.goto(`${demoServer.url}/web-agents/time-agent/`);
    await page.waitForLoadState('domcontentloaded');
    
    const body = page.locator('body');
    await expect(body).toBeVisible();
  });
});

test.describe('Bring Your Own Chatbot Demo', () => {
  test('demo page loads with its chat button', async ({ browserContext, demoServer }) => {
    const page = await browserContext.newPage();
    await page.goto(`${demoServer.url}/web-agents/bring-your-chatbot/`);
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('body')).toBeVisible();
    // The page's only chat UI is the button that calls agent.chat.open().
    await expect(page.locator('#chat-button')).toHaveCount(1);
  });
});
