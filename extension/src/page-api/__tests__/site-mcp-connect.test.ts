/**
 * A site's own MCP server (`window.agent.mcp.register`) reaches the
 * person's agent only after `mcp.server.register` is granted, connects for
 * real, and its tools are visible/callable only to the origin and tab that
 * registered it — see HBR-134.
 *
 * This drives the real page port, harbor-core's dispatch, the real agent
 * router and the real policy gate, as `listener-origin-and-gate.test.ts`
 * and `late-agent-call.test.ts` do (not the router directly — see
 * docs/agent-workflow.md's "Known pitfalls"). `agent.mcp.register` reaches
 * `agents/handlers/mcp-website.ts` directly; `agent.tools.list`/
 * `agent.tools.call` go through `mcp.listTools`/`mcp.callTool` on
 * `extension-api.ts`. Only the bridge, the person's own installed MCP
 * servers (`mcp/host.ts`) and the prompt window are stubbed — the site's
 * own MCP server is a fake one (stub `fetch`/`EventSource`/`WebSocket`,
 * see `../../mcp/__tests__/support/fake-mcp-server.ts`), not mocked away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';
import { installFakeMcpServer } from '../../mcp/__tests__/support/fake-mcp-server';
import { siteServerId } from '../../mcp/site-servers';

vi.mock('../../llm/chat', () => ({ bridgeChat: vi.fn() }));
vi.mock('../../llm/bridge-client', () => ({
  bridgeRequest: vi.fn(),
  bridgeStreamRequest: vi.fn(),
  getBridgeConnectionState: vi.fn(() => ({ connected: false, bridgeReady: false, error: undefined })),
  checkBridgeHealth: vi.fn(async () => false),
}));
vi.mock('../../mcp/host', () => ({
  listServersWithStatus: vi.fn(async () => []),
  callTool: vi.fn(),
  startServer: vi.fn(),
  stopServer: vi.fn(),
  listTools: vi.fn(async () => []),
}));
vi.mock('../../llm/native-bridge', () => ({ isNativeBridgeReady: vi.fn(() => false), rpcRequest: vi.fn() }));
vi.mock('../../llm/provider-registry', () => ({
  listAllProviders: vi.fn(async () => []),
  getRuntimeCapabilities: vi.fn(async () => ({})),
}));
vi.mock('../../policy/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../policy/permissions')>()),
  showPermissionPrompt: vi.fn(),
}));

type Listener = (port: unknown) => void;
type Reply = { id?: string; ok: boolean; result?: unknown; error?: { code?: string; message: string } };

const SHOP = 'https://shop.example';
const TAB = 1;

let onConnect: Listener;
let tabsOnRemovedListener: ((tabId: number) => void | Promise<void>) | undefined;
let tabsOnUpdatedListener: ((tabId: number, changeInfo: { url?: string }) => void) | undefined;
let showPermissionPrompt: ReturnType<typeof vi.fn>;
let grantPermissions: typeof import('../../policy/permissions').grantPermissions;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  resetMockBrowser();
  installFakeMcpServer({ tools: [{ name: 'search', description: 'search products' }] });

  const chromeGlobal = globalThis as unknown as { chrome: Record<string, unknown> };
  chromeGlobal.chrome.runtime = {
    ...(chromeGlobal.chrome.runtime as Record<string, unknown>),
    onConnect: { addListener: (l: Listener) => { onConnect = l; } },
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  chromeGlobal.chrome.tabs = {
    ...(chromeGlobal.chrome.tabs as Record<string, unknown>),
    onRemoved: { addListener: (l: typeof tabsOnRemovedListener) => { tabsOnRemovedListener = l; } },
    onUpdated: { addListener: (l: typeof tabsOnUpdatedListener) => { tabsOnUpdatedListener = l; } },
    get: vi.fn(async () => { throw new Error('no tab'); }),
  };

  const { initializePageApi } = await import('../background');
  ({ grantPermissions } = await import('../../policy/permissions'));
  showPermissionPrompt = vi.mocked((await import('../../policy/permissions')).showPermissionPrompt);
  // mcp.server.register's own Tier 8 origin-grant check needs the engine's
  // resolver wired to the stored grant (policy/store.ts's
  // initializePolicyStore(), called from the real background entry point,
  // not this test's page-api-only initializePageApi()) — out of scope to
  // wire up here, so register's gate is exercised through the prompt, as
  // late-agent-call.test.ts's 'agent.agents.register' tests already do for
  // the same reason. "Granted" by default; individual tests override this
  // to cover a dismissal.
  showPermissionPrompt.mockResolvedValue({ granted: true, grantType: 'granted-always' });
  initializePageApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function connectPort(senderUrl: string, tabId = TAB) {
  const listeners: Array<(m: unknown) => void> = [];
  const posted: Reply[] = [];
  onConnect({
    name: 'harbor-page-api',
    sender: { url: senderUrl, tab: { id: tabId } },
    onMessage: { addListener: (l: (m: unknown) => void) => listeners.push(l) },
    onDisconnect: { addListener: () => {} },
    postMessage: (m: Reply) => posted.push(m),
  });
  let n = 0;
  const send = (type: string, payload: unknown) => {
    const id = `r${++n}`;
    listeners.forEach((l) => l({ id, type, payload }));
    return id;
  };
  const reply = async (id: string) => {
    await vi.waitFor(() => expect(posted.some((p) => p.id === id)).toBe(true));
    return posted.find((p) => p.id === id)!;
  };
  return { send, reply, request: async (type: string, payload: unknown) => reply(send(type, payload)) };
}

/**
 * Harbor's own origin-grant store for `mcp:tools.list`/`mcp:tools.call`
 * (`page-api/handlers/permission-handlers.ts`'s `hasPermission`/
 * `getPermissions`) — read directly, not through the policy engine, so
 * this works without `initializePolicyStore()`. `mcp.server.register`
 * itself goes through the prompt instead (see the comment in `beforeEach`).
 */
