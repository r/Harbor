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
type RuntimeMessageListener = (
  message: unknown,
  sender: { id?: string; tab?: { id?: number } },
  sendResponse: (response?: unknown) => void,
) => boolean | void;

let onConnect: ConnectListener;
// What each tab shows now, for tabs.get (set by connectPort; a test can
// move a tab to another site without its old page's port closing yet).
let tabUrls: Map<number, string>;
let onTabRemoved: (tabId: number) => Promise<void> | void;
let onTabUpdated: (tabId: number, changeInfo: { url?: string }) => void;
let runtimeMessageListeners: RuntimeMessageListener[];
let tabsSendMessage: ReturnType<typeof vi.fn>;
let grantPermissions: typeof GrantPermissions;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  resetMockBrowser();
  // agent.agents.* is gated by Multi-Agent, which is off by default.
  await chrome.storage.local.set({ 'harbor-page-api-flags': { multiAgent: true } });

  runtimeMessageListeners = [];
  tabUrls = new Map();
  tabsSendMessage = vi.fn(() => Promise.resolve());

  const chromeGlobal = globalThis as unknown as { chrome: Record<string, unknown> };
  chromeGlobal.chrome.runtime = {
    ...(chromeGlobal.chrome.runtime as Record<string, unknown>),
    onConnect: { addListener: (l: ConnectListener) => { onConnect = l; } },
    onMessage: {
      addListener: (l: RuntimeMessageListener) => { runtimeMessageListeners.push(l); },
      removeListener: vi.fn(),
    },
  };
  chromeGlobal.chrome.tabs = {
    ...(chromeGlobal.chrome.tabs as Record<string, unknown>),
    onRemoved: { addListener: (l: typeof onTabRemoved) => { onTabRemoved = l; } },
    onUpdated: { addListener: (l: typeof onTabUpdated) => { onTabUpdated = l; } },
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

  // Wire the origin-grant store into the engine's Tier 8 resolver, as
  // background.ts does at startup. Without this, requireAction() never
  // sees the grants below and falls through to the Tier 9 default (ask).
  const { initializePolicyStore } = await import('../../policy/store');
  await initializePolicyStore();

  // Both origins may register as agents; the invoker (b.example) also needs
  // a cross-origin grant for the handler's site (a.example).
  await grantPermissions('https://a.example', ['agents:register'], 'granted-always');
  await grantPermissions('https://b.example', ['agents:register'], 'granted-always');
  await grantPermissions('https://b.example', ['agents:crossOrigin'], 'granted-always', undefined, undefined, undefined, ['https://a.example']);
});

afterEach(() => {
  vi.resetModules();
});

interface TestPort {
  send: (message: unknown) => void;
  posted: Array<{ id?: string; ok: boolean; result?: unknown; error?: { code?: string; message: string } }>;
  /** The page leaves the tab (navigation, reload or close): its port disconnects. */
  disconnect: () => void;
}

function connectPort(senderUrl: string, tabId: number): TestPort {
  const messageListeners: Array<(m: unknown) => void> = [];
  tabUrls.set(tabId, senderUrl);
  const disconnectListeners: Array<() => void> = [];
  const posted: TestPort['posted'] = [];
  const port = {
    name: 'harbor-page-api',
    sender: { url: senderUrl, tab: { id: tabId } },
    onMessage: { addListener: (l: (m: unknown) => void) => messageListeners.push(l) },
    onDisconnect: { addListener: (l: () => void) => disconnectListeners.push(l) },
    postMessage: (m: TestPort['posted'][number]) => posted.push(m),
  };
  onConnect(port);
  return {
    send: (message: unknown) => messageListeners.forEach((l) => l(message)),
    posted,
    disconnect: () => disconnectListeners.forEach((l) => l()),
  };
}

/** Simulate tab1's content script answering, as it does in content-script.ts. */
function replyAsContentScript(senderTabId: number, response: unknown): void {
  for (const listener of runtimeMessageListeners) {
    listener(
      { type: 'agentInvocationResponse', response },
      { id: 'harbor-test', tab: { id: senderTabId } },
      () => {},
    );
  }
}

