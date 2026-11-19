/**
 * A page model or tool call that the page (or Harbor's own request timer)
 * has given up on isn't performed after its policy check, even when the
 * person allows Harbor's prompt late. The page's request times out after
 * 30 seconds and posts {type: 'abort'}; a prompt can stay open longer.
 *
 * This drives the real page port and the real policy gate, so the calls
 * take a page's path: background.ts, the page handlers, harbor-core and
 * extension-api's gatePageCall. Only the MCP host, the bridge and the
 * prompt window are stubbed.
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
let showPermissionPrompt: ReturnType<typeof vi.fn>;
let bridgeChat: ReturnType<typeof vi.fn>;
let bridgeRequest: ReturnType<typeof vi.fn>;
let bridgeStreamRequest: ReturnType<typeof vi.fn>;

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
  await grantPermissions(ORIGIN, ['mcp:tools.list', 'mcp:tools.call', 'model:prompt'], 'granted-always', undefined, [TOOL]);
  showPermissionPrompt = vi.mocked((await import('../../policy/permissions')).showPermissionPrompt);
  bridgeChat = vi.mocked((await import('../../llm/chat')).bridgeChat);
  const bridge = await import('../../llm/bridge-client');
  bridgeRequest = vi.mocked(bridge.bridgeRequest);
  bridgeStreamRequest = vi.mocked(bridge.bridgeStreamRequest);
  bridgeRequest.mockResolvedValue({ default_model: 'ollama:test' });
  bridgeChat.mockResolvedValue({ choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], model: 'ollama:test' });
  initializePageApi();
});

afterEach(async () => {
  const { Policy } = await import('../../policy/store');
  Policy.__reset();
  vi.resetModules();
});

async function loadRules(rules: Array<Record<string, unknown>>) {
  const { Policy } = await import('../../policy/store');
  const { compileRule } = await import('../../policy/rules');
  Policy.__setForTesting(rules.map(r => compileRule({ source: 'user', ...r } as never)));
}

/** A page port. `send` returns the request id; `abort(id)` is what the page posts on timeout. */
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
  const send = (type: string, payload: unknown) => {
    const id = `r${++n}`;
    listeners.forEach(l => l({ id, type, payload }));
    return id;
  };
  const reply = async (id: string) => {
    await vi.waitFor(() => expect(posted.some(p => p.id === id)).toBe(true));
    return posted.find(p => p.id === id)!;
  };
  const abort = (id: string) => listeners.forEach(l => l({ type: 'abort', id }));
  return { send, reply, abort, request: async (type: string, payload: unknown) => reply(send(type, payload)) };
}

/** The prompt stays open until the page gives up, then the person allows it. */
function allowAfter(giveUp: () => void) {
  showPermissionPrompt.mockImplementationOnce(async () => {
    giveUp();
    return { granted: true, grantType: 'granted-once' };
  });
}

const chatCalls = () => bridgeChat.mock.calls.length;

describe('a page call the page gave up on is not performed after a late Allow', () => {
  it('agent.tools.call', async () => {
    await loadRules([{ id: 'confirm', effect: 'ask', principal: { origin: '*' }, action: 'tool.call' }]);
    const page = connectPort(`${ORIGIN}/page`);
    let id = '';
    allowAfter(() => page.abort(id));
    id = page.send('agent.tools.call', { tool: TOOL, args: {} });
    const reply = await page.reply(id);
    expect(showPermissionPrompt).toHaveBeenCalledTimes(1);
    expect(reply.ok).toBe(false);
    expect(host.callTool).not.toHaveBeenCalled();
  });

  it("a window.ai session's prompt()", async () => {
    const page = connectPort(`${ORIGIN}/page`);
    const created = await page.request('ai.createTextSession', { model: 'ollama:test' });
    expect(created.ok, created.error?.message).toBe(true);
    const sessionId = created.result as string;

    await loadRules([{ id: 'confirm', effect: 'ask', principal: { origin: '*' }, action: 'model.prompt.local' }]);
    let id = '';
    allowAfter(() => page.abort(id));
    id = page.send('session.prompt', { sessionId, input: 'hi' });
    const reply = await page.reply(id);
    expect(showPermissionPrompt).toHaveBeenCalledTimes(1);
    expect(reply.ok).toBe(false);
    expect(chatCalls()).toBe(0);
  });

  it('an Allow in time still runs the tool', async () => {
    await loadRules([{ id: 'confirm', effect: 'ask', principal: { origin: '*' }, action: 'tool.call' }]);
    showPermissionPrompt.mockResolvedValueOnce({ granted: true, grantType: 'granted-once' });
    const page = connectPort(`${ORIGIN}/page`);
    const reply = await page.request('agent.tools.call', { tool: TOOL, args: {} });
    expect(reply.ok, reply.error?.message).toBe(true);
    expect(host.callTool).toHaveBeenCalledTimes(1);
  });
});

describe("Harbor's own request timer", () => {
  it('a call harborRequest already timed out on is not performed after a late Allow', async () => {
    await loadRules([{ id: 'confirm', effect: 'ask', principal: { origin: '*' }, action: 'tool.call' }]);
    let allow!: () => void;
    showPermissionPrompt.mockImplementationOnce(
      () => new Promise((resolve) => { allow = () => resolve({ granted: true, grantType: 'granted-once' }); }),
    );
    const { harborRequest } = await import('../harbor-core');
    const call = harborRequest(
      'mcp.callTool',
      { origin: ORIGIN, serverId: 'clock', toolName: 'now', args: {} },
      { timeoutMs: 20 },
    );
    await expect(call).rejects.toThrow(/timed out/);
    allow();
    await new Promise((r) => setTimeout(r, 30));
    expect(host.callTool).not.toHaveBeenCalled();
  });
});

describe('a streaming prompt the page cancelled while Harbor asked', () => {
  it('never reaches the model', async () => {
    await loadRules([{ id: 'confirm', effect: 'ask', principal: { origin: '*' }, action: 'model.prompt.local' }]);
    const { harborStreamRequest } = await import('../harbor-core');
    let cancel!: () => void;
    allowAfter(() => cancel());
    const req = harborStreamRequest('llm.chatStream', {
      origin: ORIGIN, messages: [{ role: 'user', content: 'hi' }], model: 'ollama:test',
    });
    cancel = req.cancel;
    const events: Array<{ type: string; error?: { code?: string } }> = [];
    for await (const event of req.stream) events.push(event as never);
    expect(showPermissionPrompt).toHaveBeenCalledTimes(1);
    expect(bridgeStreamRequest).not.toHaveBeenCalled();
  });
});
