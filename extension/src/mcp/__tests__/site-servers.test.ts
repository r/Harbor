/**
 * `mcp/site-servers.ts` — the per-tab registry a site's
 * `window.agent.mcp.register()` connects into (gated and origin-checked by
 * `agents/handlers/mcp-website.ts`, which this file doesn't re-test — see
 * `page-api/__tests__/site-mcp-connect.test.ts` and
 * `page-api/__tests__/late-agent-call.test.ts` for the gate itself).
 *
 * Drives `registerSiteServer`/`unregisterSiteServer`/`listSiteTools`/
 * `callSiteTool`/`listSiteServersForAcp`/`forgetTabServers`/
 * `forgetTabServersIfOriginChanged` directly against a fake MCP server
 * (stubbed `fetch`/`EventSource`/`WebSocket` — see
 * `support/fake-mcp-server.ts`), since those are this module's real public
 * surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeMcpServer } from './support/fake-mcp-server';
import {
  callSiteTool,
  forgetTabServers,
  forgetTabServersIfOriginChanged,
  isSiteServerId,
  listSiteServersForAcp,
  listSiteTools,
  registerSiteServer,
  resetSiteMcpServersForTests,
  siteServerId,
  unregisterSiteServer,
} from '../site-servers';

const ORIGIN = 'https://shop.example';
const TAB = 1;

beforeEach(() => {
  resetSiteMcpServersForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSiteMcpServersForTests();
});

describe('siteServerId', () => {
  it('is deterministic: origin + slugified name, independent of call order', () => {
    expect(siteServerId(ORIGIN, 'My Shop Assistant')).toBe('site:shop.example:my-shop-assistant');
    expect(siteServerId(ORIGIN, 'My Shop Assistant')).toBe(siteServerId(ORIGIN, 'My Shop Assistant'));
  });

  it('carries the port when the origin has a non-default one', () => {
    expect(siteServerId('http://localhost:3001', 'Dev')).toBe('site:localhost:3001:dev');
  });
});

describe('registerSiteServer — real tools over each transport', () => {
  it('connects over sse: initialize, notifications/initialized, tools/list — and reports the real tools, not a declared hint', async () => {
    const server = installFakeMcpServer({ tools: [{ name: 'search', description: 'search products' }] });

    const result = await registerSiteServer({
      origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp', name: 'Shop', transport: 'sse',
    });

    expect(result).toMatchObject({ ok: true, tools: ['search'] });
    const methods = server.requests.map((r) => r.body?.method);
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
  });

  it('connects over websocket', async () => {
    const server = installFakeMcpServer({ tools: [{ name: 'add_to_cart' }] });

    const result = await registerSiteServer({
      origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp-ws', name: 'Shop', transport: 'websocket',
    });

    expect(result).toMatchObject({ ok: true, tools: ['add_to_cart'] });
    expect(server.requests.every((r) => r.method === 'WS')).toBe(true);
  });

  it('connects over streamable-http, and carries the Mcp-Session-Id from initialize into later requests', async () => {
    const server = installFakeMcpServer({ tools: [{ name: 'checkout' }] });

    const result = await registerSiteServer({
      origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp-http', name: 'Shop', transport: 'streamable-http',
    });

    expect(result.ok).toBe(true);
    expect(server.sessionId).toBeTruthy();
    const afterInit = server.requests.filter((r) => r.method === 'POST').slice(1);
    expect(afterInit.length).toBeGreaterThan(0);
    for (const req of afterInit) {
      expect(req.headers['mcp-session-id']).toBe(server.sessionId);
    }
  });

  it('refuses stdio with a clear error, before any connection is attempted', async () => {
    installFakeMcpServer();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await registerSiteServer({
      origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp', name: 'Shop', transport: 'stdio',
    });

    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/stdio/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses an unrecognized transport the same way, before any connection', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await registerSiteServer({
      origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp', name: 'Shop', transport: 'carrier-pigeon',
    });

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a failed initialize registers nothing', async () => {
    installFakeMcpServer({ failOn: 'initialize' });

    const result = await registerSiteServer({
      origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp', name: 'Shop', transport: 'sse',
    });

    expect(result.ok).toBe(false);
    expect(listSiteTools(ORIGIN, TAB)).toEqual([]);
  });

  it('a failed tools/list registers nothing, even though initialize succeeded', async () => {
    installFakeMcpServer({ failOn: 'tools/list' });

    const result = await registerSiteServer({
      origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp', name: 'Shop', transport: 'sse',
    });

    expect(result.ok).toBe(false);
    expect(listSiteTools(ORIGIN, TAB)).toEqual([]);
  });

  it('re-registering the same name in the same tab replaces the old connection, not adds a second', async () => {
    installFakeMcpServer({ tools: [{ name: 'v1-tool' }] });
    const first = await registerSiteServer({
      origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp', name: 'Shop', transport: 'sse',
    });
    expect(first.ok).toBe(true);

    installFakeMcpServer({ tools: [{ name: 'v2-tool' }] });
    const second = await registerSiteServer({
      origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp-v2', name: 'Shop', transport: 'sse',
    });
    expect(second.ok).toBe(true);
    expect((first as { serverId: string }).serverId).toBe((second as { serverId: string }).serverId);

    const tools = listSiteTools(ORIGIN, TAB);
    expect(tools.map((t) => t.name)).toEqual(['v2-tool']);
  });

  it('keeps only tools/list entries that are objects with a non-empty string name', async () => {
    installFakeMcpServer({
      // @ts-expect-error -- deliberately malformed, as a hostile or buggy server might send
      tools: [{ name: 'search' }, { name: '' }, { description: 'no name' }, 'not-an-object', null, 42],
    });

    const result = await registerSiteServer({
      origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp', name: 'Shop', transport: 'sse',
    });

    expect(result).toMatchObject({ ok: true, tools: ['search'] });
    expect(listSiteTools(ORIGIN, TAB).map((t) => t.name)).toEqual(['search']);
  });
});

describe('registerSiteServer — abandoned mid-handshake', () => {
  it("disconnects and registers nothing when the tab closes while tools/list is still in flight", async () => {
    const server = installFakeMcpServer({ tools: [{ name: 'search' }], holdResponseTo: 'tools/list' });

    const pending = registerSiteServer({
      origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp', name: 'Shop', transport: 'sse',
    });

    // Let `initialize` and `notifications/initialized` run; `tools/list`
    // is still held, so the handshake hasn't resolved yet.
    await vi.waitFor(() => expect(server.requests.some((r) => r.body?.method === 'tools/list')).toBe(true));

    forgetTabServers(TAB); // the tab closed while the handshake was still running

    server.release();
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(listSiteTools(ORIGIN, TAB)).toEqual([]);
    expect(server.sseConnections[0]?.closed).toBe(true);
  });

  it("disconnects and registers nothing when the tab navigates to a different origin mid-handshake", async () => {
    const server = installFakeMcpServer({ tools: [{ name: 'search' }], holdResponseTo: 'tools/list' });

    const pending = registerSiteServer({
      origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp', name: 'Shop', transport: 'sse',
    });

    await vi.waitFor(() => expect(server.requests.some((r) => r.body?.method === 'tools/list')).toBe(true));

    forgetTabServersIfOriginChanged(TAB, 'https://elsewhere.example/page');

    server.release();
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(listSiteTools(ORIGIN, TAB)).toEqual([]);
    expect(server.sseConnections[0]?.closed).toBe(true);
  });

  it('does not abandon the registration on a same-origin URL change (hash/pushState) mid-handshake', async () => {
    const server = installFakeMcpServer({ tools: [{ name: 'search' }], holdResponseTo: 'tools/list' });

    const pending = registerSiteServer({
      origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp', name: 'Shop', transport: 'sse',
    });

    await vi.waitFor(() => expect(server.requests.some((r) => r.body?.method === 'tools/list')).toBe(true));

    forgetTabServersIfOriginChanged(TAB, `${ORIGIN}/page#section`);

    server.release();
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(listSiteTools(ORIGIN, TAB).map((t) => t.name)).toEqual(['search']);
  });

  it('is abandoned when the caller\'s own signal aborts mid-handshake, even if the tab is still open', async () => {
    const server = installFakeMcpServer({ tools: [{ name: 'search' }], holdResponseTo: 'tools/list' });
    const controller = new AbortController();

    const pending = registerSiteServer({
      origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp', name: 'Shop', transport: 'sse', signal: controller.signal,
    });

    await vi.waitFor(() => expect(server.requests.some((r) => r.body?.method === 'tools/list')).toBe(true));
    controller.abort();

    server.release();
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(listSiteTools(ORIGIN, TAB)).toEqual([]);
  });
});

describe('listSiteTools — scoped to the registering origin and tab', () => {
  beforeEach(async () => {
    installFakeMcpServer({ tools: [{ name: 'search', description: 'd', inputSchema: { type: 'object' } }] });
    const result = await registerSiteServer({
      origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp', name: 'Shop', transport: 'sse',
    });
    expect(result.ok).toBe(true);
  });

  it('is visible to the registering origin and tab', () => {
    expect(listSiteTools(ORIGIN, TAB)).toEqual([
      { serverId: siteServerId(ORIGIN, 'Shop'), name: 'search', description: 'd', inputSchema: { type: 'object' } },
    ]);
  });

  it('is invisible to a different tab', () => {
    expect(listSiteTools(ORIGIN, TAB + 1)).toEqual([]);
  });

  it('is invisible to a different origin in the same tab', () => {
    expect(listSiteTools('https://evil.example', TAB)).toEqual([]);
  });
});

describe('callSiteTool — routes to the right server, fails closed otherwise', () => {
  let serverId: string;

  beforeEach(async () => {
    installFakeMcpServer({
      tools: [{ name: 'search' }],
      onToolCall: (name, args) => ({ echoed: name, args }),
    });
    const result = await registerSiteServer({
      origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp', name: 'Shop', transport: 'sse',
    });
    expect(result.ok).toBe(true);
    serverId = (result as { serverId: string }).serverId;
  });

  it('calls the tool and returns its result', async () => {
    const result = await callSiteTool(ORIGIN, TAB, serverId, 'search', { q: 'shoes' });
    expect(result).toEqual({ ok: true, result: { echoed: 'search', args: { q: 'shoes' } } });
  });

  it('fails as "not found" for the wrong origin', async () => {
    const result = await callSiteTool('https://evil.example', TAB, serverId, 'search', {});
    expect(result.ok).toBe(false);
  });

  it('fails as "not found" for the wrong tab', async () => {
    const result = await callSiteTool(ORIGIN, TAB + 1, serverId, 'search', {});
    expect(result.ok).toBe(false);
  });

  it('fails for a tool the server never reported', async () => {
    const result = await callSiteTool(ORIGIN, TAB, serverId, 'does-not-exist', {});
    expect(result.ok).toBe(false);
  });
});

describe('isSiteServerId', () => {
  it('recognizes the site: prefix and nothing else', () => {
    expect(isSiteServerId('site:shop.example:shop')).toBe(true);
    expect(isSiteServerId('time-wasm')).toBe(false);
  });
});

describe('unregisterSiteServer', () => {
  let serverId: string;

  beforeEach(async () => {
    installFakeMcpServer({ tools: [{ name: 'search' }] });
    const result = await registerSiteServer({
      origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp', name: 'Shop', transport: 'sse',
    });
    serverId = (result as { serverId: string }).serverId;
  });

  it('removes it for the registering origin', async () => {
    const result = await unregisterSiteServer(ORIGIN, TAB, serverId);
    expect(result).toEqual({ ok: true });
    expect(listSiteTools(ORIGIN, TAB)).toEqual([]);
  });

  it("refuses another origin's unregister, and leaves it registered", async () => {
    const result = await unregisterSiteServer('https://evil.example', TAB, serverId);
    expect(result.ok).toBe(false);
    expect(listSiteTools(ORIGIN, TAB)).not.toEqual([]);
  });

  it('reports an unknown serverId as not found', async () => {
    const result = await unregisterSiteServer(ORIGIN, TAB, 'site:shop.example:nope');
    expect(result.ok).toBe(false);
  });
});

describe('per-tab lifetime', () => {
  beforeEach(async () => {
    installFakeMcpServer({ tools: [{ name: 'search' }] });
    await registerSiteServer({ origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp', name: 'Shop', transport: 'sse' });
    await registerSiteServer({ origin: 'https://other.example', tabId: TAB + 1, url: 'https://other.example/mcp', name: 'Other', transport: 'sse' });
  });

  it('forgetTabServers drops only that tab', () => {
    forgetTabServers(TAB);
    expect(listSiteTools(ORIGIN, TAB)).toEqual([]);
    expect(listSiteTools('https://other.example', TAB + 1)).not.toEqual([]);
  });

  it('forgetTabServersIfOriginChanged drops when the tab navigated to a different origin', () => {
    forgetTabServersIfOriginChanged(TAB, 'https://different.example/page');
    expect(listSiteTools(ORIGIN, TAB)).toEqual([]);
  });

  it('forgetTabServersIfOriginChanged is a no-op for a same-origin URL change (hash/pushState)', () => {
    forgetTabServersIfOriginChanged(TAB, `${ORIGIN}/page#section`);
    expect(listSiteTools(ORIGIN, TAB)).not.toEqual([]);
  });
});

describe('listSiteServersForAcp', () => {
  it('reports the origin/tab\'s servers as ACP candidates, by transport', async () => {
    installFakeMcpServer({ tools: [{ name: 'search' }] });
    await registerSiteServer({ origin: ORIGIN, tabId: TAB, url: 'https://shop.example/mcp', name: 'Shop', transport: 'sse' });

    const candidates = listSiteServersForAcp(ORIGIN, TAB);
    expect(candidates).toEqual([
      { serverId: siteServerId(ORIGIN, 'Shop'), name: 'Shop', url: 'https://shop.example/mcp', transport: 'sse' },
    ]);
  });

  it('reports nothing for an origin/tab that registered no servers', () => {
    expect(listSiteServersForAcp(ORIGIN, TAB)).toEqual([]);
  });
});
