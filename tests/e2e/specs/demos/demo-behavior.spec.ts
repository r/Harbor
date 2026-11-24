import type { Page } from '@playwright/test';

// These page-boundary fakes check the demos' contracts. Full Harbor/model
// interactions are also exercised separately in an isolated Firefox profile.
import { expect, test } from '../../fixtures/demo-server.js';

async function installApi(page: Page, failure = '') {
  await page.addInitScript(({ failure }) => {
    const calls: Array<{ type: string; payload?: any }> = [];
    let grantedTools: string[] = [];
    let invoke: any;
    const source = '<html><title>Test source</title><article>' + 'Source evidence about Firefox. '.repeat(30) + '</article></html>';
    const text = 'First model paragraph with evidence. Second model paragraph with a citation [1].';
    Object.assign(window, {
      __demoCalls: calls,
      ai: {
        createTextSession: async () => {
          calls.push({ type: 'create' });
          return {
            prompt: async () => { throw new Error('Non-streaming model path used'); },
            promptStreaming: async function* (prompt: string) {
              calls.push({ type: 'stream', payload: prompt });
              yield 'First model paragraph with evidence. ';
              if (failure === 'model') throw new Error('Model unavailable');
              yield 'Second model paragraph with a citation [1].';
              if (failure === 'html') yield '<img src=x onerror="window.__injected=1">';
            },
            destroy: async () => { calls.push({ type: 'destroy' }); },
          };
        },
      },
      agent: {
        requestPermissions: async (options: any) => {
          calls.push({ type: 'grant', payload: options });
          if (failure === 'permission') return { granted: false };
          grantedTools = options.tools ?? grantedTools;
          return { granted: true, allowedTools: grantedTools };
        },
        tools: {
          list: async () => [{ serverId: 'time-wasm', name: 'time.now' }],
          call: async (options: any) => {
            calls.push({ type: 'tool', payload: options });
            if (!grantedTools.includes(options.tool)) throw new Error('Tool not granted');
            return { content: [{ type: 'text', text: '2026-11-24T00:00:00Z' }] };
          },
        },
        run: async function* () {
          if (!grantedTools.includes('time-wasm/time.now')) throw new Error('Time tool not granted');
          yield { type: 'tool_call', tool: 'time-wasm/time.now' };
          yield { type: 'final', output: 'The time is midnight UTC.' };
        },
        browser: {
          activeTab: {
            fill: async (selector: string, value: string) => {
              const el = document.querySelector(selector) as HTMLInputElement;
              el.value = value; el.dispatchEvent(new Event('input', { bubbles: true }));
            },
            select: async (selector: string, value: string) => {
              const el = document.querySelector(selector) as HTMLSelectElement;
              el.value = value; el.dispatchEvent(new Event('change', { bubbles: true }));
            },
            click: async (selector: string) => { (document.querySelector(selector) as HTMLElement).click(); },
          },
          fetch: async (url: string) => {
            if (url.includes('google.com/search')) return { ok: false, status: 429, body: '' };
            if (url.includes('/w/api.php')) return { ok: true, status: 200, body: JSON.stringify({ query: { search: [{ title: 'Firefox' }] } }) };
            return { ok: true, status: 200, body: source };
          },
        },
        agents: {
          register: async (options: any) => ({ id: options.name }),
          unregister: async (id: string) => { calls.push({ type: 'unregister', payload: id }); },
          onInvoke: (handler: any) => { invoke = handler; return () => {}; },
          invoke: async (_id: string, request: any) => {
            try { return { success: true, result: await invoke({ ...request, from: 'Orchestrator' }) }; }
            catch (error) { return { success: false, error: { message: (error as Error).message } }; }
          },
        },
      },
      __expectedSummary: text,
    });
  }, { failure });
}

for (const failure of ['', 'permission']) {
  test(`Time Agent ${failure || 'calls the explicitly granted tool'}`, async ({ page, demoServer }) => {
    await installApi(page, failure);
    await page.goto(demoServer.url + '/web-agents/time-agent/');
    await page.locator('#call').click();
    await expect(page.locator('#output')).toContainText(failure ? 'Permission' : '2026-11-24T00:00:00Z');
    const calls = await page.evaluate(() => (window as any).__demoCalls);
    expect(calls.filter((c: any) => c.type === 'tool')).toHaveLength(failure ? 0 : 1);
  });
}

