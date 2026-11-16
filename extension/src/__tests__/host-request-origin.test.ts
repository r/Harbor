import { beforeEach, describe, expect, it, vi } from 'vitest';

// Browser capture opens tabs with the user's login, so only the Harbor
// sidebar may ask for it. A tool call with no origin must not count as the
// sidebar.

const capture = vi.hoisted(() => ({
  runCapturePage: vi.fn(async () => ({ content: 'secret' })),
  runGetCookies: vi.fn(async () => ({ cookies: 'sid=secret' })),
  runLoginThenCapture: vi.fn(async () => ({ content: 'secret' })),
  runEnsureLogin: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../handlers/browser-capture', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...capture,
}));

import { handleHostRequest } from '../handlers/host-request-handlers';

const METHODS = ['browser.capturePage', 'browser.getCookies', 'browser.loginThenCapture', 'browser.ensureLogin'];

function request(method: string, context?: { origin?: string }) {
  return { type: 'host_request', id: '1', method, params: { url: 'https://bank.example/' }, context } as never;
}

beforeEach(() => vi.clearAllMocks());

describe('Harbor browser capture', () => {
  for (const method of METHODS) {
    it(`${method} is refused when the tool call has no origin`, async () => {
      await expect(handleHostRequest(request(method))).rejects.toThrow();
      await expect(handleHostRequest(request(method, {}))).rejects.toThrow();
      for (const fn of Object.values(capture)) expect(fn).not.toHaveBeenCalled();
    });

    it(`${method} is refused for a page origin`, async () => {
      await expect(handleHostRequest(request(method, { origin: 'https://news.example' }))).rejects.toThrow();
      for (const fn of Object.values(capture)) expect(fn).not.toHaveBeenCalled();
    });

    it(`${method} is allowed from the Harbor sidebar`, async () => {
      await expect(handleHostRequest(request(method, { origin: 'harbor-extension' }))).resolves.toBeDefined();
    });
  }

  it('http.get stays available to tools without an origin, and sends no cookies', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(handleHostRequest({
      type: 'host_request', id: '2', method: 'http.get', params: { url: 'https://api.example/' },
    } as never)).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledWith('https://api.example/', expect.objectContaining({ credentials: 'omit' }));
    vi.unstubAllGlobals();
  });
});
