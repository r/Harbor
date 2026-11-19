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
vi.mock('../../policy/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../policy/permissions')>()),
  showPermissionPrompt: vi.fn(),
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

afterEach(async () => {
  const { Policy } = await import('../../policy/store');
  Policy.__reset();
  vi.resetModules();
});

/** Load policy rules into the same module instance the background uses. */
async function loadRules(rules: Array<Record<string, unknown>>) {
  const { Policy } = await import('../../policy/store');
  const { compileRule } = await import('../../policy/rules');
  Policy.__setForTesting(rules.map(r => compileRule({ source: 'user', ...r } as never)));
}

async function clearRules() {
  const { Policy } = await import('../../policy/store');
  Policy.__reset();
}

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

  it('does not spend the budget on a call a policy deny rule refuses', async () => {
    const request = connectPort(`${ORIGIN}/page`);
    const sessionId = await createSession(request, 1);

    await loadRules([{ id: 'no-tools', effect: 'deny', principal: { origin: '*' }, action: 'tool.call' }]);
    const refused = await request('agent.tools.call', { tool: TOOL, args: {}, sessionId });
    expect(refused.ok).toBe(false);
    expect(host.callTool).not.toHaveBeenCalled();

    await clearRules();
    const allowed = await request('agent.tools.call', { tool: TOOL, args: {}, sessionId });
    expect(allowed.ok, allowed.error?.message).toBe(true);
    expect(host.callTool).toHaveBeenCalledTimes(1);
  });

  it('does not spend the budget on a call whose prompt the person declines', async () => {
    const { showPermissionPrompt } = await import('../../policy/permissions');
    const request = connectPort(`${ORIGIN}/page`);
    const sessionId = await createSession(request, 1);

    await loadRules([{ id: 'ask-tools', effect: 'ask', principal: { origin: '*' }, action: 'tool.call' }]);
    vi.mocked(showPermissionPrompt).mockResolvedValueOnce({ granted: false } as never);
    const refused = await request('agent.tools.call', { tool: TOOL, args: {}, sessionId });
    expect(refused.ok).toBe(false);
    expect(showPermissionPrompt).toHaveBeenCalledTimes(1);
    expect(host.callTool).not.toHaveBeenCalled();

    await clearRules();
    const allowed = await request('agent.tools.call', { tool: TOOL, args: {}, sessionId });
    expect(allowed.ok, allowed.error?.message).toBe(true);
    expect(host.callTool).toHaveBeenCalledTimes(1);
  });

  it('does not prompt for a call the spent budget already refuses', async () => {
    const { showPermissionPrompt } = await import('../../policy/permissions');
    const request = connectPort(`${ORIGIN}/page`);
    const sessionId = await createSession(request, 0);

    await loadRules([{ id: 'ask-tools', effect: 'ask', principal: { origin: '*' }, action: 'tool.call' }]);
    const reply = await request('agent.tools.call', { tool: TOOL, args: {}, sessionId });
    expect(reply.error?.code).toBe('ERR_BUDGET_EXCEEDED');
    expect(showPermissionPrompt).not.toHaveBeenCalled();
    expect(host.callTool).not.toHaveBeenCalled();
  });

  it('counts a call whose tool runs and fails', async () => {
    const request = connectPort(`${ORIGIN}/page`);
    const sessionId = await createSession(request, 1);

    host.callTool.mockResolvedValueOnce({ ok: false, error: 'clock broke' });
    const failed = await request('agent.tools.call', { tool: TOOL, args: {}, sessionId });
    expect(failed.error?.code).toBe('ERR_TOOL_FAILED');

    const next = await request('agent.tools.call', { tool: TOOL, args: {}, sessionId });
    expect(next.error?.code).toBe('ERR_BUDGET_EXCEEDED');
    expect(host.callTool).toHaveBeenCalledTimes(1);
  });

  it('runs no more than the budget when calls arrive in parallel', async () => {
    const request = connectPort(`${ORIGIN}/page`);
    const sessionId = await createSession(request, 2);

    const replies = await Promise.all(
      Array.from({ length: 5 }, () => request('agent.tools.call', { tool: TOOL, args: {}, sessionId })),
    );
    expect(replies.filter(r => r.ok)).toHaveLength(2);
    expect(replies.filter(r => r.error?.code === 'ERR_BUDGET_EXCEEDED')).toHaveLength(3);
    expect(host.callTool).toHaveBeenCalledTimes(2);
  });

  it.each(['Session not found', 'Session has expired', 'Tool call budget exceeded'])(
    'reports a tool that fails with %j as a tool failure, not a Harbor refusal',
    async (toolError) => {
      const request = connectPort(`${ORIGIN}/page`);
      const sessionId = await createSession(request, 5);

      host.callTool.mockResolvedValueOnce({ ok: false, error: toolError });
      const reply = await request('agent.tools.call', { tool: TOOL, args: {}, sessionId });
      expect(reply.error).toEqual({ code: 'ERR_TOOL_FAILED', message: toolError });
    },
  );
});
