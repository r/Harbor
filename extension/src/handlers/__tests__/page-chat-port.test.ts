/**
 * page-chat.ts's own half of the `harbor-page-chat:<chatId>` port
 * (page-chat-handlers.ts holds the other half; see that module's own
 * tests for its side of the wiring in isolation). This drives
 * `connectPageChatPort` — the one piece of page-chat.ts pulled out of its
 * DOM-heavy `initPageChat()` specifically so it's testable without a real
 * DOM (there's no jsdom in this project) — end to end: the content
 * script's own `runtime.connect` call reaches the background's
 * `runtime.onConnect` listener, and disconnecting the content-side port
 * handle (what a real navigation or reload does) ends the chat's agent
 * session, through the real handlers and a fake ACP bridge whose "agent"
 * side is a real ACP SDK AgentApp, the same pattern
 * page-chat-acp.test.ts uses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agent as buildAgentApp, AGENT_METHODS, type StopReason } from '@agentclientprotocol/sdk';

import { resetMockBrowser, getMockStorage } from '../../__tests__/test-setup';
import { createFakeAcpBridge } from '../../page-api/__tests__/support/fake-acp-bridge';

const mocks = vi.hoisted(() => ({
  bridge: { current: null as null | ReturnType<typeof import('../../page-api/__tests__/support/fake-acp-bridge').createFakeAcpBridge> },
}));

vi.mock('../../page-api/harbor-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../page-api/harbor-core')>()),
  acpOpenStream: (agentId: string, workspace: string) => mocks.bridge.current!.acpOpenStream(agentId, workspace),
  acpSend: (channel: string, message: unknown) => mocks.bridge.current!.acpSend(channel, message),
  acpClose: (channel: string) => mocks.bridge.current!.acpClose(channel),
}));

const SHOP = 'https://shop.example';
const TAB = 7;
const AGENT_ID = 'test-agent';

type MessageListener = (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;

interface FakePort {
  name: string;
  sender?: { tab?: { id: number }; url?: string };
  onDisconnect: { addListener: (l: () => void) => void };
}

/** The content-side handle `connectPageChatPort` returns — what page-chat.ts itself holds. */
interface FakeContentPort {
  name: string;
  disconnect: () => void;
}

async function setAcpBackend(agentId: string | null) {
  await getMockStorage().local.set({
    harbor_agent_backend: agentId ? { type: 'acp', agentId } : undefined,
  });
}

async function grantModelPrompt(origin = SHOP): Promise<void> {
  const { grantPermissions } = await import('../../policy/permissions');
  await grantPermissions(origin, ['model:prompt'], 'granted-always');
}

function registerFakeAgent(onPrompt: (ctx: unknown) => Promise<{ stopReason: StopReason }>) {
  const fakeBridge = createFakeAcpBridge();
  mocks.bridge.current = fakeBridge;
  const app = buildAgentApp({ name: 'fake-page-chat-agent' })
    .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
    .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: `sess-${Math.random()}` }))
    .onNotification(AGENT_METHODS.session_cancel, async () => {})
    .onRequest(AGENT_METHODS.session_prompt, async (ctx) => onPrompt(ctx));
  fakeBridge.registerAgent(AGENT_ID, app, {});
  return fakeBridge;
}

async function setup() {
  const messageListeners: MessageListener[] = [];
  vi.spyOn(chrome.runtime.onMessage, 'addListener').mockImplementation((l) => {
    messageListeners.push(l as MessageListener);
  });
  (chrome as unknown as { tabs: Record<string, unknown> }).tabs = {
    ...(chrome as unknown as { tabs: Record<string, unknown> }).tabs,
    onRemoved: { addListener: () => {} },
  };
  (chrome as unknown as { scripting: unknown }).scripting = { executeScript: vi.fn(async () => []) };

  // Wires a real round trip for `runtime.connect`/`onConnect`: calling
  // `chrome.runtime.connect({ name })` (what `connectPageChatPort`, the
  // content-script side, does) synthesizes the matching background-side
  // port and hands it to every registered `onConnect` listener — exactly
  // as the real browser does when a content script opens a port — and
  // returns a content-side handle whose own `disconnect()` fires that
  // background-side port's `onDisconnect` listeners, the same way a real
  // navigation or reload tearing down the content script's connection
  // does.
  const connectListeners: Array<(port: FakePort) => void> = [];
  const connect = (connectInfo: { name: string }): FakeContentPort => {
    const disconnectListeners: Array<() => void> = [];
    const backgroundPort: FakePort = {
      name: connectInfo.name,
      sender: { tab: { id: TAB }, url: `${SHOP}/deals` },
      onDisconnect: { addListener: (l: () => void) => disconnectListeners.push(l) },
    };
    for (const l of connectListeners) l(backgroundPort);
    return {
      name: connectInfo.name,
      disconnect: () => { for (const l of disconnectListeners) l(); },
    };
  };
  (chrome as unknown as { runtime: Record<string, unknown> }).runtime = {
    ...(chrome as unknown as { runtime: Record<string, unknown> }).runtime,
    onConnect: { addListener: (l: (port: FakePort) => void) => connectListeners.push(l) },
    connect,
  };

  vi.resetModules();
  const { setOriginGrantResolver, setWatchdogResolver } = await import('../../policy/engine');
  const { Policy } = await import('../../policy/store');
  const { Audit } = await import('../../policy/audit');
  Policy.__reset();
  Audit.__reset();
  setOriginGrantResolver(() => ({ effect: 'allow' }));
  setWatchdogResolver(() => ({ status: 'normal' }));

  const { registerPageChatHandlers } = await import('../page-chat-handlers');
  const { handleChatOpen } = await import('../../agents/handlers/chat');
  registerPageChatHandlers();

  async function openChat(origin = SHOP, tabId = TAB): Promise<string> {
    let result: { ok: boolean; result?: { chatId: string } } | undefined;
    await handleChatOpen(
      { id: 'open-1', type: 'agent.chat.open', origin, tabId, payload: { systemPrompt: 'Shop helper' } } as never,
      { sendResponse: (r: unknown) => { result = r as typeof result; }, sendStreamEvent: () => {} },
    );
    if (!result?.ok || !result.result) throw new Error(`chat.open failed: ${JSON.stringify(result)}`);
    return result.result.chatId;
  }

  function send(chatId: string): Promise<{ ok: boolean; type: string }> {
    return new Promise((resolve) => {
      let handled = false;
      for (const l of messageListeners) {
        if (l(
          { type: 'page_chat_message', chatId, message: 'hi', systemPrompt: 'Shop helper' },
          { tab: { id: TAB }, url: `${SHOP}/deals`, frameId: 0 },
          resolve as never,
        ) === true) handled = true;
      }
      if (!handled) throw new Error('page_chat_message was not handled');
    });
  }

  return { openChat, send };
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetMockBrowser();
});

