/**
 * The calling page's own tools reaching the person's ACP agent: agent.run and
 * a page chat open a bridge-hosted MCP endpoint for the tab and pass it to
 * `session/new` as `page:<host>`, then close it when they end. A
 * `window.ai` text session stays tool-less. Runs against the real ACP SDK
 * (fake bridge), the real policy engine and the real page-tool registry; only
 * the bridge's `page_tools.open`/`close` RPCs are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent as buildAgentApp, AGENT_METHODS, type StopReason } from '@agentclientprotocol/sdk';
import { resetMockBrowser } from '../../__tests__/test-setup';
import { createFakeAcpBridge } from './support/fake-acp-bridge';

const mocks = vi.hoisted(() => ({
  bridge: { current: null as null | ReturnType<typeof import('./support/fake-acp-bridge').createFakeAcpBridge> },
  rpcRequest: vi.fn(),
}));

vi.mock('../harbor-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harbor-core')>()),
  acpOpenStream: (agentId: string, workspace: string) => mocks.bridge.current!.acpOpenStream(agentId, workspace),
  acpSend: (channel: string, message: unknown) => mocks.bridge.current!.acpSend(channel, message),
  acpClose: (channel: string) => mocks.bridge.current!.acpClose(channel),
}));
vi.mock('../../llm/native-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../llm/native-bridge')>()),
  rpcRequest: mocks.rpcRequest,
}));

const ORIGIN = 'https://tale.example';
const TAB = 9;
const AGENT_ID = 'test-agent';
const ENDPOINT_URL = 'http://127.0.0.1:4555/mcp/abcdefghijklmnop';

type Listener = (port: unknown) => void;
let onConnect: Listener;
let registry: typeof import('../../mcp/page-tools');

beforeEach(async () => {
  resetMockBrowser();
  mocks.bridge.current = createFakeAcpBridge();
  mocks.rpcRequest.mockReset();
  mocks.rpcRequest.mockImplementation(async (method: string) => {
    if (method === 'page_tools.open') return { endpointId: 'pt-1-xyz', url: ENDPOINT_URL };
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
  registry = await import('../../mcp/page-tools');
  registry.__resetPageToolsForTests();
  (await import('../harbor-core')).__resetPageToolEndpointsForTests();
  await chrome.storage.local.set({ harbor_agent_backend: { type: 'acp', agentId: AGENT_ID } });
  const { grantPermissions } = await import('../../policy/permissions');
  await grantPermissions(ORIGIN, ['model:prompt', 'model:tools'], 'granted-always', TAB);
});

afterEach(async () => {
  const { Policy } = await import('../../policy/store');
  Policy.__reset();
});

function connectPort() {
  const listeners: Array<(m: unknown) => void> = [];
  const posted: Array<{ id?: string; done?: boolean; ok?: boolean }> = [];
  onConnect({
    name: 'harbor-page-api',
    sender: { url: `${ORIGIN}/book`, tab: { id: TAB }, frameId: 0 },
    onMessage: { addListener: (l: (m: unknown) => void) => listeners.push(l) },
    onDisconnect: { addListener: () => {} },
    postMessage: (m: { id?: string; done?: boolean }) => posted.push(m),
  });
  let n = 0;
  const send = (type: string, payload: unknown) => {
    const id = `r${++n}`;
    listeners.forEach((l) => l({ id, type, payload }));
    return id;
  };
  const waitForRun = async (id: string) => {
    await vi.waitFor(() => expect(posted.some((p) => p.id === id && p.done)).toBe(true));
  };
  const reply = async (id: string) => {
    await vi.waitFor(() => expect(posted.some((p) => p.id === id)).toBe(true));
    return posted.find((p) => p.id === id)!;
  };
  return { send, waitForRun, reply };
}

function registerFakeAgent(onSessionNew: (params: unknown) => void, mcpCapabilities: Record<string, boolean> = { http: true, sse: true }): void {
  const app = buildAgentApp({ name: 'fake-agent' })
    .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1, agentCapabilities: { mcpCapabilities } }))
    .onRequest(AGENT_METHODS.session_new, async (ctx) => { onSessionNew(ctx.params); return { sessionId: 'sess-1' }; })
    .onRequest(AGENT_METHODS.session_prompt, async (): Promise<{ stopReason: StopReason }> => ({ stopReason: 'end_turn' }));
  mocks.bridge.current!.registerAgent(AGENT_ID, app, {});
}

async function syncTools(port: ReturnType<typeof connectPort>) {
  const reply = await port.reply(port.send('page_tools.sync', { tools: [{ name: 'go_to', description: 'Scroll to an anchor' }] }));
  expect(reply.ok).toBe(true);
}

const mcpServersOf = (params: unknown) => (params as { mcpServers: Array<{ type: string; name: string; url: string }> }).mcpServers;

describe("agent.run on the person's ACP agent", () => {
  it("gets the page's tools as page:<host>, with no MCP grants, and closes the endpoint after", async () => {
    const port = connectPort();
    await syncTools(port);
    let sessionNew: unknown;
    registerFakeAgent((p) => { sessionNew = p; });

    const id = port.send('agent.run', { task: 'Take me to p3' });
    await port.waitForRun(id);

    expect(mcpServersOf(sessionNew)).toEqual([{ type: 'http', name: 'page:tale.example', url: ENDPOINT_URL, headers: [] }]);
    await vi.waitFor(() => expect(mocks.rpcRequest).toHaveBeenCalledWith('page_tools.close', { endpointId: 'pt-1-xyz' }));
  });

  it('opens no endpoint for a page with no tools', async () => {
    const port = connectPort();
    let sessionNew: unknown;
    registerFakeAgent((p) => { sessionNew = p; });
    const id = port.send('agent.run', { task: 'Hello' });
    await port.waitForRun(id);
    expect(mcpServersOf(sessionNew)).toEqual([]);
    expect(mocks.rpcRequest).not.toHaveBeenCalledWith('page_tools.open', expect.anything());
  });

  it("leaves it out for an agent without HTTP MCP, and still closes the endpoint", async () => {
    const port = connectPort();
    await syncTools(port);
    let sessionNew: unknown;
    registerFakeAgent((p) => { sessionNew = p; }, { sse: true });
    const id = port.send('agent.run', { task: 'Take me to p3' });
    await port.waitForRun(id);
    expect(mcpServersOf(sessionNew)).toEqual([]);
    await vi.waitFor(() => expect(mocks.rpcRequest).toHaveBeenCalledWith('page_tools.close', { endpointId: 'pt-1-xyz' }));
  });
});

describe('ACP text sessions', () => {
  it("a page chat's session gets the page's tools, and closes the endpoint when destroyed", async () => {
    const port = connectPort();
    await syncTools(port);
    let sessionNew: unknown;
    registerFakeAgent((p) => { sessionNew = p; });
    const { AcpTextSession } = await import('../acp-text-session');
    const session = new AcpTextSession(AGENT_ID, ORIGIN, TAB, undefined, 'page-chat');
    await session.open();
    expect(mcpServersOf(sessionNew)).toEqual([{ type: 'http', name: 'page:tale.example', url: ENDPOINT_URL, headers: [] }]);
    await session.destroy();
    expect(mocks.rpcRequest).toHaveBeenCalledWith('page_tools.close', { endpointId: 'pt-1-xyz' });
  });

  it('a window.ai text session stays tool-less', async () => {
    const port = connectPort();
    await syncTools(port);
    let sessionNew: unknown;
    registerFakeAgent((p) => { sessionNew = p; });
    const { AcpTextSession } = await import('../acp-text-session');
    const session = new AcpTextSession(AGENT_ID, ORIGIN, TAB, undefined, 'website');
    await session.open();
    expect(mcpServersOf(sessionNew)).toEqual([]);
    expect(mocks.rpcRequest).not.toHaveBeenCalledWith('page_tools.open', expect.anything());
    await session.destroy();
  });
});
