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
 * `routeExternalMessage` directly — see the comment there for why.
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
    setMode: vi.fn(),
    recordPrompt: vi.fn(),
    recordToolCall: vi.fn(),
    recordBrowserAccess: vi.fn(),
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
let runtimeMessageListeners: RuntimeMessageListener[];
let tabsSendMessage: ReturnType<typeof vi.fn>;
let grantPermissions: typeof GrantPermissions;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  resetMockBrowser();

  runtimeMessageListeners = [];
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
    onRemoved: { addListener: vi.fn() },
    get: vi.fn(async () => { throw new Error('no tab'); }),
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
  // cross-origin delegation, since the handler (a.example) is a different
  // origin.
  await grantPermissions('https://a.example', ['agents:register'], 'granted-always');
  await grantPermissions('https://b.example', ['agents:register', 'agents:crossOrigin'], 'granted-always');
});

afterEach(() => {
  vi.resetModules();
});

interface TestPort {
  send: (message: unknown) => void;
  posted: Array<{ id?: string; ok: boolean; result?: unknown; error?: { code?: string; message: string } }>;
}

function connectPort(senderUrl: string, tabId: number): TestPort {
  const messageListeners: Array<(m: unknown) => void> = [];
  const posted: TestPort['posted'] = [];
  const port = {
    name: 'harbor-page-api',
    sender: { url: senderUrl, tab: { id: tabId } },
    onMessage: { addListener: (l: (m: unknown) => void) => messageListeners.push(l) },
    onDisconnect: { addListener: () => {} },
    postMessage: (m: TestPort['posted'][number]) => posted.push(m),
  };
  onConnect(port);
  return {
    send: (message: unknown) => messageListeners.forEach((l) => l(message)),
    posted,
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
      // through `routeExternalMessage`, the same production entry point
      // harbor-core.ts's in-process dispatch uses for `agents.*` types (and
      // that a still-installed, separate extension would reach too). The
      // full round trip through tab 2's own port also works (test above),
      // but page-api/harbor-core.ts wraps every page call in its own
      // independent 30-second limit (see harbor-core-timeout.test.ts) that
      // is registered first and so would win this race against the
      // mechanism this test targets — the invocation's own ERR_TIMEOUT,
      // unchanged from before this unit. Calling the same function
      // directly isolates that mechanism.
      const { routeExternalMessage } = await import('../../agents/background-router');
      let settled: { ok: boolean; result?: unknown; error?: string } | undefined;
      routeExternalMessage(
        {
          type: 'agents.invoke',
          payload: {
            agentId: handlerAgentId,
            task: 'summarize',
            origin: 'https://b.example',
            tabId: 2,
          },
        },
        {} as chrome.runtime.MessageSender,
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