async function grantToolAccess(origin: string, tabId: number, allowedTools: string[]): Promise<void> {
  await grantPermissions(origin, ['mcp:tools.list', 'mcp:tools.call'], 'granted-always', tabId, allowedTools);
}

describe('an omitted transport defaults to streamable HTTP', () => {
  it('connects over streamable HTTP when transport is omitted entirely', async () => {
    const server = installFakeMcpServer({ tools: [{ name: 'search', description: 'search products' }] });
    const page = connectPort(`${SHOP}/page`, TAB);
    const reply = await page.request('agent.mcp.register', { url: `${SHOP}/mcp`, name: 'Shop' });
    expect(reply.ok, reply.error?.message).toBe(true);
    expect(reply.result).toMatchObject({ tools: ['search'] });
    // Streamable HTTP mints a session on initialize and never opens an EventSource.
    expect(server.sseConnections).toHaveLength(0);
    expect(server.sessionId).not.toBeNull();
    expect(server.requests[0]).toMatchObject({ url: `${SHOP}/mcp`, method: 'POST', body: { method: 'initialize' } });
  });

  it('still connects over sse when the page asks for it', async () => {
    const server = installFakeMcpServer({ tools: [{ name: 'search', description: 'search products' }] });
    const page = connectPort(`${SHOP}/page`, TAB);
    const reply = await page.request('agent.mcp.register', { url: `${SHOP}/mcp`, name: 'Shop', transport: 'sse' });
    expect(reply.ok, reply.error?.message).toBe(true);
    expect(server.sseConnections).toHaveLength(1);
    expect(server.sessionId).toBeNull();
  });
});

