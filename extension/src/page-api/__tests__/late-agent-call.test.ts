/**
 * A page's agent or chat call (window.agent.agents.*, agent.chat.open)
 * that the page, or Harbor's own request timer, has given up on isn't
 * performed after Harbor's policy check, even when the person allows the
 * prompt late. The page's request times out after 30 seconds and posts
 * {type: 'abort'}; a prompt can stay open longer.
 *
 * This drives the real page port, harbor-core's dispatch and the real
 * agent router and policy gate. Only the bridge, the MCP host, the prompt
 * window and the feature flags are stubbed.
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
vi.mock('../policy/feature-flags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../policy/feature-flags')>();
  const { DEFAULT_FLAGS } = await import('../policy/feature-flag-set');
  const all = Object.fromEntries(Object.keys(DEFAULT_FLAGS).map((k) => [k, true]));
  return { ...actual, getFeatureFlags: async () => all };
});
vi.mock('../../policy/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../policy/permissions')>()),
  showPermissionPrompt: vi.fn(),
}));

type Listener = (port: unknown) => void;
type Reply = { id?: string; ok: boolean; result?: unknown; error?: { code?: string; message: string } };

const ORIGIN = 'https://a.example';
let onConnect: Listener;
let showPermissionPrompt: ReturnType<typeof vi.fn>;
let executeScript: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  resetMockBrowser();

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
  executeScript = vi.fn(async () => [{ result: undefined }]);
  chromeGlobal.chrome.scripting = { executeScript };

  const { initializePageApi } = await import('../background');
  const { grantPermissions } = await import('../../policy/permissions');
  await grantPermissions(ORIGIN, ['agents:register', 'chat:open'], 'granted-always');
  showPermissionPrompt = vi.mocked((await import('../../policy/permissions')).showPermissionPrompt);
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

async function registeredAgents() {
  const { getAgentsByOrigin } = await import('../../multi-agent/registry');
  return getAgentsByOrigin(ORIGIN);
}

describe('a page agent or chat call the page gave up on is not performed after a late Allow', () => {
  it('agent.agents.register', async () => {
    await loadRules([{ id: 'confirm', effect: 'ask', principal: { origin: '*' }, action: 'agent.register' }]);
    const page = connectPort(`${ORIGIN}/page`);
    let id = '';
    allowAfter(() => page.abort(id));
    id = page.send('agent.agents.register', { name: 'Late agent', capabilities: [] });
    const reply = await page.reply(id);
    expect(showPermissionPrompt).toHaveBeenCalledTimes(1);
    expect(reply.ok).toBe(false);
    expect(await registeredAgents()).toHaveLength(0);
  });

  it('agent.chat.open', async () => {
    await loadRules([{ id: 'confirm', effect: 'ask', principal: { origin: '*' }, action: 'chat.open' }]);
    const page = connectPort(`${ORIGIN}/page`);
    let id = '';
    allowAfter(() => page.abort(id));
    id = page.send('agent.chat.open', {});
    const reply = await page.reply(id);
    expect(showPermissionPrompt).toHaveBeenCalledTimes(1);
    expect(reply.ok === false || (reply.result as { success?: boolean })?.success === false).toBe(true);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('an Allow in time still registers the agent', async () => {
    await loadRules([{ id: 'confirm', effect: 'ask', principal: { origin: '*' }, action: 'agent.register' }]);
    showPermissionPrompt.mockResolvedValueOnce({ granted: true, grantType: 'granted-once' });
    const page = connectPort(`${ORIGIN}/page`);
    const reply = await page.request('agent.agents.register', { name: 'On-time agent', capabilities: [] });
    expect(reply.ok, reply.error?.message).toBe(true);
    expect(await registeredAgents()).toHaveLength(1);
  });
});

describe("Harbor's own request timer", () => {
  it('an agent call harborRequest already timed out on is not performed after a late Allow', async () => {
    await loadRules([{ id: 'confirm', effect: 'ask', principal: { origin: '*' }, action: 'agent.register' }]);
    let allow!: () => void;
    showPermissionPrompt.mockImplementationOnce(
      () => new Promise((resolve) => { allow = () => resolve({ granted: true, grantType: 'granted-once' }); }),
    );
    const { harborRequest } = await import('../harbor-core');
    const call = harborRequest('agents.register', { origin: ORIGIN, name: 'Timed out', capabilities: [] }, { timeoutMs: 20 });
    await expect(call).rejects.toThrow(/timed out/);
    allow();
    await new Promise((r) => setTimeout(r, 30));
    expect(await registeredAgents()).toHaveLength(0);
  });
});

describe('a refused agent.chat.open reports the policy engine\'s code', () => {
  it('a deny rule refuses it with ERR_BLOCKED_BY_POLICY', async () => {
    await loadRules([{ id: 'no-chat', effect: 'deny', principal: { origin: '*' }, action: 'chat.open' }]);
    const page = connectPort(`${ORIGIN}/page`);
    const reply = await page.request('agent.chat.open', {});
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('ERR_BLOCKED_BY_POLICY');
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('a dismissed prompt refuses it with ERR_PERMISSION_DENIED', async () => {
    await loadRules([{ id: 'confirm', effect: 'ask', principal: { origin: '*' }, action: 'chat.open' }]);
    showPermissionPrompt.mockResolvedValueOnce({ granted: false });
    const page = connectPort(`${ORIGIN}/page`);
    const reply = await page.request('agent.chat.open', {});
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('ERR_PERMISSION_DENIED');
  });
});
