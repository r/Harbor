import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The spec says agent.browser.activeTab.readability() resolves to
// { url, title, text }. tab.readability(tabId) returns the same shape.
// Drive both through the router with the real in-tab script.

const mocks = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  executeScriptInTab: vi.fn(),
  getFeatureFlags: vi.fn(),
}));

vi.mock('../handlers/permission-handlers', async (importOriginal) => ({
  ...(await importOriginal<object>()), hasPermission: mocks.hasPermission,
}));
vi.mock('../../browser-compat', async (importOriginal) => ({
  ...(await importOriginal<object>()), executeScriptInTab: mocks.executeScriptInTab,
}));
vi.mock('../policy/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<object>()), getFeatureFlags: mocks.getFeatureFlags,
}));

const CALLER = 'https://news.example';

/** Run the in-tab function against a small article page on `CALLER`. */
function runInPage(fn: (...a: unknown[]) => unknown, args: unknown[]) {
  const article = { innerText: 'Headline\n\n  First   paragraph. \nSecond paragraph.' };
  vi.stubGlobal('window', { location: { origin: CALLER, href: `${CALLER}/story` } });
  vi.stubGlobal('document', {
    title: 'Story',
    body: { innerText: 'nav\nHeadline\nFirst paragraph.\nfooter', innerHTML: '<p>x</p>' },
    querySelector: (sel: string) => (sel === 'article' ? article : null),
  });
  return fn(...args);
}

const EXPECTED = { url: `${CALLER}/story`, title: 'Story', text: 'Headline\nFirst paragraph.\nSecond paragraph.' };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.hasPermission.mockResolvedValue(true);
  mocks.getFeatureFlags.mockResolvedValue({ browserInteraction: true, browserControl: true });
  mocks.executeScriptInTab.mockImplementation(async (_id: number, fn: (...a: unknown[]) => unknown, args: unknown[] = []) =>
    runInPage(fn, args));
  vi.stubGlobal('chrome', {
    runtime: { getURL: () => 'chrome-extension://harbor/' },
    storage: { local: { set: vi.fn(async () => {}), get: vi.fn(async () => ({})) } },
    tabs: {
      create: vi.fn(async ({ url }: { url: string }) => ({ id: 7, url, status: 'complete', active: false, index: 0, windowId: 1, title: '' })),
      get: vi.fn(async (id: number) => ({ id, incognito: false, windowId: 1, url: `${CALLER}/story`, status: 'complete' })),
      query: vi.fn(async () => []),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('readability returns the spec shape', () => {
  it('activeTab.readability() resolves to exactly { url, title, text }', async () => {
    const { routeMessage } = await import('../handlers');
    const res = await routeMessage({ id: 'r1', type: 'agent.browser.activeTab.readability', payload: {}, origin: CALLER, tabId: 3 });
    expect(res).toMatchObject({ ok: true });
    expect((res as { result: unknown }).result).toEqual(EXPECTED);
  });

  it('tab.readability(tabId) resolves to exactly { url, title, text }', async () => {
    const { routeMessage } = await import('../handlers');
    const created = await routeMessage({ id: 'c1', tabId: 3, type: 'agent.browser.tabs.create', payload: { url: `${CALLER}/story` }, origin: CALLER });
    const tabId = (created as { result: { id: number } }).result.id;
    const res = await routeMessage({ id: 'r2', type: 'agent.browser.tab.readability', payload: { tabId }, origin: CALLER });
    expect(res).toMatchObject({ ok: true });
    expect((res as { result: unknown }).result).toEqual(EXPECTED);
  });
});