describe('validation that can fail runs before the permission prompt (and before any connection)', () => {
  it('an unrecognized transport is refused without ever prompting or connecting', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const page = connectPort(`${SHOP}/page`, TAB);
    const reply = await page.request('agent.mcp.register', { url: `${SHOP}/mcp`, name: 'Shop', transport: 'carrier-pigeon' });
    expect(reply.ok).toBe(false);
    expect(showPermissionPrompt).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stdio is refused without ever prompting or connecting', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const page = connectPort(`${SHOP}/page`, TAB);
    const reply = await page.request('agent.mcp.register', { url: `${SHOP}/mcp`, name: 'Shop', transport: 'stdio' });
    expect(reply.ok).toBe(false);
    expect(showPermissionPrompt).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a cross-origin server URL is refused with ERR_PERMISSION_DENIED, without ever prompting or connecting', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const page = connectPort(`${SHOP}/page`, TAB);
    const reply = await page.request('agent.mcp.register', { url: 'https://evil.example/mcp', name: 'Evil', transport: 'sse' });
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('ERR_PERMISSION_DENIED');
    expect(showPermissionPrompt).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a missing url is refused without ever prompting', async () => {
    const page = connectPort(`${SHOP}/page`, TAB);
    const reply = await page.request('agent.mcp.register', { name: 'No URL' });
    expect(reply.ok).toBe(false);
    expect(showPermissionPrompt).not.toHaveBeenCalled();
  });

  it('no tab context is refused without ever prompting', async () => {
    const listeners: Array<(m: unknown) => void> = [];
    const posted: Reply[] = [];
    onConnect({
      name: 'harbor-page-api',
      sender: { url: `${SHOP}/page` }, // no tab
      onMessage: { addListener: (l: (m: unknown) => void) => listeners.push(l) },
      onDisconnect: { addListener: () => {} },
      postMessage: (m: Reply) => posted.push(m),
    });
    listeners.forEach((l) => l({ id: 'r1', type: 'agent.mcp.register', payload: { url: `${SHOP}/mcp`, name: 'Shop', transport: 'sse' } }));
    await vi.waitFor(() => expect(posted.some((p) => p.id === 'r1')).toBe(true));
    expect(posted[0].ok).toBe(false);
    expect(showPermissionPrompt).not.toHaveBeenCalled();
  });
});

