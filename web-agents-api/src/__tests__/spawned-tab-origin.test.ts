import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A site may only read a tab it opened while that tab is on the site's own
// origin, and the background must refuse browser-control requests when the
// browserControl flag is off.

const mocks = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  executeScriptInTab: vi.fn(),
  getFeatureFlags: vi.fn(),
}));

vi.mock('../handlers/permission-handlers', async (importOriginal) => ({
  ...(await importOriginal<object>()), hasPermission: mocks.hasPermission,
}));
vi.mock('../handlers/browser-compat', async (importOriginal) => ({
  ...(await importOriginal<object>()), executeScriptInTab: mocks.executeScriptInTab,
}));
vi.mock('../policy/feature-flags', () => ({ getFeatureFlags: mocks.getFeatureFlags }));

const CALLER = 'https://news.example';
let tabUrls: Map<number, string>;
let nextTabId: number;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  tabUrls = new Map();
  nextTabId = 100;
  mocks.hasPermission.mockResolvedValue(true);
  mocks.getFeatureFlags.mockResolvedValue({ browserControl: true });
  vi.stubGlobal('chrome', {
    storage: { local: { set: vi.fn(async () => {}), get: vi.fn(async () => ({})) } },
    tabs: {
      create: vi.fn(async ({ url }: { url: string }) => {
        const id = nextTabId++;
        tabUrls.set(id, url);
        return { id, url, status: 'complete', active: false, index: 0, windowId: 1, title: '' };
      }),
      get: vi.fn(async (id: number) => ({ id, url: tabUrls.get(id), status: 'complete' })),
      query: vi.fn(async () => [...tabUrls].map(([id, url]) => ({ id, url }))),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

/** Run an injected page function as if it executed in a page on `origin`. */
function runInjected(fn: (...a: unknown[]) => unknown, args: unknown[], origin: string) {
  const body = { textContent: 'secret', innerHTML: '<p>secret</p>', outerHTML: '<body>secret</body>' };
  vi.stubGlobal('window', { location: { origin, href: `${origin}/` } });
  vi.stubGlobal('document', { title: 't', body, cookie: 'sid=secret', querySelector: () => null });
  return fn(...args);
}

function ctx(type: string, payload: unknown) {
  return { id: 'r1', type, payload, origin: CALLER };
}

describe('spawned tab reads are limited to the caller origin', () => {
  for (const type of ['agent.browser.tab.getHtml', 'agent.browser.tab.readability']) {
    it(`${type} refuses a spawned tab on another origin`, async () => {
      const { routeMessage } = await import('../handlers');
      const created = await routeMessage(ctx('agent.browser.tabs.create', { url: 'https://bank.example/' }));
      expect(created.ok).toBe(true);
      const tabId = (created as { result: { id: number } }).result.id;

      const res = await routeMessage(ctx(type, { tabId }));
      expect(res.ok).toBe(false);
      expect(mocks.executeScriptInTab).not.toHaveBeenCalled();
    });

    it(`${type} allows a spawned tab on the caller origin`, async () => {
      mocks.executeScriptInTab.mockResolvedValue({ html: '', url: '', title: '', content: '', text: '', length: 0 });
      const { routeMessage } = await import('../handlers');
      const created = await routeMessage(ctx('agent.browser.tabs.create', { url: `${CALLER}/page` }));
      const tabId = (created as { result: { id: number } }).result.id;

      const res = await routeMessage(ctx(type, { tabId }));
      expect(res.ok).toBe(true);
    });

    it(`${type} returns nothing if the tab is on another origin when the script runs`, async () => {
      // The tab can navigate between the pre-check and script execution.
      let pageResult: unknown;
      mocks.executeScriptInTab.mockImplementation(async (_id: number, fn: (...a: unknown[]) => unknown, args: unknown[]) => {
        pageResult = runInjected(fn, args, 'https://bank.example');
        return pageResult;
      });
      const { routeMessage } = await import('../handlers');
      const created = await routeMessage(ctx('agent.browser.tabs.create', { url: `${CALLER}/page` }));
      const tabId = (created as { result: { id: number } }).result.id;

      const res = await routeMessage(ctx(type, { tabId }));
      expect(JSON.stringify(pageResult ?? null)).not.toContain('secret');
      expect(res.ok).toBe(false);
    });
  }
});

describe('reading on the caller origin runs the real page script', () => {
  for (const type of ['agent.browser.tab.getHtml', 'agent.browser.tab.readability']) {
    it(`${type} returns content when the tab is on the caller origin`, async () => {
      mocks.executeScriptInTab.mockImplementation(async (_id: number, fn: (...a: unknown[]) => unknown, args: unknown[]) =>
        runInjected(fn, args, CALLER));
      const { routeMessage } = await import('../handlers');
      const created = await routeMessage(ctx('agent.browser.tabs.create', { url: `${CALLER}/page` }));
      const tabId = (created as { result: { id: number } }).result.id;
      const res = await routeMessage(ctx(type, { tabId }));
      expect(res.ok).toBe(true);
      expect(JSON.stringify(res)).toContain('secret');
    });
  }
});

describe('opening tabs', () => {
  it('refuses non-http(s) URLs', async () => {
    const { routeMessage } = await import('../handlers');
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'about:config']) {
      const res = await routeMessage(ctx('agent.browser.tabs.create', { url }));
      expect(res.ok).toBe(false);
    }
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('reports canControl by the requested origin, even if the new tab is still about:blank', async () => {
    (chrome.tabs.create as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      ({ id: 5, url: 'about:blank', status: 'loading', active: false, index: 0, windowId: 1, title: '' }));
    const { routeMessage } = await import('../handlers');
    const own = await routeMessage(ctx('agent.browser.tabs.create', { url: `${CALLER}/a` }));
    const other = await routeMessage(ctx('agent.browser.tabs.create', { url: 'https://bank.example/' }));
    expect((own as { result: { canControl: boolean } }).result.canControl).toBe(true);
    expect((other as { result: { canControl: boolean } }).result.canControl).toBe(false);
  });
});

describe('the background enforces the browserControl flag', () => {
  for (const [type, payload] of [
    ['agent.browser.tabs.create', { url: `${CALLER}/` }],
    ['agent.browser.tabs.list', {}],
    ['agent.browser.tabs.close', { tabId: 1 }],
    ['agent.browser.tab.getHtml', { tabId: 1 }],
    ['agent.browser.tab.readability', { tabId: 1 }],
    ['agent.browser.tab.waitForLoad', { tabId: 1 }],
    ['agent.browser.navigate', { url: `${CALLER}/` }],
    ['agent.browser.fetch', { url: `${CALLER}/` }],
  ] as const) {
    it(`${type} is refused when browserControl is off`, async () => {
      mocks.getFeatureFlags.mockResolvedValue({ browserControl: false });
      const { routeMessage } = await import('../handlers');
      const res = await routeMessage(ctx(type, payload));
      expect(res.ok).toBe(false);
      expect((res as { error: { code: string } }).error.code).toBe('ERR_FEATURE_DISABLED');
      expect(chrome.tabs.create).not.toHaveBeenCalled();
    });
  }
});

describe('host capture requested on behalf of a page is limited to its origin', () => {
  it('capturePage refuses another origin without opening a tab', async () => {
    const { handleHostRun } = await import('../handlers/host-run-handlers');
    const res = await handleHostRun({
      method: 'browser.capturePage',
      params: { url: 'https://bank.example/', captureCookies: true },
      context: { origin: CALLER },
    });
    expect(res.ok).toBe(false);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('capturePage returns nothing if the page ends up on another origin', async () => {
    let pageResult: unknown;
    mocks.executeScriptInTab.mockImplementation(async (_id: number, fn: (...a: unknown[]) => unknown, args: unknown[]) => {
      pageResult = runInjected(fn, args, 'https://bank.example');
      return pageResult;
    });
    const { handleHostRun } = await import('../handlers/host-run-handlers');
    const res = await handleHostRun({
      method: 'browser.capturePage',
      params: { url: `${CALLER}/redirects-away`, captureCookies: true },
      context: { origin: CALLER },
    });
    expect(JSON.stringify(pageResult ?? null)).not.toContain('secret');
    expect(res.ok).toBe(false);
  });

  it('capturePage still works on the caller origin', async () => {
    mocks.executeScriptInTab.mockImplementation(async (_id: number, fn: (...a: unknown[]) => unknown, args: unknown[]) => runInjected(fn, args, CALLER));
    const { handleHostRun } = await import('../handlers/host-run-handlers');
    const res = await handleHostRun({
      method: 'browser.capturePage',
      params: { url: `${CALLER}/article` },
      context: { origin: CALLER },
    });
    expect(res.ok).toBe(true);
  });

  it('getCookies refuses an already-open tab on another origin', async () => {
    tabUrls.set(7, 'https://bank.example/account');
    mocks.executeScriptInTab.mockImplementation(async (_id: number, fn: (...a: unknown[]) => unknown, args: unknown[]) => runInjected(fn, args, 'https://bank.example'));
    const { handleHostRun } = await import('../handlers/host-run-handlers');
    const res = await handleHostRun({
      method: 'browser.getCookies',
      params: { domain: 'bank.example' },
      context: { origin: CALLER },
    });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain('secret');
  });

  it('getCookies refuses to open another origin', async () => {
    const { handleHostRun } = await import('../handlers/host-run-handlers');
    const res = await handleHostRun({
      method: 'browser.getCookies',
      params: { domain: 'bank.example', openUrl: 'https://bank.example/' },
      context: { origin: CALLER },
    });
    expect(res.ok).toBe(false);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('the Harbor sidebar can still capture any site', async () => {
    mocks.executeScriptInTab.mockImplementation(async (_id: number, fn: (...a: unknown[]) => unknown, args: unknown[]) => runInjected(fn, args, 'https://bank.example'));
    const { handleHostRun } = await import('../handlers/host-run-handlers');
    const res = await handleHostRun({
      method: 'browser.capturePage',
      params: { url: 'https://bank.example/' },
      context: { origin: 'harbor-extension' },
    });
    expect(res.ok).toBe(true);
  });
});
