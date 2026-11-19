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
