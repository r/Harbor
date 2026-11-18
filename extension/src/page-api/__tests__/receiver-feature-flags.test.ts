/**
 * The sidebar's feature toggles must hold at the receiver. The injected API
 * hides a disabled feature, but a page can post transport messages straight
 * to the content script, which relays any type. So each toggle is checked
 * again where the message lands: the background's port listener.
 *
 * Drives the captured `runtime.onConnect` listener, as a page would reach it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';
import type { FeatureFlags } from '../policy/feature-flags';

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
vi.mock('../../sessions', () => ({
  SessionRegistry: {
    subscribe: vi.fn(),
    createExplicitSession: vi.fn(),
    createImplicitSession: vi.fn(),
    getSession: vi.fn(),
    getValidatedSession: vi.fn(),
    listSessions: vi.fn(() => []),
    terminateSession: vi.fn(),
    setMode: vi.fn(),
    recordPrompt: vi.fn(),
    recordToolCall: vi.fn(),
    recordBrowserAccess: vi.fn(),
    touchSession: vi.fn(),
  },
}));

type Listener = (port: unknown) => void;
type Reply = { id?: string; ok?: boolean; error?: { code: string }; event?: { type: string; error?: { code: string } } };

const ORIGIN = 'https://a.example';
let onConnect: Listener;
let flagsApi: typeof import('../policy/feature-flags');
let aiHandlers: typeof import('../handlers/ai-handlers');
let permissions: typeof import('../../policy/permissions');

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

  const { initializePageApi } = await import('../background');
  flagsApi = await import('../policy/feature-flags');
  aiHandlers = await import('../handlers/ai-handlers');
  permissions = await import('../../policy/permissions');
  initializePageApi();
});

afterEach(() => {
  vi.resetModules();
});

/** Every feature on, then the given overrides. */
async function setFlags(overrides: Partial<FeatureFlags>): Promise<void> {
  await flagsApi.setFeatureFlags({
    textGeneration: true, toolCalling: true, toolAccess: true,
    browserInteraction: true, browserControl: true, multiAgent: true,
    ...overrides,
  });
}

/** Send one raw transport message from a page on ORIGIN and return the first reply. */
async function send(type: string, payload: unknown = {}): Promise<Reply> {
  const listeners: Array<(m: unknown) => void> = [];
  const posted: Reply[] = [];
  onConnect({
    name: 'harbor-page-api',
    sender: { url: `${ORIGIN}/page`, tab: { id: 9 } },
    onMessage: { addListener: (l: (m: unknown) => void) => listeners.push(l) },
    onDisconnect: { addListener: () => {} },
    postMessage: (m: Reply) => posted.push(m),
  });
  listeners.forEach((l) => l({ id: 'r1', type, payload }));
  await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0), { timeout: 5000 });
  return posted[0];
}

function errorCode(reply: Reply): string | undefined {
  return reply.error?.code ?? reply.event?.error?.code;
}

const gated: Array<[keyof FeatureFlags, string, unknown?]> = [
  ['textGeneration', 'ai.canCreateTextSession'],
  ['textGeneration', 'ai.createTextSession', {}],
  ['textGeneration', 'ai.languageModel.create', {}],
  ['textGeneration', 'ai.languageModel.capabilities'],
  ['textGeneration', 'ai.providers.list'],
  ['textGeneration', 'ai.providers.getActive'],
  ['toolAccess', 'agent.tools.list'],
  ['toolAccess', 'agent.tools.call', { tool: 'time/now', args: {} }],
  // An explicit session's callTool sends the same message with a sessionId,
  // which the handler doesn't validate, so it can't be an exemption.
  ['toolAccess', 'agent.tools.call', { tool: 'time/now', args: {}, sessionId: 'made-up' }],
  ['browserInteraction', 'agent.browser.activeTab.click', { ref: 'e1' }],
  ['browserInteraction', 'agent.browser.activeTab.fill', { ref: 'e1', value: 'x' }],
  ['browserInteraction', 'agent.browser.activeTab.select', { ref: 'e1', value: 'x' }],
  ['browserInteraction', 'agent.browser.activeTab.scroll', { direction: 'down' }],
  ['browserInteraction', 'agent.browser.activeTab.screenshot'],
  ['browserInteraction', 'agent.browser.activeTab.getElements'],
  ['browserControl', 'agent.browser.navigate', { url: 'https://b.example/' }],
  ['browserControl', 'agent.browser.tabs.list'],
  ['multiAgent', 'agent.agents.register', {}],
  ['multiAgent', 'agent.agents.list'],
  ['multiAgent', 'agent.agents.invoke', { agentId: 'x', task: 't' }],
  ['multiAgent', 'agent.agents.orchestrate.pipeline', { steps: [] }],
  ['toolCalling', 'agent.run', { task: 'What time is it?' }],
];

describe('a disabled feature is refused at the receiver', () => {
  it.each(gated)('%s off refuses a raw %s', async (flag, type, payload) => {
    await setFlags({ [flag]: false });
    expect(errorCode(await send(type, payload))).toBe('ERR_FEATURE_DISABLED');
  });

  it.each(gated)('%s on lets %s through to its own checks', async (flag, type, payload) => {
    await setFlags({});
    expect(errorCode(await send(type, payload))).not.toBe('ERR_FEATURE_DISABLED');
  });

  it('refuses active-tab readability only when both browser settings are off', async () => {
    await setFlags({ browserInteraction: false, browserControl: false });
    expect(errorCode(await send('agent.browser.activeTab.readability'))).toBe('ERR_FEATURE_DISABLED');

    await setFlags({ browserInteraction: false, browserControl: true });
    expect(errorCode(await send('agent.browser.activeTab.readability'))).not.toBe('ERR_FEATURE_DISABLED');

    await setFlags({ browserInteraction: true, browserControl: false });
    expect(errorCode(await send('agent.browser.activeTab.readability'))).not.toBe('ERR_FEATURE_DISABLED');
  });
});

describe('text sessions follow Text Generation', () => {
  it.each(['session.prompt', 'session.promptStreaming'])(
    'refuses %s on a window.ai session made before Text Generation was turned off',
    async (type) => {
      const created = await (async () => {
        await setFlags({});
        await permissions.grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');
        return send('ai.createTextSession', {}) as Promise<Reply & { result?: string }>;
      })();
      expect(created.ok).toBe(true);
      await setFlags({ textGeneration: false });
      expect(errorCode(await send(type, { sessionId: created.result, input: 'hi' }))).toBe('ERR_FEATURE_DISABLED');
    },
  );

  it.each(['session.prompt', 'session.promptStreaming'])(
    'leaves %s on an explicit agent session to its own checks',
    async (type) => {
      aiHandlers.registerExplicitTextSession('explicit-1', ORIGIN, {});
      await setFlags({ textGeneration: false });
      expect(errorCode(await send(type, { sessionId: 'explicit-1', input: 'hi' }))).not.toBe('ERR_FEATURE_DISABLED');
    },
  );

});
