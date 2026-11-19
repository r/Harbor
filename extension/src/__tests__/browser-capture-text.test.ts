import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Browser capture (MCP host requests) reads the page with the same extractor
// as the page API, so a capture and a readability() call see the same text.

const mocks = vi.hoisted(() => ({
  executeScriptInTab: vi.fn(),
  tabs: {
    create: vi.fn(),
    get: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
  },
}));

vi.mock('../browser-compat', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  browserAPI: { tabs: mocks.tabs },
  executeScriptInTab: mocks.executeScriptInTab,
}));

const ORIGIN = 'https://news.example';

function runInPage(fn: (...a: unknown[]) => unknown, args: unknown[]) {
  const main = { innerText: '  Title line \n\n body   text ', querySelectorAll: () => [] };
  vi.stubGlobal('window', { location: { origin: ORIGIN, href: `${ORIGIN}/story` } });
  vi.stubGlobal('document', {
    title: 'Story',
    cookie: '',
    body: { innerText: 'whole page', querySelectorAll: () => [] },
    querySelector: (sel: string) => (sel === 'main' ? main : null),
  });
  return fn(...args);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tabs.create.mockResolvedValue({ id: 5, url: `${ORIGIN}/story`, status: 'complete' });
  mocks.tabs.get.mockResolvedValue({ id: 5, url: `${ORIGIN}/story`, status: 'complete' });
  mocks.tabs.remove.mockResolvedValue(undefined);
  mocks.executeScriptInTab.mockImplementation(async (_id: number, fn: (...a: unknown[]) => unknown, args: unknown[] = []) =>
    runInPage(fn, args));
});

afterEach(() => vi.unstubAllGlobals());

describe('runCapturePage', () => {
  it('returns the shared extractor text as content', async () => {
    const { runCapturePage } = await import('../handlers/browser-capture');
    const { extractReadablePage } = await import('../page-api/readable-page');
    const result = await runCapturePage({ url: `${ORIGIN}/story`, waitForLoad: false });
    expect(mocks.executeScriptInTab.mock.calls.some(([, fn]) => fn === extractReadablePage)).toBe(true);
    expect(result).toMatchObject({ content: 'Title line\nbody text', title: 'Story', url: `${ORIGIN}/story` });
  });
});

describe('capture reads one page, even if the tab navigates between in-tab calls', () => {
  /** Each in-tab call sees the next URL in `hrefs` (the last one repeats). */
  function navigatingPage(hrefs: string[]) {
    let call = 0;
    mocks.executeScriptInTab.mockImplementation(async (_id: number, fn: (...a: unknown[]) => unknown, args: unknown[] = []) => {
      const href = hrefs[Math.min(call++, hrefs.length - 1)];
      vi.stubGlobal('window', { location: { origin: new URL(href).origin, href } });
      vi.stubGlobal('document', {
        title: href, cookie: '',
        body: { innerText: `text of ${href}`, querySelectorAll: () => [] },
        querySelector: () => null,
      });
      return fn(...args);
    });
  }

  it('reads again when the page changed after its text was read', async () => {
    navigatingPage([`${ORIGIN}/a`, `${ORIGIN}/b`, `${ORIGIN}/b`, `${ORIGIN}/b`]);
    const { runCapturePage } = await import('../handlers/browser-capture');
    const result = await runCapturePage({ url: `${ORIGIN}/a`, waitForLoad: false });
    expect(result).toMatchObject({ url: `${ORIGIN}/b`, title: `${ORIGIN}/b`, content: `text of ${ORIGIN}/b` });
  });

  it('fails rather than mix two pages when the tab keeps navigating', async () => {
    navigatingPage([`${ORIGIN}/a`, `${ORIGIN}/b`, `${ORIGIN}/c`, `${ORIGIN}/d`]);
    const { runCapturePage } = await import('../handlers/browser-capture');
    await expect(runCapturePage({ url: `${ORIGIN}/a`, waitForLoad: false })).rejects.toThrow('Failed to extract page content');
  });

  it('treats a hash that keeps changing as the same page', async () => {
    navigatingPage([`${ORIGIN}/a#t=1`, `${ORIGIN}/a#t=2`, `${ORIGIN}/a#t=3`]);
    const { runCapturePage } = await import('../handlers/browser-capture');
    const result = await runCapturePage({ url: `${ORIGIN}/a`, waitForLoad: false });
    expect(result).toMatchObject({ url: `${ORIGIN}/a#t=1`, content: `text of ${ORIGIN}/a#t=1` });
  });

  it('login-then-capture fails rather than mix two pages when the tab keeps navigating', async () => {
    const EMAIL = 'me@news.example';
    const hrefs = [`${ORIGIN}/a`, `${ORIGIN}/b`, `${ORIGIN}/c`, `${ORIGIN}/d`];
    let call = 0;
    mocks.executeScriptInTab.mockImplementation(async (_id: number, fn: (...a: unknown[]) => unknown, args: unknown[] = []) => {
      if (args.includes(EMAIL)) return { done: true, hasPassword: true };
      const href = hrefs[Math.min(call++, hrefs.length - 1)];
      vi.stubGlobal('window', { location: { origin: ORIGIN, href } });
      vi.stubGlobal('document', { title: href, body: { innerText: href, querySelectorAll: () => [] }, querySelector: () => null });
      return fn(...args);
    });
    const { runLoginThenCapture } = await import('../handlers/browser-capture');
    await expect(runLoginThenCapture({ loginUrl: `${ORIGIN}/login`, url: `${ORIGIN}/a`, email: EMAIL, password: 'pw' }))
      .rejects.toThrow('Failed to extract page content after login');
  });
});

describe('runLoginThenCapture', () => {
  it('returns the shared extractor text as content after logging in', async () => {
    const EMAIL = 'me@news.example';
    mocks.executeScriptInTab.mockImplementation(async (_id: number, fn: (...a: unknown[]) => unknown, args: unknown[] = []) =>
      // The first in-tab call fills the one-step login form.
      (args.includes(EMAIL) ? { done: true, hasPassword: true } : runInPage(fn, args)));
    const { runLoginThenCapture } = await import('../handlers/browser-capture');
    const { extractReadablePage } = await import('../page-api/readable-page');
    const result = await runLoginThenCapture({
      loginUrl: `${ORIGIN}/login`, url: `${ORIGIN}/story`, email: EMAIL, password: 'pw',
    });
    expect(mocks.executeScriptInTab.mock.calls.some(([, fn]) => fn === extractReadablePage)).toBe(true);
    expect(result).toEqual({
      content: 'Title line\nbody text', title: 'Story', url: `${ORIGIN}/story`, links: [], linksWithText: [],
    });
  });
});
