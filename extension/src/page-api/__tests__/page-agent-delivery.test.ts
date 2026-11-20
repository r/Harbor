/**
 * With the Web Agents API folded in, a page's invocation handler is
 * registered through Harbor's own in-process page API — there is no second
 * extension to forward to. This drives the real boundary: two tabs each
 * connect their own `harbor-page-api` port (as the content script does),
 * one registers an agent with an invocation handler, the other invokes it,
 * and the registering tab's content script answers through the captured
 * `runtime.onMessage` listener — exactly as the real content script would.
 *
 * Per docs/agent-workflow.md's "Test a new cross-extension message through
 * the listener, not the router" pitfall, registration and invocation go
 * through a captured `onConnect`/`onMessage` listener in every test. The
 * timeout test additionally drives the invoke step through
 * `routeAgentMessage` directly — see the comment there for why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';
import type { grantPermissions as GrantPermissions } from '../../policy/permissions';

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
    recordPrompt: vi.fn(),
    // As the real registry does for a session without maxToolCalls.
    recordToolCall: vi.fn(() => true),
    touchSession: vi.fn(),
  },
}));

type ConnectListener = (port: unknown) => void;

/**
 * Messages and broadcasts between page agents, end to end: a page's request
 * goes through Harbor's page API and background, and arrives at the other
 * tab as the agent event its content script hands to the page.
 */

let onConnect: ConnectListener;
let tabsSendMessage: ReturnType<typeof vi.fn>;
let grantPermissions: typeof GrantPermissions;
// What each tab shows now, as tabs.get reports it.
const tabUrls = new Map<number, string>();

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  resetMockBrowser();
  tabUrls.clear();
  await chrome.storage.local.set({ 'harbor-page-api-flags': { multiAgent: true } });

  tabsSendMessage = vi.fn(() => Promise.resolve());
  const chromeGlobal = globalThis as unknown as { chrome: Record<string, unknown> };
  chromeGlobal.chrome.runtime = {
    ...(chromeGlobal.chrome.runtime as Record<string, unknown>),
    onConnect: { addListener: (l: ConnectListener) => { onConnect = l; } },
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  chromeGlobal.chrome.tabs = {
    ...(chromeGlobal.chrome.tabs as Record<string, unknown>),
    onRemoved: { addListener: vi.fn() },
    get: vi.fn(async (tabId: number) => {
      const url = tabUrls.get(tabId);
      if (!url) throw new Error('no tab');
      return { id: tabId, url };
    }),
    sendMessage: tabsSendMessage,
  };

  const { initializePageApi } = await import('../background');
  ({ grantPermissions } = await import('../../policy/permissions'));
  initializePageApi();
  const { initializePolicyStore } = await import('../../policy/store');
  await initializePolicyStore();

  for (const site of ['https://a.example', 'https://b.example']) {
    await grantPermissions(site, ['agents:register', 'agents:message', 'agents:invoke'], 'granted-always');
  }
});

afterEach(() => {
  vi.resetModules();
});

interface TestPort {
  send: (message: unknown) => void;
  disconnect: () => void;
  posted: Array<{ id?: string; ok: boolean; result?: unknown; error?: { code?: string; message: string } }>;
}