async function registerHandlerAgent(tab: TestPort, name: string): Promise<string> {
  tab.send({ id: `reg-${name}`, type: 'agent.agents.register', payload: { name, acceptsInvocations: true } });
  await vi.waitFor(() => expect(tab.posted.some((p) => p.id === `reg-${name}`)).toBe(true));
  const reply = tab.posted.find((p) => p.id === `reg-${name}`)!;
  expect(reply.ok).toBe(true);
  return (reply.result as { id: string }).id;
}

describe('multi-agent invocation, delivered entirely in-process (no cross-extension hop)', () => {
  it("tab 2 invokes tab 1's agent, and tab 1's content script answer resolves tab 2's call", async () => {
    const tab1 = connectPort('https://a.example/page', 1);
    const tab2 = connectPort('https://b.example/page', 2);

    const handlerAgentId = await registerHandlerAgent(tab1, 'handler');
    await registerHandlerAgent(tab2, 'invoker');

    tab2.send({
      id: 'invoke-1',
      type: 'agent.agents.invoke',
      payload: { agentId: handlerAgentId, request: { task: 'summarize', input: { url: 'https://a.example' } } },
    });

    // Harbor delivers the invocation to tab 1 directly — no runtime.sendMessage
    // to a second extension id.
    await vi.waitFor(() => expect(tabsSendMessage).toHaveBeenCalled());
    const [sentTabId, sentMessage] = tabsSendMessage.mock.calls[0] as [number, { type: string; invocationId: string }];
    expect(sentTabId).toBe(1);
    expect(sentMessage.type).toBe('agentInvocation');

    // Tab 1's content script answers through the captured runtime.onMessage
    // listener, exactly as the real content script does.
    replyAsContentScript(1, {
      invocationId: sentMessage.invocationId,
      success: true,
      result: { summary: "tab 1's answer" },
    });

    await vi.waitFor(() => expect(tab2.posted.some((p) => p.id === 'invoke-1')).toBe(true));
    const invokeReply = tab2.posted.find((p) => p.id === 'invoke-1')!;
    expect(invokeReply.ok).toBe(true);
    const result = invokeReply.result as { success: boolean; result?: { summary: string } };
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ summary: "tab 1's answer" });
  });

  it("tells tab 2 which site's agent answered, whatever tab 1's answer claims", async () => {
    const tab1 = connectPort('https://a.example/page', 1);
    const tab2 = connectPort('https://b.example/page', 2);

    const handlerAgentId = await registerHandlerAgent(tab1, 'handler');
    await registerHandlerAgent(tab2, 'invoker');

    tab2.send({
      id: 'invoke-p',
      type: 'agent.agents.invoke',
      payload: { agentId: handlerAgentId, request: { task: 'summarize' } },
    });

    await vi.waitFor(() => expect(tabsSendMessage).toHaveBeenCalled());
    const [, sentMessage] = tabsSendMessage.mock.calls[0] as [number, { invocationId: string }];
    replyAsContentScript(1, {
      invocationId: sentMessage.invocationId,
      success: true,
      result: 'ok',
      provenance: { source: 'agent', origin: 'https://bank.example', agentId: 'someone-else' },
    });

    await vi.waitFor(() => expect(tab2.posted.some((p) => p.id === 'invoke-p')).toBe(true));
    const invokeReply = tab2.posted.find((p) => p.id === 'invoke-p')!;
    expect((invokeReply.result as { provenance?: unknown }).provenance).toEqual({
      source: 'agent',
      origin: 'https://a.example',
      agentId: handlerAgentId,
    });
  });

  it("a reply claiming to be from a different tab does not resolve tab 1's pending invocation", async () => {
    const tab1 = connectPort('https://a.example/page', 1);
    const tab2 = connectPort('https://b.example/page', 2);

    const handlerAgentId = await registerHandlerAgent(tab1, 'handler');
    await registerHandlerAgent(tab2, 'invoker');

    tab2.send({
      id: 'invoke-2',
      type: 'agent.agents.invoke',
      payload: { agentId: handlerAgentId, request: { task: 'summarize' } },
    });

    await vi.waitFor(() => expect(tabsSendMessage).toHaveBeenCalled());
    const [, sentMessage] = tabsSendMessage.mock.calls[0] as [number, { type: string; invocationId: string }];

    // A page in tab 2 (or any tab other than the one the invocation was sent
    // to) must not be able to answer for it, even if it guesses the real
    // invocationId.
    replyAsContentScript(2, {
      invocationId: sentMessage.invocationId,
      success: true,
      result: { summary: 'forged answer from tab 2' },
    });

    // Give any (incorrect) resolution a chance to land.
    await new Promise((r) => setTimeout(r, 20));
    expect(tab2.posted.some((p) => p.id === 'invoke-2')).toBe(false);

    // A mismatched invocationId from the right tab must not resolve it either.
    replyAsContentScript(1, {
      invocationId: 'not-the-real-id',
      success: true,
      result: { summary: 'wrong id' },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(tab2.posted.some((p) => p.id === 'invoke-2')).toBe(false);

    // The real reply, from the right tab with the right id, still resolves it.
    replyAsContentScript(1, {
      invocationId: sentMessage.invocationId,
      success: true,
      result: { summary: 'real answer' },
    });
    await vi.waitFor(() => expect(tab2.posted.some((p) => p.id === 'invoke-2')).toBe(true));
    const invokeReply = tab2.posted.find((p) => p.id === 'invoke-2')!;
    expect(invokeReply.ok).toBe(true);
    expect((invokeReply.result as { result?: { summary: string } }).result).toEqual({ summary: 'real answer' });
  });

  it('resolves with ERR_TIMEOUT if tab 1 never answers', async () => {
    vi.useFakeTimers();
    try {
      const tab1 = connectPort('https://a.example/page', 1);
      const tab2 = connectPort('https://b.example/page', 2);

      const handlerAgentId = await registerHandlerAgent(tab1, 'handler');
      await registerHandlerAgent(tab2, 'invoker');

      // Drive the invoke step one layer below the full page round trip:
      // through `routeAgentMessage`, the same production entry point
      // harbor-core.ts's in-process dispatch uses for `agents.*` types. The
      // full round trip through tab 2's own port also works (test above),
      // but page-api/harbor-core.ts wraps every page call in its own
      // independent 30-second limit (see harbor-core-timeout.test.ts) that
      // is registered first and so would win this race against the
      // mechanism this test targets — the invocation's own ERR_TIMEOUT,
      // unchanged from before this unit. Calling the same function
      // directly isolates that mechanism.
      const { routeAgentMessage } = await import('../../agents/background-router');
      let settled: { ok: boolean; result?: unknown; error?: string } | undefined;
      routeAgentMessage(
        {
          type: 'agents.invoke',
          payload: {
            agentId: handlerAgentId,
            task: 'summarize',
            origin: 'https://b.example',
            tabId: 2,
          },
        },
        (response) => { settled = response; },
      );

      await vi.waitFor(() => expect(tabsSendMessage).toHaveBeenCalled());

      await vi.advanceTimersByTimeAsync(30_000);

      await vi.waitFor(() => expect(settled).toBeDefined());
      expect(settled!.ok).toBe(true);
      const result = settled!.result as { success: boolean; error?: { code: string } };
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ERR_TIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Drive tab 2's invoke of tab 1's agent one layer below tab 2's port, as the
 * ERR_TIMEOUT test above does: harbor-core.ts's own 30-second page-call
 * limit would otherwise answer tab 2 first, hiding what the invocation
 * itself does.
 */
async function invokeBelowPagePort(
  handlerAgentId: string,
  timeout?: number,
  expectDelivery = true,
): Promise<{ settled: () => { ok: boolean; result?: unknown } | undefined }> {
  const { routeAgentMessage } = await import('../../agents/background-router');
  let settled: { ok: boolean; result?: unknown } | undefined;
  routeAgentMessage(
    {
      type: 'agents.invoke',
      payload: { agentId: handlerAgentId, task: 'summarize', timeout, origin: 'https://b.example', tabId: 2 },
    },
    (response) => { settled = response; },
  );
  if (expectDelivery) await vi.waitFor(() => expect(tabsSendMessage).toHaveBeenCalled());
  return { settled: () => settled };
}

describe('multi-agent lifecycle cleanup', () => {
  it("unregistering an agent drops its handlers and its invocation tab", async () => {
    const tab1 = connectPort('https://a.example/page', 1);
    const handlerAgentId = await registerHandlerAgent(tab1, 'handler');

    const { agentInvocationTabs } = await import('../handlers/agent-handlers');
    const { hasAgentHandlers } = await import('../../multi-agent/messaging');
    expect(agentInvocationTabs.has(handlerAgentId)).toBe(true);
    expect(hasAgentHandlers(handlerAgentId)).toBe(true);

    tab1.send({ id: 'unreg', type: 'agent.agents.unregister', payload: { agentId: handlerAgentId } });
    await vi.waitFor(() => expect(tab1.posted.some((p) => p.id === 'unreg')).toBe(true));
    expect(tab1.posted.find((p) => p.id === 'unreg')!.ok).toBe(true);

    expect(hasAgentHandlers(handlerAgentId)).toBe(false);
    expect(agentInvocationTabs.has(handlerAgentId)).toBe(false);
  });

  it("another site's unregister, which Harbor refuses, leaves the agent invocable", async () => {
    const tab1 = connectPort('https://a.example/page', 1);
    const tab2 = connectPort('https://b.example/page', 2);
    const handlerAgentId = await registerHandlerAgent(tab1, 'handler');
    await registerHandlerAgent(tab2, 'invoker');

    // b.example may register agents of its own, but a.example's isn't one.
    tab2.send({ id: 'unreg-foreign', type: 'agent.agents.unregister', payload: { agentId: handlerAgentId } });
    await vi.waitFor(() => expect(tab2.posted.some((p) => p.id === 'unreg-foreign')).toBe(true));
    // Refused as if there were no such agent, so it doesn't reveal one.
    const refusal = tab2.posted.find((p) => p.id === 'unreg-foreign')!;
    expect(refusal.ok).toBe(false);
    expect(refusal.error?.code).toBe('ERR_AGENT_NOT_FOUND');

    const { agentInvocationTabs, registeredAgents } = await import('../handlers/agent-handlers');
    const { hasAgentHandlers } = await import('../../multi-agent/messaging');
    expect(agentInvocationTabs.has(handlerAgentId)).toBe(true);
    expect(registeredAgents.has(handlerAgentId)).toBe(true);
    expect(hasAgentHandlers(handlerAgentId)).toBe(true);

    tab2.send({
      id: 'invoke-after-foreign-unreg',
      type: 'agent.agents.invoke',
      payload: { agentId: handlerAgentId, request: { task: 'summarize' } },
    });
    await vi.waitFor(() => expect(tabsSendMessage).toHaveBeenCalled());
    expect(tabsSendMessage.mock.calls[0][0]).toBe(1);
  });

  it("closing a tab forgets its agents' invocation tabs", async () => {
    const tab1 = connectPort('https://a.example/page', 1);
    const handlerAgentId = await registerHandlerAgent(tab1, 'handler');
    const { agentInvocationTabs } = await import('../handlers/agent-handlers');
    expect(agentInvocationTabs.has(handlerAgentId)).toBe(true);

    await onTabRemoved(1);
    expect(agentInvocationTabs.has(handlerAgentId)).toBe(false);
  });

  it("sends nothing to a tab that has moved to another site, before the old page's port closes", async () => {
    const tab1 = connectPort('https://a.example/page', 1);
    const tab2 = connectPort('https://b.example/page', 2);
    const handlerAgentId = await registerHandlerAgent(tab1, 'handler');
    await registerHandlerAgent(tab2, 'invoker');

    tabUrls.set(1, 'https://evil.example/');
    const { settled } = await invokeBelowPagePort(handlerAgentId, undefined, false);
    await vi.waitFor(() => expect(settled()).toBeDefined());

    expect(tabsSendMessage).not.toHaveBeenCalled();
    const result = settled()!.result as { success: boolean; error?: { code: string } };
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ERR_AGENT_NOT_FOUND');
  });

  it("sends nothing to a reloaded page for the agent its previous page registered", async () => {
    const oldPage = connectPort('https://a.example/page', 1);
    const tab2 = connectPort('https://b.example/page', 2);
    const oldAgentId = await registerHandlerAgent(oldPage, 'old');
    await registerHandlerAgent(tab2, 'invoker');
    await new Promise((r) => setTimeout(r, 5));

    // The same site, reloaded: a new page connects before the old port closes.
    connectPort('https://a.example/page', 1);
    const { settled } = await invokeBelowPagePort(oldAgentId, undefined, false);
    await vi.waitFor(() => expect(settled()).toBeDefined());

    expect(tabsSendMessage).not.toHaveBeenCalled();
    expect((settled()!.result as { error?: { code: string } }).error?.code).toBe('ERR_AGENT_NOT_FOUND');
  });

  it("an invocation waiting on a tab fails at once when that tab closes", async () => {
    vi.useFakeTimers();
    try {
      const tab1 = connectPort('https://a.example/page', 1);
      connectPort('https://b.example/page', 2);
      const handlerAgentId = await registerHandlerAgent(tab1, 'handler');
      const tab2 = connectPort('https://b.example/other', 2);
      await registerHandlerAgent(tab2, 'invoker');

      const { settled } = await invokeBelowPagePort(handlerAgentId);
      await onTabRemoved(1);
      // Well short of the 30-second invocation timeout.
      await vi.advanceTimersByTimeAsync(10);

      expect(settled()).toBeDefined();
      const result = settled()!.result as { success: boolean; error?: { code: string } };
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ERR_AGENT_NOT_FOUND');
    } finally {
      vi.useRealTimers();
    }
  });

  it("an invocation waiting on a page fails at once when that page navigates away", async () => {
    vi.useFakeTimers();
    try {
      const tab1 = connectPort('https://a.example/page', 1);
      const tab2 = connectPort('https://b.example/page', 2);
      const handlerAgentId = await registerHandlerAgent(tab1, 'handler');
      await registerHandlerAgent(tab2, 'invoker');

      const { settled } = await invokeBelowPagePort(handlerAgentId);
      tab1.disconnect();
      await vi.advanceTimersByTimeAsync(10);

      expect(settled()).toBeDefined();
      const result = settled()!.result as { success: boolean; error?: { code: string } };
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ERR_AGENT_NOT_FOUND');
    } finally {
      vi.useRealTimers();
    }
  });

  it("an invocation waiting on a tab fails at once when the tab moves to another site, even if the old page's port stays open", async () => {
    vi.useFakeTimers();
    try {
      const tab1 = connectPort('https://a.example/page', 1);
      const tab2 = connectPort('https://b.example/page', 2);
      const handlerAgentId = await registerHandlerAgent(tab1, 'handler');
      await registerHandlerAgent(tab2, 'invoker');

      const { settled } = await invokeBelowPagePort(handlerAgentId);
      // Firefox can keep the old page in the back/forward cache with its
      // port open: the tab's URL changes, and no disconnect comes.
      tabUrls.set(1, 'https://evil.example/');
      onTabUpdated(1, { url: 'https://evil.example/' });
      await vi.advanceTimersByTimeAsync(10);

      expect(settled()).toBeDefined();
      expect((settled()!.result as { error?: { code: string } }).error?.code).toBe('ERR_AGENT_NOT_FOUND');
      const { hasAgentHandlers } = await import('../../multi-agent/messaging');
      const { agentInvocationTabs } = await import('../handlers/agent-handlers');
      expect(hasAgentHandlers(handlerAgentId)).toBe(false);
      expect(agentInvocationTabs.has(handlerAgentId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a tab's agents when its URL changes within the same site", async () => {
    const tab1 = connectPort('https://a.example/page', 1);
    const handlerAgentId = await registerHandlerAgent(tab1, 'handler');
    onTabUpdated(1, { url: 'https://a.example/page#section' });
    const { hasAgentHandlers } = await import('../../multi-agent/messaging');
    expect(hasAgentHandlers(handlerAgentId)).toBe(true);
  });

  it("a newer page's invocation survives the old page's late disconnect", async () => {
    vi.useFakeTimers();
    try {
      const oldPage = connectPort('https://a.example/page', 1);
      await registerHandlerAgent(oldPage, 'old');
      await vi.advanceTimersByTimeAsync(5);
      const newPage = connectPort('https://a.example/page', 1);
      const handlerAgentId = await registerHandlerAgent(newPage, 'new');
      const tab2 = connectPort('https://b.example/page', 2);
      await registerHandlerAgent(tab2, 'invoker');
      await vi.advanceTimersByTimeAsync(5);

      const { settled } = await invokeBelowPagePort(handlerAgentId);
      oldPage.disconnect();
      await vi.advanceTimersByTimeAsync(10);
      expect(settled()).toBeUndefined();

      const [, sentMessage] = tabsSendMessage.mock.calls[0] as [number, { invocationId: string }];
      replyAsContentScript(1, { invocationId: sentMessage.invocationId, success: true, result: 'from the new page' });
      await vi.advanceTimersByTimeAsync(0);
      expect((settled()!.result as { success: boolean }).success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps a caller-supplied invocation timeout at five minutes', async () => {
    vi.useFakeTimers();
    try {
      const tab1 = connectPort('https://a.example/page', 1);
      const tab2 = connectPort('https://b.example/page', 2);
      const handlerAgentId = await registerHandlerAgent(tab1, 'handler');
      await registerHandlerAgent(tab2, 'invoker');

      // A day, far past the cap. (vi.waitFor moves the fake clock while it
      // polls, so measure the wait with the invocation's own executionTime.)
      const { settled } = await invokeBelowPagePort(handlerAgentId, 24 * 60 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(settled()).toBeDefined();
      const result = settled()!.result as { success: boolean; error?: { code: string }; executionTime: number };
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ERR_TIMEOUT');
      expect(result.executionTime).toBe(5 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a page's invoke waits out its own timeout past 30 seconds", async () => {
    vi.useFakeTimers();
    try {
      const tab1 = connectPort('https://a.example/page', 1);
      const tab2 = connectPort('https://b.example/page', 2);
      const handlerAgentId = await registerHandlerAgent(tab1, 'handler');
      await registerHandlerAgent(tab2, 'invoker');

      // Through tab 2's own port this time, so harbor-core.ts's page-call
      // limit is in the path.
      tab2.send({
        id: 'invoke-long',
        type: 'agent.agents.invoke',
        payload: { agentId: handlerAgentId, request: { task: 'summarize', timeout: 60_000 } },
      });
      await vi.waitFor(() => expect(tabsSendMessage).toHaveBeenCalled());
      const [, sentMessage] = tabsSendMessage.mock.calls[0] as [number, { invocationId: string }];

      await vi.advanceTimersByTimeAsync(45_000);
      expect(tab2.posted.some((p) => p.id === 'invoke-long')).toBe(false);

      replyAsContentScript(1, { invocationId: sentMessage.invocationId, success: true, result: 'slow answer' });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(tab2.posted.some((p) => p.id === 'invoke-long')).toBe(true));
      const reply = tab2.posted.find((p) => p.id === 'invoke-long')!;
      expect(reply.ok).toBe(true);
      expect((reply.result as { success: boolean; result?: unknown }).result).toBe('slow answer');
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Register through a tab's port with extra register options. */
async function registerVia(tab: TestPort, id: string, payload: Record<string, unknown>): Promise<string> {
  tab.send({ id, type: 'agent.agents.register', payload: { acceptsInvocations: true, ...payload } });
  await vi.waitFor(() => expect(tab.posted.some((p) => p.id === id)).toBe(true));
  const reply = tab.posted.find((p) => p.id === id)!;
  expect(reply.ok).toBe(true);
  return (reply.result as { id: string }).id;
}

describe('a page restored from the back/forward cache', () => {
  it('gets its agent back under the same id, and is invocable again', async () => {
    const page = connectPort('https://a.example/page', 1);
    const tab2 = connectPort('https://b.example/page', 2);
    const agentId = await registerHandlerAgent(page, 'handler');
    await registerHandlerAgent(tab2, 'invoker');

    // The page goes into the cache (pagehide), and Harbor forgets its agent.
    page.disconnect();
    const { registeredAgents } = await import('../handlers/agent-handlers');
    expect(registeredAgents.has(agentId)).toBe(false);

    // Back: the same document reconnects and re-registers its agent.
    const restored = connectPort('https://a.example/page', 1);
    expect(await registerVia(restored, 'restore', { name: 'handler', restoreAgentId: agentId })).toBe(agentId);

    tab2.send({ id: 'invoke-restored', type: 'agent.agents.invoke', payload: { agentId, request: { task: 'summarize' } } });
    await vi.waitFor(() => expect(tabsSendMessage).toHaveBeenCalled());
    expect(tabsSendMessage.mock.calls[0][0]).toBe(1);
  });

  it('gets its agent back after the tab went to another site and came Back', async () => {
    const page = connectPort('https://a.example/page', 1);
    const agentId = await registerHandlerAgent(page, 'handler');

    tabUrls.set(1, 'https://b.example/');
    onTabUpdated(1, { url: 'https://b.example/' });
    tabUrls.set(1, 'https://a.example/page');
    onTabUpdated(1, { url: 'https://a.example/page' });

    expect(await registerVia(page, 'restore', { name: 'handler', restoreAgentId: agentId })).toBe(agentId);
  });

  it("can't take a forgotten agent's id from another tab or another site", async () => {
    const page = connectPort('https://a.example/page', 1);
    const agentId = await registerHandlerAgent(page, 'handler');
    page.disconnect();

    const otherTab = connectPort('https://a.example/page', 3);
    expect(await registerVia(otherTab, 'other-tab', { name: 'h', restoreAgentId: agentId })).not.toBe(agentId);

    const otherSite = connectPort('https://b.example/page', 1);
    expect(await registerVia(otherSite, 'other-site', { name: 'h', restoreAgentId: agentId })).not.toBe(agentId);
  });

  it("can't take a live agent's id", async () => {
    const page = connectPort('https://a.example/page', 1);
    const agentId = await registerHandlerAgent(page, 'handler');
    const other = connectPort('https://b.example/page', 2);
    expect(await registerVia(other, 'live', { name: 'h', restoreAgentId: agentId })).not.toBe(agentId);
  });
});

describe('an invocation the caller stops waiting for', () => {
  it("is cancelled in the agent's page when the caller's page goes", async () => {
    const tab1 = connectPort('https://a.example/page', 1);
    const tab2 = connectPort('https://b.example/page', 2);
    const agentId = await registerHandlerAgent(tab1, 'handler');
    await registerHandlerAgent(tab2, 'invoker');

    tab2.send({ id: 'invoke-c', type: 'agent.agents.invoke', payload: { agentId, request: { task: 'summarize' } } });
    await vi.waitFor(() => expect(tabsSendMessage).toHaveBeenCalled());
    const [, sent] = tabsSendMessage.mock.calls[0] as [number, { invocationId: string }];

    tab2.disconnect();
    await vi.waitFor(() => expect(tabsSendMessage).toHaveBeenCalledWith(1, { type: 'agentInvocationCancel', invocationId: sent.invocationId }));
  });

  it("is cancelled in the agent's page when it times out", async () => {
    vi.useFakeTimers();
    try {
      const tab1 = connectPort('https://a.example/page', 1);
      const tab2 = connectPort('https://b.example/page', 2);
      const agentId = await registerHandlerAgent(tab1, 'handler');
      await registerHandlerAgent(tab2, 'invoker');

      const { settled } = await invokeBelowPagePort(agentId);
      const [, sent] = tabsSendMessage.mock.calls[0] as [number, { invocationId: string }];
      await vi.advanceTimersByTimeAsync(30_000);
      expect((settled()!.result as { error?: { code: string } }).error?.code).toBe('ERR_TIMEOUT');
      expect(tabsSendMessage).toHaveBeenCalledWith(1, { type: 'agentInvocationCancel', invocationId: sent.invocationId });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Harbor's own answers", () => {
  it("carry no provenance when Harbor refused because the agent's page is gone", async () => {
    const tab1 = connectPort('https://a.example/page', 1);
    const tab2 = connectPort('https://b.example/page', 2);
    const agentId = await registerHandlerAgent(tab1, 'handler');
    await registerHandlerAgent(tab2, 'invoker');

    tabUrls.set(1, 'https://evil.example/');
    const { settled } = await invokeBelowPagePort(agentId, undefined, false);
    await vi.waitFor(() => expect(settled()).toBeDefined());
    const result = settled()!.result as { error?: { code: string }; provenance?: unknown };
    expect(result.error?.code).toBe('ERR_AGENT_NOT_FOUND');
    expect(result.provenance).toBeUndefined();
  });

  it("carry provenance when the agent itself answered with an error", async () => {
    const tab1 = connectPort('https://a.example/page', 1);
    const tab2 = connectPort('https://b.example/page', 2);
    const agentId = await registerHandlerAgent(tab1, 'handler');
    await registerHandlerAgent(tab2, 'invoker');

    const { settled } = await invokeBelowPagePort(agentId);
    const [, sent] = tabsSendMessage.mock.calls[0] as [number, { invocationId: string }];
    replyAsContentScript(1, { invocationId: sent.invocationId, success: false, error: { code: 'ERR_HANDLER_FAILED', message: 'no' } });
    await vi.waitFor(() => expect(settled()).toBeDefined());
    expect((settled()!.result as { provenance?: { origin: string } }).provenance?.origin).toBe('https://a.example');
  });
});

describe('agent mail to a page', () => {
  it('names the agent a broadcast is for, so the page can refuse one for an agent it never registered', async () => {
    await grantPermissions('https://a.example', ['agents:message'], 'granted-always');
    const tab1 = connectPort('https://a.example/page', 1);
    const tab3 = connectPort('https://a.example/other', 3);
    const listener = await registerVia(tab1, 'reg-l', { name: 'listener' });
    await registerVia(tab3, 'reg-s', { name: 'sender' });

    tab1.send({ id: 'sub', type: 'agent.agents.subscribe', payload: { eventType: 'news' } });
    await vi.waitFor(() => expect(tab1.posted.some((p) => p.id === 'sub')).toBe(true));
    tab3.send({ id: 'bc', type: 'agent.agents.broadcast', payload: { eventType: 'news', data: 1 } });

    await vi.waitFor(() => expect(tabsSendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
      type: 'agentEvent',
      event: expect.objectContaining({ type: 'broadcast', agentId: listener }),
    })));
  });
});

describe('orchestration page calls', () => {
  it('a pipeline waits past 30 seconds while its steps run', async () => {
    vi.useFakeTimers();
    try {
      await grantPermissions('https://b.example', ['agents:invoke'], 'granted-always');
      const tab1 = connectPort('https://a.example/page', 1);
      const tab2 = connectPort('https://b.example/page', 2);
      const agentId = await registerHandlerAgent(tab1, 'handler');
      await registerHandlerAgent(tab2, 'invoker');

      tab2.send({
        id: 'pipe',
        type: 'agent.agents.orchestrate.pipeline',
        payload: { config: { steps: [{ agentId, task: 'one' }, { agentId, task: 'two' }] }, initialInput: 'x' },
      });
      for (let step = 0; step < 2; step++) {
        await vi.waitFor(() => expect(tabsSendMessage).toHaveBeenCalledTimes(step + 1));
        const [, sent] = tabsSendMessage.mock.calls[step] as [number, { invocationId: string }];
        await vi.advanceTimersByTimeAsync(25_000);
        replyAsContentScript(1, { invocationId: sent.invocationId, success: true, result: `step ${step}` });
        await vi.advanceTimersByTimeAsync(0);
      }
      await vi.waitFor(() => expect(tab2.posted.some((p) => p.id === 'pipe')).toBe(true));
      const reply = tab2.posted.find((p) => p.id === 'pipe')!;
      expect(reply.ok).toBe(true);
      expect((reply.result as { success: boolean }).success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('an invocation whose caller gave up before delivery', () => {
  it('is never sent to the agent page', async () => {
    const tab1 = connectPort('https://a.example/page', 1);
    const agentId = await registerHandlerAgent(tab1, 'handler');
    const { handleIncomingInvocation } = await import('../handlers/agent-handlers');
    const controller = new AbortController();
    controller.abort();
    const result = await handleIncomingInvocation(agentId, { from: 'x', task: 't' }, undefined, controller.signal);
    expect(result.error?.code).toBe('ERR_ABORTED');
    expect(tabsSendMessage).not.toHaveBeenCalled();
  });
});