test('Getting Started explicitly grants its discovered time tool before running', async ({ page, demoServer }) => {
  await installApi(page);
  await page.goto(demoServer.url + '/web-agents/getting-started/');
  for (let i = 0; i < 5; i++) {
    await page.locator('#next-btn').click();
    if (i < 4) await expect(page.locator('#next-btn')).toBeEnabled();
  }
  await expect(page.locator('#next-btn')).toHaveText(/Complete/);
  await expect(page.locator('[data-step="4"]')).toContainText('midnight UTC');
  const calls = await page.evaluate(() => (window as any).__demoCalls);
  expect(calls.some((c: any) => c.type === 'grant' && c.payload.tools?.includes('time-wasm/time.now'))).toBe(true);
});

test('the wizard completes without a nonexistent browser wait API', async ({ page, demoServer }) => {
  await installApi(page);
  await page.goto(demoServer.url + '/web-agent-control/multi-step-form/');
  for (let i = 0; i < 8; i++) {
    await page.locator('#walkthrough-next').click();
    if (i < 7) await expect(page.locator('#walkthrough-next')).toBeEnabled();
  }
  await expect(page.locator('#confirm-note')).toContainText('Confirmed!');
});

for (const route of ['/web-agent-control/research-agent/', '/multi-web-agent/research-writer/']) {
  for (const failure of ['', 'model']) {
    test(`${route} ${failure ? 'reports model failure without a fake article' : 'accumulates real streamed text and closes its session'}`, async ({ page, demoServer }) => {
      await installApi(page, failure);
      await page.goto(demoServer.url + route);
      const pipeline = route.includes('research-writer');
      await page.locator(pipeline ? '#topic-input' : '#search-input').fill('Firefox');
      await page.locator(pipeline ? '#start-btn' : '#search-btn').click();
      if (failure) {
        await expect(page.locator('body')).toContainText('Model unavailable');
        await expect(page.locator(pipeline ? '#output-section' : '#results')).not.toBeVisible();
      } else {
        const summary = await page.evaluate(() => (window as any).__expectedSummary);
        await expect(page.locator(pipeline ? '#output-body' : 'body')).toContainText(summary);
      }
      await expect.poll(() => page.evaluate(() => (window as any).__demoCalls.filter((c: any) => c.type === 'destroy').length)).toBe(1);
      if (pipeline) {
        await expect.poll(() => page.evaluate(() => (window as any).__demoCalls.filter((c: any) => c.type === 'unregister').length)).toBe(4);
      }
    });
  }
}

for (const mode of ['empty', 'timeout']) {
  test(`research session cleans up on ${mode} and bounds source context`, async ({ page, demoServer }) => {
    await page.goto(demoServer.url);
    const result = await page.evaluate(async ({ url, mode }) => {
      let destroyed = false;
      let returned = false;
      let prompt = '';
      Object.assign(window, { ai: { createTextSession: async () => ({
        promptStreaming: (input: string) => {
          prompt = input;
          return { [Symbol.asyncIterator]: () => ({
            next: () => mode === 'timeout' ? new Promise(() => {}) : Promise.resolve({ done: true }),
            return: async () => { returned = true; return { done: true }; },
          }) };
        },
        destroy: async () => { destroyed = true; },
      }) } });
      const { summarizeResearch } = await import(url);
      let error = '';
      try {
        await summarizeResearch('Question', Array.from({ length: 10 }, (_, i) => ({ title: `Source ${i}`, url: 'https://example.com', text: 'x'.repeat(10_000) })), { timeoutMs: 20 });
      } catch (e) { error = (e as Error).message; }
      return { error, destroyed, returned, promptLength: prompt.length, fourthSource: prompt.includes('Source 3') };
    }, { url: demoServer.url + '/shared/research.js', mode });
    expect(result.error).toMatch(mode === 'timeout' ? /did not finish/ : /empty summary/);
    expect(result.destroyed).toBe(true);
    expect(result.returned).toBe(true);
    expect(result.promptLength).toBeLessThan(5500);
    expect(result.fourthSource).toBe(false);
  });
}

test('pipeline treats model and topic markup as text', async ({ page, demoServer }) => {
  await installApi(page, 'html');
  await page.goto(demoServer.url + '/multi-web-agent/research-writer/');
  await page.locator('#topic-input').fill('<img src=x onerror="window.__injected=1">');
  await page.locator('#start-btn').click();
  await expect(page.locator('#output-body')).toBeVisible();
  await expect(page.locator('#output-body img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__injected)).toBeUndefined();
  await expect(page.locator('#output-body')).toContainText('<img src=x');
});