function connectPort(senderUrl: string, tabId: number): TestPort {
  tabUrls.set(tabId, senderUrl);
  const messageListeners: Array<(m: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const posted: TestPort['posted'] = [];
  onConnect({
    name: 'harbor-page-api',
    sender: { url: senderUrl, tab: { id: tabId }, frameId: 0 },
    onMessage: { addListener: (l: (m: unknown) => void) => messageListeners.push(l) },
    onDisconnect: { addListener: (l: () => void) => disconnectListeners.push(l) },
    postMessage: (m: TestPort['posted'][number]) => posted.push(m),
  });
  return {
    send: (message: unknown) => messageListeners.forEach((l) => l(message)),
    disconnect: () => disconnectListeners.forEach((l) => l()),
    posted,
  };
}

let nextId = 0;
async function request(tab: TestPort, type: string, payload: unknown): Promise<TestPort['posted'][number]> {
  const id = `req-${++nextId}`;
  tab.send({ id, type, payload });
  await vi.waitFor(() => expect(tab.posted.some((p) => p.id === id)).toBe(true));
  return tab.posted.find((p) => p.id === id)!;
}

async function register(tab: TestPort, name: string): Promise<string> {
  const reply = await request(tab, 'agent.agents.register', { name, acceptsMessages: true });
  expect(reply.ok).toBe(true);
  return (reply.result as { id: string }).id;
}

function agentEventsTo(tabId: number): Array<{ type: string; message?: { payload: unknown }; broadcast?: { type: string; data: unknown } }> {
  return tabsSendMessage.mock.calls
    .filter(([id, m]) => id === tabId && (m as { type: string }).type === 'agentEvent')
    .map(([, m]) => (m as { event: never }).event);
}

describe('messages between page agents', () => {
  it('arrive at the recipient\'s tab', async () => {
    const tabA = connectPort('https://a.example/page', 1);
    const tabB = connectPort('https://b.example/page', 2);
    const onA = await register(tabA, 'a');
    await register(tabB, 'b');
    await grantPermissions('https://b.example', ['agents:crossOrigin'], 'granted-always', undefined, undefined, undefined, ['https://a.example']);

    const reply = await request(tabB, 'agent.agents.send', { agentId: onA, payload: 'hi' });

    expect(reply.ok).toBe(true);
    await vi.waitFor(() => expect(agentEventsTo(1)).toHaveLength(1));
    expect(agentEventsTo(1)[0]).toMatchObject({ type: 'message', message: { payload: 'hi' } });
  });

  it('are not posted into a tab that now shows another site', async () => {
    const tabA = connectPort('https://a.example/page', 1);
    const tabB = connectPort('https://b.example/page', 2);
    const onA = await register(tabA, 'a');
    await register(tabB, 'b');
    await grantPermissions('https://b.example', ['agents:crossOrigin'], 'granted-always', undefined, undefined, undefined, ['https://a.example']);
    // Tab 1 moved on before its port closed.
    tabUrls.set(1, 'https://evil.example/');

    await request(tabB, 'agent.agents.send', { agentId: onA, payload: 'secret' });
    await new Promise((r) => setTimeout(r, 20));

    expect(agentEventsTo(1)).toEqual([]);
  });

  it('stop once the recipient\'s page has gone', async () => {
    const tabA = connectPort('https://a.example/page', 1);
    const tabB = connectPort('https://b.example/page', 2);
    const onA = await register(tabA, 'a');
    await register(tabB, 'b');
    await grantPermissions('https://b.example', ['agents:crossOrigin'], 'granted-always', undefined, undefined, undefined, ['https://a.example']);

    tabA.disconnect();
    const reply = await request(tabB, 'agent.agents.send', { agentId: onA, payload: 'late' });

    expect((reply.result as { delivered: boolean }).delivered).toBe(false);
    expect(agentEventsTo(1)).toEqual([]);
  });
});

describe('a reloaded page', () => {
  it('keeps the new page\'s agent when the old page\'s connection closes late', async () => {
    const oldPage = connectPort('https://a.example/page', 1);
    const tabB = connectPort('https://b.example/page', 2);
    const oldAgent = await register(oldPage, 'old');
    await register(tabB, 'b');
    await grantPermissions('https://b.example', ['agents:crossOrigin'], 'granted-always', undefined, undefined, undefined, ['https://a.example']);
    // The tab reloads: the new page connects and registers before the old
    // page's connection reports that it closed.
    await new Promise((r) => setTimeout(r, 2));
    const newPage = connectPort('https://a.example/page', 1);
    const newAgent = await register(newPage, 'new');
    oldPage.disconnect();

    const toNew = await request(tabB, 'agent.agents.send', { agentId: newAgent, payload: 'hi' });
    const toOld = await request(tabB, 'agent.agents.send', { agentId: oldAgent, payload: 'hi' });

    expect((toNew.result as { delivered: boolean }).delivered).toBe(true);
    expect((toOld.result as { delivered: boolean }).delivered).toBe(false);
  });
});

describe('broadcasts between page agents', () => {
  it('reach a subscriber on another tab of the same site, whichever tab registered last', async () => {
    const tab1 = connectPort('https://a.example/one', 1);
    const tab3 = connectPort('https://a.example/two', 3);
    await register(tab1, 'one');
    await register(tab3, 'two');
    await request(tab1, 'agent.agents.subscribe', { eventType: 'news' });

    const reply = await request(tab3, 'agent.agents.broadcast', { eventType: 'news', data: 1 });

    expect(reply).toMatchObject({ ok: true, result: { delivered: 1 } });
    await vi.waitFor(() => expect(agentEventsTo(1)).toHaveLength(1));
    expect(agentEventsTo(1)[0]).toMatchObject({ type: 'broadcast', broadcast: { type: 'news', data: 1 } });
    expect(agentEventsTo(3)).toEqual([]);
  });

  it('reach a granted site, through the page API', async () => {
    const tabA = connectPort('https://a.example/page', 1);
    const tabB = connectPort('https://b.example/page', 2);
    await register(tabA, 'a');
    await register(tabB, 'b');
    await request(tabA, 'agent.agents.subscribe', { eventType: 'news' });
    await grantPermissions('https://b.example', ['agents:crossOrigin'], 'granted-always', undefined, undefined, undefined, ['https://a.example']);

    const reply = await request(tabB, 'agent.agents.broadcast', { eventType: 'news', data: 2 });

    expect(reply).toMatchObject({ ok: true, result: { delivered: 1 } });
  });

  it('do not reach a granted site that a policy rule refuses', async () => {
    const tabA = connectPort('https://a.example/page', 1);
    const tabB = connectPort('https://b.example/page', 2);
    await register(tabA, 'a');
    await register(tabB, 'b');
    await request(tabA, 'agent.agents.subscribe', { eventType: 'news' });
    await grantPermissions('https://b.example', ['agents:crossOrigin'], 'granted-always', undefined, undefined, undefined, ['https://a.example']);
    const { Policy } = await import('../../policy/store');
    const { compileRule } = await import('../../policy/rules');
    Policy.__setForTesting([
      compileRule({ id: 'no-cross', effect: 'deny', principal: { origin: '*' }, action: 'agent.delegate.crossOrigin', source: 'managed' }),
    ]);

    const reply = await request(tabB, 'agent.agents.broadcast', { eventType: 'news', data: 3 });

    expect(reply).toMatchObject({ ok: true, result: { delivered: 0 } });
    expect(agentEventsTo(1)).toEqual([]);
  });

  it('need agents:message', async () => {
    const tabC = connectPort('https://c.example/page', 4);
    await grantPermissions('https://c.example', ['agents:register'], 'granted-always');
    await register(tabC, 'c');
    const { denyPermissions } = await import('../../policy/permissions');
    await denyPermissions('https://c.example', ['agents:message']);

    const reply = await request(tabC, 'agent.agents.broadcast', { eventType: 'news', data: 4 });

    expect(reply.ok).toBe(false);
  });
});
