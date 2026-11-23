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

describe("the bridge's page-tools endpoint", () => {
  it.each(['page_tools.list', 'page_tools.call'])('%s reaches the page-tools handler only from the bridge endpoint', async (method) => {
    const core = await import('../page-api/harbor-core');
    const spy = vi.spyOn(core, 'handlePageToolsHostRequest').mockResolvedValue({ tools: [] });
    await expect(handleHostRequest({ type: 'host_request', id: '1', method, params: { endpointId: 'pt-1' }, context: { origin: 'harbor-bridge-page-tools' } } as never))
      .resolves.toEqual({ tools: [] });
    expect(spy).toHaveBeenCalledWith(method, { endpointId: 'pt-1' });
    spy.mockClear();
    for (const context of [undefined, {}, { origin: 'harbor-extension' }, { origin: 'https://tale.example' }]) {
      await expect(handleHostRequest({ type: 'host_request', id: '1', method, params: { endpointId: 'pt-1' }, context } as never)).rejects.toThrow();
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('the bridge relaying an outside agent (agent_tabs.request)', () => {
  const req = (context?: { origin?: string }) => ({
    type: 'host_request', id: '1', method: 'agent_tabs.request',
    params: { agentId: 'a1', agentName: 'goose', op: 'list_pages', params: {} }, context,
  }) as never;

  it('is refused unless it comes from the bridge relay', async () => {
    for (const context of [undefined, {}, { origin: 'harbor-extension' }, { origin: 'harbor-bridge-page-tools' }, { origin: 'https://tale.example' }]) {
      await expect(handleHostRequest(req(context))).rejects.toThrow();
    }
  });

  it('answers from the bridge relay, and every op is refused while the setting is off (the default)', async () => {
    const result = await handleHostRequest(req({ origin: 'harbor-bridge-agent-tabs' })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Agents outside the browser/);
  });
});