/**
 * A deliberately minimal "crash dummy" DOM: this project has no jsdom, so
 * `initPageChat()`'s own DOM-heavy UI construction can't run against a
 * real one. Every element it touches is one of these: any property read
 * or method call on it returns another dummy (or '' where something is
 * coerced to a string/number), and every property write is accepted
 * silently. It's not a faithful DOM — nothing it does is observable —
 * it only exists so `initPageChat()` runs to completion without
 * throwing, so the one real, non-dummied effect in this test (page-chat.ts's
 * own `connectPageChatPort` call, which reaches the real, mocked
 * `browserAPI.runtime.connect`) can be observed.
 */
function makeDummy(): unknown {
  const target = Object.assign(function dummy(): unknown { return makeDummy(); }, {
    toString: () => '',
    valueOf: () => '',
  });
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'then' || prop === Symbol.toPrimitive) return undefined;
      if (prop in t) return Reflect.get(t, prop);
      return makeDummy();
    },
    set() { return true; },
  });
}

/** Loads page-chat.ts fresh, with `window.__harborPageChatConfig` set and a crash-dummy `document`/`window`, so `initPageChat()` runs its real BYOC-mode body (including the port-connect call) without a real DOM. */
async function loadPageChatAgainstDummyDom(config: { chatId: string }): Promise<void> {
  let injectedOnce = false;
  const fakeDocument = {
    getElementById: (id: string) => {
      if (id === 'harbor-page-chat' && !injectedOnce) { injectedOnce = true; return null; }
      return makeDummy();
    },
    createElement: () => makeDummy(),
    body: makeDummy(),
    head: makeDummy(),
    title: 'Test Page',
    querySelector: () => makeDummy(),
    querySelectorAll: () => [],
  };
  const fakeWindow = {
    __harborPageChatConfig: config,
    location: { href: `${SHOP}/deals`, hostname: 'shop.example' },
    getComputedStyle: () => makeDummy(),
  };
  vi.stubGlobal('document', fakeDocument);
  vi.stubGlobal('window', fakeWindow);
  try {
    await import('../../page-chat');
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("page-chat.ts's own port, end to end with the background", () => {
  it("initPageChat() itself, in BYOC mode, opens the chat's port — not just connectPageChatPort called directly", async () => {
    await setup();
    const connectSpy = vi.spyOn(chrome.runtime as unknown as { connect: (i: { name: string }) => unknown }, 'connect');

    await loadPageChatAgainstDummyDom({ chatId: 'chat-byoc-1' });

    expect(connectSpy).toHaveBeenCalledWith({ name: 'harbor-page-chat:chat-byoc-1' });
  });

  it('connectPageChatPort opens harbor-page-chat:<chatId>, reaching the background\'s onConnect listener', async () => {
    await setup();
    const { connectPageChatPort } = await import('../../page-chat-port');

    const port = connectPageChatPort('chat-123');

    expect(port.name).toBe('harbor-page-chat:chat-123');
  });

  it("disconnecting the content-side port ends the chat's agent session, the same as a real navigation or reload", async () => {
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    const fakeBridge = registerFakeAgent(async () => ({ stopReason: 'end_turn' }));
    const closeSpy = vi.spyOn(fakeBridge, 'acpClose');

    const { openChat, send } = await setup();
    const chatId = await openChat();
    const { connectPageChatPort } = await import('../../page-chat-port');
    const port = connectPageChatPort(chatId);

    await send(chatId);
    expect(closeSpy).not.toHaveBeenCalled();

    port.disconnect();

    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled());

    const after = await send(chatId);
    expect(after).toMatchObject({ ok: false, type: 'error' });
  });
});
