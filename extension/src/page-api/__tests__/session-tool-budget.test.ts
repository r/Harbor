/**
 * A session created with `limits.maxToolCalls: N` may run N tool calls
 * through `session.callTool()` and no more. The page sends those calls as
 * `agent.tools.call` with the session's id; the budget lives in Harbor's
 * session registry.
 *
 * This drives the real page port, so the calls take the same path a page's
 * do: background.ts's listener, the page handlers, harbor-core's dispatch
 * and the real session registry. Only the MCP host is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';

const host = vi.hoisted(() => ({ callTool: vi.fn() }));

vi.mock('../../llm/chat', () => ({ bridgeChat: vi.fn() }));
vi.mock('../../llm/bridge-client', () => ({
  bridgeRequest: vi.fn(),
  bridgeStreamRequest: vi.fn(),
  getBridgeConnectionState: vi.fn(() => ({ connected: false, bridgeReady: false, error: undefined })),
  checkBridgeHealth: vi.fn(async () => false),
}));
vi.mock('../../mcp/host', () => ({
  listServersWithStatus: vi.fn(async () => []),
  callTool: host.callTool,
  startServer: vi.fn(),
  stopServer: vi.fn(),
  listTools: vi.fn(async () => []),
}));
vi.mock('../../llm/native-bridge', () => ({ isNativeBridgeReady: vi.fn(() => false), rpcRequest: vi.fn() }));
vi.mock('../../llm/provider-registry', () => ({
  listAllProviders: vi.fn(async () => []),
  getRuntimeCapabilities: vi.fn(async () => ({})),
}));

type Listener = (port: unknown) => void;
type Reply = { id?: string; ok: boolean; result?: unknown; error?: { code?: string; message: string } };

const ORIGIN = 'https://a.example';
const TOOL = 'clock/now';
let onConnect: Listener;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  resetMockBrowser();
  host.callTool.mockResolvedValue({ ok: true, result: { content: [{ type: 'text', text: 'noon' }] } });

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
  const { grantPermissions } = await import('../../policy/permissions');
  await grantPermissions(ORIGIN, ['mcp:tools.list', 'mcp:tools.call'], 'granted-always', undefined, [TOOL]);
  initializePageApi();
});

afterEach(() => {
  vi.resetModules();
});

function connectPort(senderUrl: string) {
  const listeners: Array<(m: unknown) => void> = [];
  const posted: Reply[] = [];
  onConnect({
    name: 'harbor-page-api',
    sender: { url: senderUrl, tab: { id: 9 } },
    onMessage: { addListener: (l: (m: unknown) => void) => listeners.push(l) },
    onDisconnect: { addListener: () => {} },
    postMessage: (m: Reply) => posted.push(m),
  });
  let n = 0;
  return async (type: string, payload: unknown): Promise<Reply> => {
    const id = `r${++n}`;
    listeners.forEach(l => l({ id, type, payload }));
    await vi.waitFor(() => expect(posted.some(p => p.id === id)).toBe(true));
    return posted.find(p => p.id === id)!;
  };
}

async function createSession(request: ReturnType<typeof connectPort>, maxToolCalls: number) {
  const created = await request('agent.sessions.create', {
    capabilities: { tools: [TOOL] },
    limits: { maxToolCalls },
  });
  expect(created.ok, created.error?.message).toBe(true);
  return (created.result as { sessionId: string }).sessionId;
}

describe('a session tool budget', () => {
  it('refuses tool call N+1 with ERR_BUDGET_EXCEEDED, without running it', async () => {
    const request = connectPort(`${ORIGIN}/page`);
    const sessionId = await createSession(request, 2);

    for (let i = 0; i < 2; i++) {
      const reply = await request('agent.tools.call', { tool: TOOL, args: {}, sessionId });
      expect(reply.ok, reply.error?.message).toBe(true);
    }
    expect(host.callTool).toHaveBeenCalledTimes(2);

    const third = await request('agent.tools.call', { tool: TOOL, args: {}, sessionId });
    expect(third.ok).toBe(false);
    expect(third.error?.code).toBe('ERR_BUDGET_EXCEEDED');
    expect(host.callTool).toHaveBeenCalledTimes(2);
  });

  it('refuses every call when the budget is 0', async () => {
    const request = connectPort(`${ORIGIN}/page`);
    const sessionId = await createSession(request, 0);

    const reply = await request('agent.tools.call', { tool: TOOL, args: {}, sessionId });
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('ERR_BUDGET_EXCEEDED');
    expect(host.callTool).not.toHaveBeenCalled();
  });

  it('does not limit a session created without maxToolCalls', async () => {
    const request = connectPort(`${ORIGIN}/page`);
    const created = await request('agent.sessions.create', { capabilities: { tools: [TOOL] } });
    const { sessionId } = created.result as { sessionId: string };

    for (let i = 0; i < 7; i++) {
      const reply = await request('agent.tools.call', { tool: TOOL, args: {}, sessionId });
      expect(reply.ok, reply.error?.message).toBe(true);
    }
    expect(host.callTool).toHaveBeenCalledTimes(7);
  });

  it('does not spend the budget on a call the allowlist refuses', async () => {
    const request = connectPort(`${ORIGIN}/page`);
    const sessionId = await createSession(request, 1);

    const refused = await request('agent.tools.call', { tool: 'other/tool', args: {}, sessionId });
    expect(refused.error?.code).toBe('ERR_TOOL_NOT_ALLOWED');

    const allowed = await request('agent.tools.call', { tool: TOOL, args: {}, sessionId });
    expect(allowed.ok, allowed.error?.message).toBe(true);
  });

  it('refuses a call against an unknown session', async () => {
    const request = connectPort(`${ORIGIN}/page`);
    const reply = await request('agent.tools.call', { tool: TOOL, args: {}, sessionId: 'no-such-session' });
    expect(reply.error?.code).toBe('ERR_SESSION_NOT_FOUND');
    expect(host.callTool).not.toHaveBeenCalled();
  });

  it("refuses a call against another origin's session", async () => {
    const owner = connectPort(`${ORIGIN}/page`);
    const sessionId = await createSession(owner, 5);

    const other = connectPort('https://b.example/page');
    const { grantPermissions } = await import('../../policy/permissions');
    await grantPermissions('https://b.example', ['mcp:tools.list', 'mcp:tools.call'], 'granted-always', undefined, [TOOL]);
    const reply = await other('agent.tools.call', { tool: TOOL, args: {}, sessionId });
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('ERR_SESSION_NOT_FOUND');
    expect(host.callTool).not.toHaveBeenCalled();
  });
});
