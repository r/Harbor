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
import { installFakeMcpServer } from '../../mcp/__tests__/support/fake-mcp-server';
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

const ORIGIN = 'https://accounts.google.com';
const TOOL = 'site:accounts.google.com:dummy/read';
let onConnect: Listener;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  resetMockBrowser();
  installFakeMcpServer({ tools: [{ name: 'read' }] });
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
  await grantPermissions(ORIGIN, ['model:prompt', 'mcp:tools.list', 'mcp:tools.call'], 'granted-always', undefined, [TOOL]);
  const { registerSiteServer } = await import('../../mcp/site-servers');
  expect((await registerSiteServer({ origin: ORIGIN, tabId: 9, url: `${ORIGIN}/mcp`, name: 'dummy', transport: 'streamable-http' })).ok).toBe(true);
  const { bridgeChat } = await import('../../llm/chat');
  vi.mocked(bridgeChat).mockResolvedValue({ content: 'dummy answer' } as never);
  const { bridgeStreamRequest } = await import('../../llm/bridge-client');
  vi.mocked(bridgeStreamRequest).mockImplementation(async function* () { yield { type: 'done' } as never; });
  initializePageApi();
});

afterEach(async () => {
  const { Policy } = await import('../../policy/store');
  Policy.__reset();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Load policy rules into the same module instance the background uses. */
async function loadRules(rules: Array<Record<string, unknown>>) {
  const { Policy } = await import('../../policy/store');
  const { compileRule } = await import('../../policy/rules');
  Policy.__setForTesting(rules.map(r => compileRule({ source: 'user', ...r } as never)));
}

/** A policy refusal reaches the page with the policy engine's code. */
function expectPolicyRefusal(reply: Reply, code: string) {
  expect(reply.ok).toBe(false);
  expect(reply.error?.code).toBe(code);
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
    capabilities: { llm: { model: 'dummy:configured' }, tools: [TOOL] },
    limits: { maxToolCalls },
  });
  expect(created.ok, created.error?.message).toBe(true);
  return (created.result as { sessionId: string }).sessionId;
}

describe('a capability session retains trusted output labels', () => {
  it('blocks a later remote prompt after a scoped sensitive site tool returns, without affecting another session', async () => {
    const request = connectPort(`${ORIGIN}/page`);
    const sessionId = await createSession(request, 5);
    const other = await createSession(request, 5);
    expect((await request('agent.tools.call', { tool: TOOL, args: {}, sessionId })).ok).toBe(true);
    const reply = await request('session.prompt', { sessionId, input: 'dummy input', labels: [] });
    expectPolicyRefusal(reply, 'ERR_LABEL_FLOW_BLOCKED');
    const { bridgeChat } = await import('../../llm/chat');
    expect(bridgeChat).not.toHaveBeenCalled();
    expect((await request('session.prompt', { sessionId: other, input: 'dummy input' })).ok).toBe(true);
    expect(bridgeChat).toHaveBeenCalledTimes(1);
  });

  it('ignores a spoofed session id from another origin, and refuses an expired one', async () => {
    const request = connectPort(`${ORIGIN}/page`);
    const sessionId = await createSession(request, 5);
    const attacker = connectPort('https://dummy.example/page');
    const { grantPermissions } = await import('../../policy/permissions');
    await grantPermissions('https://dummy.example', ['mcp:tools.call'], 'granted-always', undefined, [TOOL]);
    expectPolicyRefusal(await attacker('agent.tools.call', { tool: TOOL, args: {}, sessionId, origin: ORIGIN }), 'ERR_SESSION_NOT_FOUND');
    expect((await request('session.prompt', { sessionId, input: 'dummy input' })).ok).toBe(true);
    const { SessionRegistry } = await import('../../sessions');
    SessionRegistry.getValidatedSession(sessionId, ORIGIN).capabilities.limits = { expiresAt: Date.now() - 1 };
    expectPolicyRefusal(await request('session.prompt', { sessionId, input: 'dummy input' }), 'ERR_SESSION_NOT_FOUND');
  });
});
