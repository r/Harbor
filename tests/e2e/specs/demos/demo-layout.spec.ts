import { expect, test } from '../../fixtures/demo-server.js';

const routes = [
  '/',
  '/404.html',
  '/web-agents/getting-started/',
  '/web-agents/aaf-invoice/',
  '/web-agents/page-tools/',
  '/web-agents/summarizer/',
  '/web-agents/summarizer/chrome-compat.html',
  '/web-agents/time-agent/',
  '/web-agents/bring-your-chatbot/',
  '/web-agent-control/basic-actions/',
  '/web-agent-control/multi-step-form/',
  '/web-agent-control/research-agent/',
  '/multi-web-agent/research-writer/',
];

for (const width of [360, 1280]) {
  test(`demo pages fit a ${width}px viewport in both themes`, async ({ page, demoServer }) => {
    await page.setViewportSize({ width, height: 840 });
    for (const route of routes) {
      await test.step(route, async () => {
        const response = await page.goto(demoServer.url + route);
        expect(response?.ok()).toBe(true);
        const backgrounds = [];
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
          await expect(page.locator('h1').first()).toBeVisible();
          const layout = await page.evaluate(() => ({
            width: document.documentElement.scrollWidth,
            background: getComputedStyle(document.body).backgroundColor,
          }));
          expect(layout.width, `${route} in ${colorScheme}`).toBeLessThanOrEqual(width);
          backgrounds.push(layout.background);
        }
        expect(backgrounds[0], `${route} should respond to the system theme`).not.toBe(backgrounds[1]);
      });
    }
  });
}

for (const variant of ['index.html', 'chrome-compat.html']) {
  test(`the ${variant} bookmarklet displays a summary and closes`, async ({ page, demoServer }) => {
    await page.goto(`${demoServer.url}/web-agents/summarizer/${variant}`);
    const href = await page.locator('#bookmarklet').getAttribute('href');
    expect(href).toMatch(/^javascript:/);

    // Run the saved bookmark on a different page, without the demo's own CSS.
    await page.goto('about:blank');
    await page.setContent('<article>' + 'Sample article text. '.repeat(10) + '</article>');
    await page.evaluate(() => {
      const createSession = async () => ({
        prompt: async () => 'First paragraph.\n\nSecond paragraph.',
        destroy: async () => {},
      });
      Object.assign(window, {
        agent: { requestPermissions: async () => ({ granted: true }) },
        ai: {
          createTextSession: createSession,
          languageModel: { capabilities: async () => ({ available: 'readily' }), create: createSession },
        },
      });
    });
    await page.evaluate(decodeURIComponent(href!.slice('javascript:'.length)));
    const overlay = page.locator('#demo-summary-overlay');
    await expect(overlay.locator('#demo-summary-content p')).toHaveText(['First paragraph.', 'Second paragraph.']);
    await overlay.getByRole('button', { name: 'Close summary' }).click();
    await expect(overlay).toHaveCount(0);
  });
}

test('the shop opens Harbor chat and explains a denied request', async ({ page, demoServer }) => {
  await page.addInitScript(() => {
    Object.assign(window, { agent: { chat: {
      open: async () => { throw Object.assign(new Error('Denied'), { code: 'ERR_PERMISSION_DENIED' }); },
    } } });
  });
  await page.goto(demoServer.url + '/web-agents/bring-your-chatbot/');
  await page.getByRole('button', { name: 'Chat with Acme Shop' }).click();
  await expect(page.locator('#chat-error-banner')).toHaveText("Harbor didn't let Acme Shop open a chat.");
});

test('the invoice widget exposes its input and debug control', async ({ page, demoServer }) => {
  await page.goto(demoServer.url + '/web-agents/aaf-invoice/');
  await expect(page.getByRole('textbox', { name: 'Invoice request' })).toBeVisible();
  const debug = page.getByRole('button', { name: 'Debug' });
  await debug.click();
  await expect(debug).toHaveClass(/active/);
});