describe('D1: a site may register only a same-origin (or matching-loopback) server', () => {
  it('allows a localhost page to register a localhost server on a different port (the BYOC demo shape)', async () => {
    const page = connectPort('http://localhost:8000/page', TAB);
    const reply = await page.request('agent.mcp.register', { url: 'http://localhost:3001/mcp', name: 'Shop', transport: 'sse' });
    expect(reply.ok, reply.error?.message).toBe(true);
  });

  it('allows a localhost page to register a 127.0.0.1 server', async () => {
    const page = connectPort('http://localhost:8000/page', TAB);
    const reply = await page.request('agent.mcp.register', { url: 'http://127.0.0.1:3001/mcp', name: 'Shop', transport: 'sse' });
    expect(reply.ok, reply.error?.message).toBe(true);
  });

  it('denies a localhost server when the registering page itself is not localhost', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const page = connectPort(`${SHOP}/page`, TAB);
    const reply = await page.request('agent.mcp.register', { url: 'http://localhost:3001/mcp', name: 'Shop', transport: 'sse' });
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('ERR_PERMISSION_DENIED');
    expect(showPermissionPrompt).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('records the origin-rule refusal in the audit log, same as every other policy-shaped refusal', async () => {
    const { Audit } = await import('../../policy/audit');
    Audit.clear();

    const page = connectPort(`${SHOP}/page`, TAB);
    const reply = await page.request('agent.mcp.register', { url: 'https://evil.example/mcp', name: 'Shop', transport: 'sse' });
    expect(reply.ok).toBe(false);

    const records = Audit.query({ origin: SHOP, action: 'mcp.server.register', effect: 'deny' });
    expect(records).toHaveLength(1);
    expect(records[0].reason).toMatch(/same origin|loopback/i);
  });

  it('treats a same-origin wss:// URL for websocket as same-origin', async () => {
    const page = connectPort(`${SHOP}/page`, TAB); // https://shop.example
    const reply = await page.request('agent.mcp.register', { url: 'wss://shop.example/mcp-ws', name: 'Shop', transport: 'websocket' });
    expect(reply.ok, reply.error?.message).toBe(true);
  });

  it('denies a ws:// URL whose mapped origin differs from the page origin', async () => {
    const page = connectPort(`${SHOP}/page`, TAB);
    const reply = await page.request('agent.mcp.register', { url: 'ws://evil.example/mcp-ws', name: 'Shop', transport: 'websocket' });
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('ERR_PERMISSION_DENIED');
    expect(showPermissionPrompt).not.toHaveBeenCalled();
  });
});

describe('D3: agent.mcp.register follows the Tool Access feature flag; discover/unregister do not', () => {
  it('is refused with ERR_FEATURE_DISABLED when Tool Access is off, before any gate or connection', async () => {
    const { setFeatureFlags, DEFAULT_FLAGS } = await import('../policy/feature-flags');
    await setFeatureFlags({ ...DEFAULT_FLAGS, toolAccess: false });

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const page = connectPort(`${SHOP}/page`, TAB);
    const reply = await page.request('agent.mcp.register', { url: `${SHOP}/mcp`, name: 'Shop', transport: 'sse' });

    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('ERR_FEATURE_DISABLED');
    expect(showPermissionPrompt).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leaves discover and unregister working when Tool Access is off', async () => {
    const chromeGlobal = globalThis as unknown as { chrome: Record<string, unknown> };
    chromeGlobal.chrome.scripting = { executeScript: vi.fn(async () => [{ result: [] }]) };

    const serverId = siteServerId(SHOP, 'Shop');
    const page = connectPort(`${SHOP}/page`, TAB);
    const registered = await page.request('agent.mcp.register', { url: `${SHOP}/mcp`, name: 'Shop', transport: 'sse' });
    expect(registered.ok, registered.error?.message).toBe(true);

    const { setFeatureFlags, DEFAULT_FLAGS } = await import('../policy/feature-flags');
    await setFeatureFlags({ ...DEFAULT_FLAGS, toolAccess: false });

    const unregistered = await page.request('agent.mcp.unregister', { serverId });
    expect(unregistered.ok, unregistered.error?.message).toBe(true);

    const discovered = await page.request('agent.mcp.discover', {});
    expect(discovered.ok, discovered.error?.message).toBe(true);
  });
});

describe('registering without a grant', () => {
  it('prompts, and a dismissal refuses it without connecting to the server', async () => {
    showPermissionPrompt.mockResolvedValueOnce({ granted: false });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const page = connectPort(`${SHOP}/page`);
    const reply = await page.request('agent.mcp.register', { url: `${SHOP}/mcp`, name: 'Shop', transport: 'sse' });

    expect(showPermissionPrompt).toHaveBeenCalledTimes(1);
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('ERR_PERMISSION_DENIED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('a granted registration connects for real and offers its tools only to the registering origin and tab', () => {
  it('lists the real tools for that origin/tab via agent.tools.list, and the server denies none of the gate', async () => {
    const serverId = siteServerId(SHOP, 'Shop');
    await grantToolAccess(SHOP, TAB, [`${serverId}/search`]);

    const page = connectPort(`${SHOP}/page`, TAB);
    const registered = await page.request('agent.mcp.register', { url: `${SHOP}/mcp`, name: 'Shop', transport: 'sse' });
    expect(registered.ok, registered.error?.message).toBe(true);
    expect(registered.result).toMatchObject({ success: true, serverId, tools: ['search'] });

    const listed = await page.request('agent.tools.list', {});
    expect(listed.ok, listed.error?.message).toBe(true);
    expect(listed.result).toEqual(expect.arrayContaining([
      expect.objectContaining({ serverId, name: 'search' }),
    ]));
  });

  it('calling the tool through agent.tools.call routes to the site server', async () => {
    const serverId = siteServerId(SHOP, 'Shop');
    await grantToolAccess(SHOP, TAB, [`${serverId}/search`]);

    const page = connectPort(`${SHOP}/page`, TAB);
    await page.request('agent.mcp.register', { url: `${SHOP}/mcp`, name: 'Shop', transport: 'sse' });

    const called = await page.request('agent.tools.call', { tool: `${serverId}/search`, args: { q: 'shoes' } });
    expect(called.ok, called.error?.message).toBe(true);
  });

  it("is invisible to a different tab in the same origin", async () => {
    const serverId = siteServerId(SHOP, 'Shop');
    await grantToolAccess(SHOP, TAB, [`${serverId}/search`]);
    await grantToolAccess(SHOP, TAB + 1, [`${serverId}/search`]);

    const registering = connectPort(`${SHOP}/page`, TAB);
    await registering.request('agent.mcp.register', { url: `${SHOP}/mcp`, name: 'Shop', transport: 'sse' });

    const otherTab = connectPort(`${SHOP}/page`, TAB + 1);
    const listed = await otherTab.request('agent.tools.list', {});
    expect(listed.ok).toBe(true);
    expect(listed.result).toEqual([]);
  });

  it('is invisible to a different origin, even in the same tab', async () => {
    const serverId = siteServerId(SHOP, 'Shop');
    await grantToolAccess(SHOP, TAB, [`${serverId}/search`]);
    await grantToolAccess('https://other.example', TAB, [`${serverId}/search`]);

    const registering = connectPort(`${SHOP}/page`, TAB);
    await registering.request('agent.mcp.register', { url: `${SHOP}/mcp`, name: 'Shop', transport: 'sse' });

    const other = connectPort('https://other.example/page', TAB);
    const listed = await other.request('agent.tools.list', {});
    expect(listed.ok).toBe(true);
    expect(listed.result).toEqual([]);
  });
});

describe('per-tab lifetime', () => {
  it('closing the tab drops its registered server', async () => {
    const serverId = siteServerId(SHOP, 'Shop');
    await grantToolAccess(SHOP, TAB, [`${serverId}/search`]);

    const page = connectPort(`${SHOP}/page`, TAB);
    await page.request('agent.mcp.register', { url: `${SHOP}/mcp`, name: 'Shop', transport: 'sse' });

    expect(tabsOnRemovedListener).toBeDefined();
    await tabsOnRemovedListener!(TAB);

    const after = connectPort(`${SHOP}/page`, TAB);
    const listed = await after.request('agent.tools.list', {});
    expect(listed.result).toEqual([]);
  });

  it('navigating the tab to a different origin drops its registered server', async () => {
    const serverId = siteServerId(SHOP, 'Shop');
    await grantToolAccess(SHOP, TAB, [`${serverId}/search`]);

    const page = connectPort(`${SHOP}/page`, TAB);
    await page.request('agent.mcp.register', { url: `${SHOP}/mcp`, name: 'Shop', transport: 'sse' });

    expect(tabsOnUpdatedListener).toBeDefined();
    tabsOnUpdatedListener!(TAB, { url: 'https://elsewhere.example/page' });

    const listed = await page.request('agent.tools.list', {});
    expect(listed.result).toEqual([]);
  });

  it('a same-origin URL change (hash/pushState) does not drop it', async () => {
    const serverId = siteServerId(SHOP, 'Shop');
    await grantToolAccess(SHOP, TAB, [`${serverId}/search`]);

    const page = connectPort(`${SHOP}/page`, TAB);
    await page.request('agent.mcp.register', { url: `${SHOP}/mcp`, name: 'Shop', transport: 'sse' });

    tabsOnUpdatedListener!(TAB, { url: `${SHOP}/page#section` });

    const listed = await page.request('agent.tools.list', {});
    expect(listed.result).not.toEqual([]);
  });
});
