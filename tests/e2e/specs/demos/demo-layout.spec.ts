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
