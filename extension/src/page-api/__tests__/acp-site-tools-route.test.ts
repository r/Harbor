/**
 * A site's own registered MCP server tools reach the person's ACP agent
 * through Harbor's own MCP endpoint, never by handing the agent the server's
 * URL (docs/PERMISSIONS.md). They need no grant of their own (not
 * mcp:tools.list or mcp:tools.call) and get a policy check per server, the
 * same gate as the page's own tools.
 *
 * This drives the real port, `agent.mcp.register` (so a real site server is
 * in the registry), the real policy engine, and the real
 * `acp-connection.ts`. Only the ACP bridge (a fake agent), the bridge's
 * page_tools.open/close RPCs, and the permission prompt are stubbed; the
 * site's own MCP server is a fake one (stub fetch/EventSource).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent as buildAgentApp, AGENT_METHODS, type StopReason } from '@agentclientprotocol/sdk';
import { resetMockBrowser } from '../../__tests__/test-setup';
import { createFakeAcpBridge } from './support/fake-acp-bridge';
import { installFakeMcpServer } from '../../mcp/__tests__/support/fake-mcp-server';
import { resetSiteMcpServersForTests, siteServerId } from '../../mcp/site-servers';

const mocks = vi.hoisted(() => ({
  bridge: { current: null as null | ReturnType<typeof import('./support/fake-acp-bridge').createFakeAcpBridge> },
  rpcRequest: vi.fn(),
}));
vi.mock('../../llm/native-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../llm/native-bridge')>()),
  rpcRequest: mocks.rpcRequest,
}));

vi.mock('../harbor-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harbor-core')>()),
  acpOpenStream: (agentId: string, workspace: string) => mocks.bridge.current!.acpOpenStream(agentId, workspace),
  acpSend: (channel: string, message: unknown) => mocks.bridge.current!.acpSend(channel, message),
  acpClose: (channel: string) => mocks.bridge.current!.acpClose(channel),
}));
vi.mock('../../policy/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../policy/permissions')>()),
  showPermissionPrompt: vi.fn(async () => ({ granted: true, grantType: 'granted-always' })),
}));

const ORIGIN = 'https://shop.example';
const TAB = 9;
const AGENT_ID = 'test-agent';

type Listener = (port: unknown) => void;
let onConnect: Listener;

beforeEach(async () => {
  resetMockBrowser();
  installFakeMcpServer({ tools: [{ name: 'search' }] });
  mocks.bridge.current = createFakeAcpBridge();
  mocks.rpcRequest.mockReset();
  mocks.rpcRequest.mockImplementation(async (method: string) => {
    if (method === 'page_tools.open') return { endpointId: 'pt-1-abc', url: 'http://127.0.0.1:4555/mcp/abcdefghijklmnop' };
    if (method === 'page_tools.close') return { closed: true };
    throw new Error(`unexpected ${method}`);
  });

  const chromeGlobal = globalThis as unknown as { chrome: Record<string, unknown> };
  chromeGlobal.chrome.runtime = {
    ...(chromeGlobal.chrome.runtime as Record<string, unknown>),
    onConnect: { addListener: (l: Listener) => { onConnect = l; } },
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  chromeGlobal.chrome.tabs = {
    ...(chromeGlobal.chrome.tabs as Record<string, unknown>),
    onRemoved: { addListener: vi.fn() },
    get: vi.fn(async () => { throw new Error('no tab'); }),
  };

  const { initializePageApi } = await import('../background');
  initializePageApi();
  await chrome.storage.local.set({ harbor_agent_backend: { type: 'acp', agentId: AGENT_ID } });

  // background.ts's handleAgentRun checks these before the run starts at
  // all — granted for every test here, since this file is about the
  // tool-grant/policy gate specifically, not this pre-existing check.
  const { grantPermissions } = await import('../../policy/permissions');
  await grantPermissions(ORIGIN, ['model:prompt', 'model:tools'], 'granted-always', TAB);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const { Policy } = await import('../../policy/store');
  Policy.__reset();
  const { Audit } = await import('../../policy/audit');
  Audit.clear();
  // site-servers.ts isn't mocked in this file, so its registry is one
  // real module shared across every test here (no vi.resetModules()) —
  // without this, a server a prior test registered under the same tabId
  // lingers and shows up in a later test's own mcpServers.
  resetSiteMcpServersForTests();
});

type Posted = { id?: string; ok?: boolean; result?: unknown; error?: { message?: string }; event?: { type: string }; done?: boolean };

function connectPort(senderUrl: string, tabId = TAB) {
  const listeners: Array<(m: unknown) => void> = [];
  const posted: Posted[] = [];
  onConnect({
    name: 'harbor-page-api',
    sender: { url: senderUrl, tab: { id: tabId } },
    onMessage: { addListener: (l: (m: unknown) => void) => listeners.push(l) },
    onDisconnect: { addListener: () => {} },
    postMessage: (m: Posted) => posted.push(m),
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
  const waitForRun = async (id: string) => {
    await vi.waitFor(() => expect(posted.some((p) => p.id === id && p.done)).toBe(true));
  };
  return { send, reply, waitForRun };
}

async function registerSiteServer(port: ReturnType<typeof connectPort>, name = 'Shop'): Promise<string> {
  const reply = await port.reply(port.send('agent.mcp.register', { url: `${ORIGIN}/mcp`, name, transport: 'sse' }));
  if (!reply.ok) throw new Error(`registration failed: ${JSON.stringify(reply)}`);
  return siteServerId(ORIGIN, name);
}

async function grantToolAccess(granted: { list?: boolean; call?: boolean } = { list: true, call: true }): Promise<void> {
  const { grantPermissions } = await import('../../policy/permissions');
  if (granted.list) await grantPermissions(ORIGIN, ['mcp:tools.list'], 'granted-always', TAB);
  if (granted.call) await grantPermissions(ORIGIN, ['mcp:tools.call'], 'granted-always', TAB);
}

async function loadRules(rules: Array<Record<string, unknown>>): Promise<void> {
  const { Policy } = await import('../../policy/store');
  const { compileRule } = await import('../../policy/rules');
  Policy.__setForTesting(rules.map((r) => compileRule({ source: 'user', ...r } as never)));
}

function registerFakeAgent(onSessionNew: (params: unknown) => void): void {
  const app = buildAgentApp({ name: 'fake-agent' })
    // Declares sse support so a passed-through site server (registered
    // over sse below) isn't itself filtered out by capability — this
    // file is about the grant/policy gate in front of that, not the
    // capability filter acp-connection.test.ts-equivalent coverage
    // already has in acp-backend.test.ts.
    .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { sse: true, http: true } } }))
    .onRequest(AGENT_METHODS.session_new, async (ctx) => { onSessionNew(ctx.params); return { sessionId: 'sess-1' }; })
    .onRequest(AGENT_METHODS.session_prompt, async (): Promise<{ stopReason: StopReason }> => ({ stopReason: 'end_turn' }));
  mocks.bridge.current!.registerAgent(AGENT_ID, app, {});
}

const HARBOR_ENDPOINT = { type: 'http', name: 'shop.example', url: 'http://127.0.0.1:4555/mcp/abcdefghijklmnop', headers: [] };

describe("a site's registered MCP servers reaching the person's ACP agent", () => {
  it("go through Harbor's endpoint with no MCP grants, and the site's URL is never passed", async () => {
    const port = connectPort(`${ORIGIN}/page`);
    await registerSiteServer(port);
    let sessionNewParams: unknown;
    registerFakeAgent((params) => { sessionNewParams = params; });
    const id = port.send('agent.run', { task: 'find headphones' });
    await port.waitForRun(id);
    const servers = (sessionNewParams as { mcpServers: Array<{ url: string }> }).mcpServers;
    expect(servers).toEqual([HARBOR_ENDPOINT]);
    expect(JSON.stringify(sessionNewParams)).not.toContain(`${ORIGIN}/mcp`);
  });

  it('are still routed through Harbor when the origin holds the MCP grants', async () => {
    const port = connectPort(`${ORIGIN}/page`);
    await registerSiteServer(port);
    await grantToolAccess({ list: true, call: true });
    let sessionNewParams: unknown;
    registerFakeAgent((params) => { sessionNewParams = params; });
    const id = port.send('agent.run', { task: 'find headphones' });
    await port.waitForRun(id);
    expect((sessionNewParams as { mcpServers: unknown[] }).mcpServers).toEqual([HARBOR_ENDPOINT]);
  });

  it('are left out when a policy rule refuses tool.list for site:*', async () => {
    const port = connectPort(`${ORIGIN}/page`);
    await registerSiteServer(port);
    await loadRules([{ id: 'no-sites', effect: 'deny', principal: { origin: '*' }, action: 'tool.list', resource: { server: 'site:*' } }]);
    let sessionNewParams: unknown;
    registerFakeAgent((params) => { sessionNewParams = params; });
    const id = port.send('agent.run', { task: 'find headphones' });
    await port.waitForRun(id);
    expect((sessionNewParams as { mcpServers: unknown[] }).mcpServers).toEqual([]);
    expect(mocks.rpcRequest).not.toHaveBeenCalledWith('page_tools.open', expect.anything());
  });
});

describe("a site's page chat on the person's ACP agent", () => {
  it("gets the site's registered servers through Harbor's endpoint too", async () => {
    const port = connectPort(`${ORIGIN}/page`);
    await registerSiteServer(port);
    let sessionNewParams: unknown;
    registerFakeAgent((params) => { sessionNewParams = params; });
    const { AcpTextSession } = await import('../acp-text-session');
    const session = new AcpTextSession(AGENT_ID, ORIGIN, TAB, undefined, 'page-chat');
    await session.open();
    expect((sessionNewParams as { mcpServers: unknown[] }).mcpServers).toEqual([HARBOR_ENDPOINT]);
    await session.destroy();
  });
});
