/**
 * Page chat, when the person has an ACP agent selected
 * (docs/ACP_BACKEND_DESIGN.md section 2): the chat runs on that agent
 * instead of Harbor's built-in model. Each open chat gets one agent
 * session, opened lazily on its first message and reused after that
 * (even when two messages arrive together); the session ends on an
 * explicit close, its port disconnecting (a real navigation or reload —
 * not a same-document hash/pushState change), the tab closing outright,
 * and a backend switch — each checked again, not just at the start of a
 * message, since the policy gate and the agent starting can both take a
 * while.
 *
 * Driven through the real message handlers (registerPageChatHandlers,
 * handleChatOpen, handleChatClose), the real policy engine, and a fake ACP
 * bridge whose "agent" side is a real ACP SDK AgentApp — the same pattern
 * page-api/__tests__/acp-text-session.test.ts uses for window.ai text
 * sessions on this backend.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agent as buildAgentApp, AGENT_METHODS, CLIENT_METHODS, type StopReason } from '@agentclientprotocol/sdk';

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

type GrantEffect = 'allow' | 'deny' | null;
let grant: (origin: string, action: string) => GrantEffect;

type MessageListener = (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;

async function setAcpBackend(agentId: string | null) {
  await getMockStorage().local.set({
    harbor_agent_backend: agentId ? { type: 'acp', agentId } : undefined,
  });
}

/**
 * Writes a real `model:prompt` grant to storage, tagged for whichever
 * backend is selected right now (policy/backend-grant.ts) — called after
 * `setAcpBackend()`, not before. This is independent of the test's own
 * origin-grant resolver (`grant`, below): that resolver stands in for the
 * policy engine's Tier 8 when `requireAction` runs, but
 * `AcpTextSession.runOneTurn`'s own `isModelPromptGrantedForAgent` check
 * (page-api/acp-text-session.ts, acp-text-session.test.ts's own
 * "defence in depth" tests) reads the real stored grant directly, the same
 * way agent.run's own tests (acp-model-prompt-agent-policy.test.ts) do.
 */
async function grantModelPrompt(origin = SHOP): Promise<void> {
  const { grantPermissions } = await import('../../policy/permissions');
  await grantPermissions(origin, ['model:prompt'], 'granted-always');
}

/** Sends one `agent_message_chunk` notification before ending the turn, as page-api/__tests__/acp-text-session.test.ts's own `sendsMessageChunk` does. */
function sendsMessageChunk(text: string) {
  return async (promptCtx: {
    params: { sessionId: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: { notify: (method: string, params: unknown) => Promise<void> };
  }) => {
    await promptCtx.client.notify(CLIENT_METHODS.session_update, {
      sessionId: promptCtx.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
    return { stopReason: 'end_turn' as StopReason };
  };
}

function registerFakeAgent(onPrompt: (ctx: {
  params: { sessionId: string; prompt: Array<{ type: string; text: string }> };
}) => Promise<{ stopReason: StopReason }>, onSessionNew?: () => void) {
  const fakeBridge = createFakeAcpBridge();
  mocks.bridge.current = fakeBridge;
  const app = buildAgentApp({ name: 'fake-page-chat-agent' })
    .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
    .onRequest(AGENT_METHODS.session_new, async () => { onSessionNew?.(); return { sessionId: `sess-${Math.random()}` }; })
    .onNotification(AGENT_METHODS.session_cancel, async () => {})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .onRequest(AGENT_METHODS.session_prompt, async (ctx) => onPrompt(ctx as any));
  fakeBridge.registerAgent(AGENT_ID, app, {});
  return fakeBridge;
}

/** An agent whose `initialize` never answers — the channel opens (the bridge reports `open` immediately), but the handshake hangs there. */
function registerHangingAgent() {
  const fakeBridge = createFakeAcpBridge();
  mocks.bridge.current = fakeBridge;
  const app = buildAgentApp({ name: 'hanging-agent' })
    .onRequest(AGENT_METHODS.initialize, () => new Promise(() => { /* never answers */ }))
    .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }))
    .onNotification(AGENT_METHODS.session_cancel, async () => {})
    .onRequest(AGENT_METHODS.session_prompt, async () => ({ stopReason: 'end_turn' as StopReason }));
  fakeBridge.registerAgent(AGENT_ID, app, {});
  return fakeBridge;
}

/** Every slot this site's per-site agent cap has free, right now — acquiring and immediately releasing each one so the count doesn't linger. */
async function freeSlots(origin = SHOP): Promise<number> {
  const { tryAcquireAgentSlot, releaseAgentSlot, PER_SITE_AGENT_LIMIT } = await import('../../page-api/acp-agent-limits');
  let n = 0;
  while (n < PER_SITE_AGENT_LIMIT + 1 && tryAcquireAgentSlot(origin)) n++;
  for (let i = 0; i < n; i++) releaseAgentSlot(origin);
  return n;
}

interface FakePort {
  name: string;
  sender?: { tab?: { id: number }; url?: string };
  onDisconnect: { addListener: (l: () => void) => void };
}

async function setup() {
  const messageListeners: MessageListener[] = [];
  vi.spyOn(chrome.runtime.onMessage, 'addListener').mockImplementation((l) => {
    messageListeners.push(l as MessageListener);
  });
  const tabRemovedListeners: Array<(tabId: number) => void | Promise<void>> = [];
  (chrome as unknown as { tabs: Record<string, unknown> }).tabs = {
    ...(chrome as unknown as { tabs: Record<string, unknown> }).tabs,
    onRemoved: { addListener: (l: (tabId: number) => void | Promise<void>) => tabRemovedListeners.push(l) },
  };
  const connectListeners: Array<(port: FakePort) => void> = [];
  (chrome as unknown as { runtime: Record<string, unknown> }).runtime = {
    ...(chrome as unknown as { runtime: Record<string, unknown> }).runtime,
    onConnect: { addListener: (l: (port: FakePort) => void) => connectListeners.push(l) },
  };
  (chrome as unknown as { scripting: unknown }).scripting = { executeScript: vi.fn(async () => []) };

  vi.resetModules();
  const { Audit } = await import('../../policy/audit');
  const { Policy } = await import('../../policy/store');
  const { setOriginGrantResolver, setWatchdogResolver } = await import('../../policy/engine');
  Policy.__reset();
  Audit.__reset();
  setOriginGrantResolver((origin, action) => {
    const effect = grant(origin, action);
    return effect ? { effect } : null;
  });
  setWatchdogResolver(() => ({ status: 'normal' }));

  const { registerPageChatHandlers } = await import('../page-chat-handlers');
  const { handleChatOpen, handleChatClose } = await import('../../agents/handlers/chat');
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

  async function closeChat(chatId: string, origin = SHOP): Promise<void> {
    await handleChatClose(
      { id: 'close-1', type: 'agent.chat.close', origin, payload: { chatId } } as never,
      { sendResponse: () => {}, sendStreamEvent: () => {} },
    );
  }

  function send(
    chatId: string,
    message = 'What is on sale?',
    sender: unknown = { tab: { id: TAB }, url: `${SHOP}/deals`, frameId: 0 },
  ): Promise<{ ok: boolean; type: string; response?: string; error?: { message: string; code?: string } }> {
    return new Promise((resolve) => {
      let handled = false;
      for (const l of messageListeners) {
        if (l({ type: 'page_chat_message', chatId, message, systemPrompt: 'Shop helper' }, sender, resolve as never) === true) {
          handled = true;
        }
      }
      if (!handled) throw new Error('page_chat_message was not handled');
    });
  }

  function closedViaUi(
    chatId: string,
    sender: unknown = { tab: { id: TAB }, url: `${SHOP}/deals`, frameId: 0 },
  ): Promise<unknown> {
    return new Promise((resolve) => {
      let handled = false;
      for (const l of messageListeners) {
        if (l({ type: 'page_chat_closed', chatId }, sender, resolve as never) === true) handled = true;
      }
      if (!handled) throw new Error('page_chat_closed was not handled');
    });
  }

  function fireTabRemoved(tabId: number): Promise<void> {
    return Promise.all(tabRemovedListeners.map((l) => l(tabId))).then(() => undefined);
  }

  /**
   * Simulates page-chat.ts opening its `harbor-page-chat:<chatId>` port —
   * call once per chat, right after `openChat()`, as the real content
   * script does. Returns a `disconnect()` that simulates the document
   * really going away (a reload or navigation to a new document); a
   * same-document change (a hash or `pushState`) never calls this, which
   * is exactly the point — there's no `tabs.onUpdated` listener left to
   * misfire on one.
   */
  function connectChatPort(
    chatId: string,
    sender: { tabId?: number; url?: string } = { tabId: TAB, url: `${SHOP}/deals` },
  ): { disconnect: () => void } {
    const disconnectListeners: Array<() => void> = [];
    const port: FakePort = {
      name: `harbor-page-chat:${chatId}`,
      sender: { tab: sender.tabId !== undefined ? { id: sender.tabId } : undefined, url: sender.url },
      onDisconnect: { addListener: (l: () => void) => disconnectListeners.push(l) },
    };
    for (const l of connectListeners) l(port);
    return { disconnect: () => { for (const l of disconnectListeners) l(); } };
  }

  function auditRecords() {
    return Audit.list().filter((r) => r.action === 'model.prompt.agent');
  }

  return { openChat, closeChat, send, closedViaUi, fireTabRemoved, connectChatPort, auditRecords, Policy };
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetMockBrowser();
  grant = () => 'allow';
});

describe('page chat on the ACP agent backend', () => {
  it("opens one agent session on the first message, sends the site's systemPrompt once, and reuses the session on a second message", async () => {
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    const prompts: Array<{ blocks: Array<{ type: string; text: string }> }> = [];
    let sessionNewCalls = 0;
    registerFakeAgent(async (ctx) => {
      prompts.push({ blocks: ctx.params.prompt });
      return sendsMessageChunk("there's 20% off the whole catalogue")(ctx as never);
    }, () => { sessionNewCalls++; });

    const { openChat, send } = await setup();
    const chatId = await openChat();

    const first = await send(chatId, 'What is on sale?');
    expect(first).toMatchObject({ ok: true, type: 'page_chat_response', response: "there's 20% off the whole catalogue" });

    const second = await send(chatId, 'Anything cheaper?');
    expect(second).toMatchObject({ ok: true, type: 'page_chat_response' });

    expect(sessionNewCalls).toBe(1);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].blocks.some((b) => b.text.includes('Shop helper'))).toBe(true);
    expect(prompts[1].blocks.some((b) => b.text.includes('Shop helper'))).toBe(false);
    // Harbor's own framing leads the chat's first prompt, and only that one.
    expect(prompts[0].blocks[0].text).toMatch(/working for the person/i);
    expect(prompts[1].blocks.some((b) => /working for the person/i.test(b.text))).toBe(false);
  });

  it('never calls the model, and refuses, when model.prompt.agent is denied by a policy rule', async () => {
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    let promptCalled = false;
    registerFakeAgent(async () => { promptCalled = true; return { stopReason: 'end_turn' }; });

    const { openChat, send, Policy, auditRecords } = await setup();
    const { compileRule } = await import('../../policy/rules');
    Policy.__setForTesting([
      compileRule({ id: 'deny-agent-prompt', effect: 'deny', principal: { origin: '*' }, action: 'model.prompt.agent', source: 'user' } as never),
    ]);
    const chatId = await openChat();

    const response = await send(chatId);

    expect(response).toMatchObject({ ok: false, type: 'error' });
    expect(promptCalled).toBe(false);
    expect(auditRecords().some((r) => r.effect === 'deny')).toBe(true);
  });

  it('ends the agent session on agent.chat.close: a later message opens a fresh session', async () => {
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    let sessionNewCalls = 0;
    const fakeBridge = registerFakeAgent(async () => ({ stopReason: 'end_turn' }), () => { sessionNewCalls++; });
    const closeSpy = vi.spyOn(fakeBridge, 'acpClose');

    const { openChat, closeChat, send } = await setup();
    const chatId = await openChat();
    await send(chatId);
    expect(sessionNewCalls).toBe(1);

    await closeChat(chatId);
    expect(closeSpy).toHaveBeenCalled();

    // The chat itself is gone after an explicit close, so a later message
    // for the same chatId is refused before ever reaching the agent again
    // — same as the built-in path's own "chat not open" refusal.
    const after = await send(chatId);
    expect(after).toMatchObject({ ok: false, type: 'error' });
  });

  it("ends the agent session when the page-chat UI's own close button fires, without a separate agent.chat.close", async () => {
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    let sessionNewCalls = 0;
    const fakeBridge = registerFakeAgent(async () => ({ stopReason: 'end_turn' }), () => { sessionNewCalls++; });
    const closeSpy = vi.spyOn(fakeBridge, 'acpClose');

    const { openChat, send, closedViaUi } = await setup();
    const chatId = await openChat();
    await send(chatId);
    expect(sessionNewCalls).toBe(1);

    await closedViaUi(chatId);
    expect(closeSpy).toHaveBeenCalled();

    // The chat is still "open" in Harbor's own registry (only the agent
    // session ended) — a later message reopens a fresh agent session.
    await send(chatId);
    expect(sessionNewCalls).toBe(2);
  });

  it('ends the agent session when the tab closes', async () => {
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    let sessionNewCalls = 0;
    const fakeBridge = registerFakeAgent(async () => ({ stopReason: 'end_turn' }), () => { sessionNewCalls++; });
    const closeSpy = vi.spyOn(fakeBridge, 'acpClose');

    const { openChat, send, fireTabRemoved } = await setup();
    const chatId = await openChat();
    await send(chatId);
    expect(sessionNewCalls).toBe(1);

    await fireTabRemoved(TAB);
    expect(closeSpy).toHaveBeenCalled();
  });

  it('keeps the chat through a same-document change (a hash or pushState) — nothing disconnects its port for one', async () => {
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    let sessionNewCalls = 0;
    const fakeBridge = registerFakeAgent(async () => ({ stopReason: 'end_turn' }), () => { sessionNewCalls++; });
    const closeSpy = vi.spyOn(fakeBridge, 'acpClose');

    const { openChat, send, connectChatPort } = await setup();
    const chatId = await openChat();
    connectChatPort(chatId);
    await send(chatId);
    expect(sessionNewCalls).toBe(1);

    // A hash change or pushState never touches the port — there's nothing
    // left in the implementation that would react to one (the old
    // tabs.onUpdated `url` listener, which fired for these too, is gone).
    // The chat and its session are still live.
    const second = await send(chatId, 'still there?');
    expect(second).toMatchObject({ ok: true });
    expect(sessionNewCalls).toBe(1);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("ends the agent session when its port disconnects (a real navigation or reload)", async () => {
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    let sessionNewCalls = 0;
    const fakeBridge = registerFakeAgent(async () => ({ stopReason: 'end_turn' }), () => { sessionNewCalls++; });
    const closeSpy = vi.spyOn(fakeBridge, 'acpClose');

    const { openChat, send, connectChatPort } = await setup();
    const chatId = await openChat();
    const port = connectChatPort(chatId);
    await send(chatId);
    expect(sessionNewCalls).toBe(1);

    port.disconnect();
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled());

    // The registry entry is gone too, not just the agent session — a
    // later message for the same chatId is refused.
    const after = await send(chatId);
    expect(after).toMatchObject({ ok: false, type: 'error' });
  });

  it("ignores a port named for a chatId it doesn't actually own (wrong tab or origin)", async () => {
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    registerFakeAgent(async () => ({ stopReason: 'end_turn' }));

    const { openChat, send, connectChatPort } = await setup();
    const chatId = await openChat();
    await send(chatId);

    // A forged port, named after a real chatId, from the wrong tab or a
    // different origin — its disconnect must not end this chat.
    const wrongTab = connectChatPort(chatId, { tabId: TAB + 1, url: `${SHOP}/deals` });
    const wrongOrigin = connectChatPort(chatId, { tabId: TAB, url: 'https://evil.example/' });
    wrongTab.disconnect();
    wrongOrigin.disconnect();

    const stillThere = await send(chatId);
    expect(stillThere).toMatchObject({ ok: true });
  });

  it('ends every live page-chat agent session when the backend switches', async () => {
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    let sessionNewCalls = 0;
    const fakeBridge = registerFakeAgent(async () => ({ stopReason: 'end_turn' }), () => { sessionNewCalls++; });
    const closeSpy = vi.spyOn(fakeBridge, 'acpClose');

    const { openChat, send } = await setup();
    const chatId = await openChat();
    await send(chatId);
    expect(sessionNewCalls).toBe(1);

    await setAcpBackend('a-different-agent');
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled());
  });

  it('provenance _meta on the wire says page-chat, not website', async () => {
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    const metas: unknown[] = [];
    registerFakeAgent(async (ctx) => {
      metas.push((ctx.params as unknown as { _meta: unknown })._meta);
      return { stopReason: 'end_turn' };
    });

    const { openChat, send } = await setup();
    const chatId = await openChat();
    await send(chatId);

    expect(metas[0]).toEqual({ 'harbor/provenance': { source: 'page-chat', origin: SHOP } });
  });

  it("a cross-origin agent.chat.close is refused, and the chat's agent session survives it", async () => {
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    const fakeBridge = registerFakeAgent(async () => ({ stopReason: 'end_turn' }));
    const closeSpy = vi.spyOn(fakeBridge, 'acpClose');

    const { openChat, closeChat, send } = await setup();
    const chatId = await openChat();
    await send(chatId);

    await closeChat(chatId, 'https://evil.example');

    expect(closeSpy).not.toHaveBeenCalled();
    const after = await send(chatId);
    expect(after).toMatchObject({ ok: true });
  });

  it('page_chat_closed is ignored from the wrong origin or the wrong tab, and only closes from the right one', async () => {
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    const fakeBridge = registerFakeAgent(async () => ({ stopReason: 'end_turn' }));
    const closeSpy = vi.spyOn(fakeBridge, 'acpClose');

    const { openChat, send, closedViaUi } = await setup();
    const chatId = await openChat();
    await send(chatId);

    await closedViaUi(chatId, { tab: { id: TAB }, url: 'https://evil.example/', frameId: 0 });
    await closedViaUi(chatId, { tab: { id: TAB + 1 }, url: `${SHOP}/deals`, frameId: 0 });
    await closedViaUi(chatId, { url: `${SHOP}/deals` }); // no tab at all
    expect(closeSpy).not.toHaveBeenCalled();

    await closedViaUi(chatId, { tab: { id: TAB }, url: `${SHOP}/other`, frameId: 0 });
    expect(closeSpy).toHaveBeenCalled();
  });

  it("closing every chat for an origin (agent.chat.close with no chatId) ends every one of that origin's agent sessions", async () => {
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    const fakeBridge = registerFakeAgent(async () => ({ stopReason: 'end_turn' }));
    const closeSpy = vi.spyOn(fakeBridge, 'acpClose');

    const { openChat, send } = await setup();
    const { handleChatClose } = await import('../../agents/handlers/chat');
    const chatA = await openChat(SHOP, TAB);
    const chatB = await openChat(SHOP, TAB + 1);
    await send(chatA, 'hi', { tab: { id: TAB }, url: `${SHOP}/deals`, frameId: 0 });
    await send(chatB, 'hi', { tab: { id: TAB + 1 }, url: `${SHOP}/deals`, frameId: 0 });

    await handleChatClose(
      { id: 'close-all', type: 'agent.chat.close', origin: SHOP, payload: {} } as never,
      { sendResponse: () => {}, sendStreamEvent: () => {} },
    );

    expect(closeSpy).toHaveBeenCalledTimes(2);
  });

  it('two simultaneous first messages on one chat share one agent session, and one close frees its slot', async () => {
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    let sessionNewCalls = 0;
    const fakeBridge = registerFakeAgent(async () => ({ stopReason: 'end_turn' }), () => { sessionNewCalls++; });
    const closeSpy = vi.spyOn(fakeBridge, 'acpClose');

    const { openChat, closeChat, send } = await setup();
    const chatId = await openChat();

    const [a, b] = await Promise.all([send(chatId, 'one'), send(chatId, 'two')]);
    expect(a.ok && b.ok).toBe(true);
    expect(sessionNewCalls).toBe(1);

    await closeChat(chatId);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    const { tryAcquireAgentSlot, releaseAgentSlot, PER_SITE_AGENT_LIMIT } = await import('../../page-api/acp-agent-limits');
    let freed = 0;
    while (freed < PER_SITE_AGENT_LIMIT && tryAcquireAgentSlot(SHOP)) freed++;
    expect(freed).toBe(PER_SITE_AGENT_LIMIT);
    for (let i = 0; i < freed; i++) releaseAgentSlot(SHOP);
  });

  it('closing the chat while a message is between its policy gate and opening the session leaves no session and frees the slot', async () => {
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    let sessionNewCalls = 0;
    let promptCalls = 0;
    const fakeBridge = registerFakeAgent(async () => { promptCalls++; return { stopReason: 'end_turn' }; }, () => { sessionNewCalls++; });
    const closeSpy = vi.spyOn(fakeBridge, 'acpClose');

    const { openChat, closeChat, send } = await setup();
    const chatId = await openChat();

    const pending = send(chatId);
    await closeChat(chatId);
    const res = await pending;

    expect(res).toMatchObject({ ok: false, type: 'error' });
    expect(sessionNewCalls).toBe(0);
    expect(promptCalls).toBe(0);

    const { tryAcquireAgentSlot, releaseAgentSlot, PER_SITE_AGENT_LIMIT } = await import('../../page-api/acp-agent-limits');
    let freed = 0;
    while (freed < PER_SITE_AGENT_LIMIT && tryAcquireAgentSlot(SHOP)) freed++;
    expect(freed).toBe(PER_SITE_AGENT_LIMIT);
    for (let i = 0; i < freed; i++) releaseAgentSlot(SHOP);
  });

  it('a port disconnecting (navigation) while a message is gated leaves no session and frees the slot', async () => {
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    let sessionNewCalls = 0;
    const fakeBridge = registerFakeAgent(async () => ({ stopReason: 'end_turn' }), () => { sessionNewCalls++; });
    const closeSpy = vi.spyOn(fakeBridge, 'acpClose');

    const { openChat, send, connectChatPort } = await setup();
    const chatId = await openChat();
    const port = connectChatPort(chatId);

    const pending = send(chatId);
    port.disconnect();
    const res = await pending;

    expect(res).toMatchObject({ ok: false, type: 'error' });
    expect(sessionNewCalls).toBe(0);

    const { tryAcquireAgentSlot, releaseAgentSlot, PER_SITE_AGENT_LIMIT } = await import('../../page-api/acp-agent-limits');
    let freed = 0;
    while (freed < PER_SITE_AGENT_LIMIT && tryAcquireAgentSlot(SHOP)) freed++;
    expect(freed).toBe(PER_SITE_AGENT_LIMIT);
    for (let i = 0; i < freed; i++) releaseAgentSlot(SHOP);
    void closeSpy;
  });

  it('a backend switch while a message is gated leaves no session on the old agent', async () => {
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    let sessionNewCalls = 0;
    const fakeBridge = registerFakeAgent(async () => ({ stopReason: 'end_turn' }), () => { sessionNewCalls++; });

    const { openChat, send } = await setup();
    const chatId = await openChat();

    const pending = send(chatId);
    await setAcpBackend('a-different-agent');
    const res = await pending;
    await new Promise((r) => setTimeout(r, 20));

    expect(res).toMatchObject({ ok: false, type: 'error' });
    expect(sessionNewCalls).toBe(0);
  });

  describe('closing a chat whose session is still opening cancels the open, instead of waiting for it', () => {
    it('agent.chat.close on a never-answering agent: acpClose once, the slot freed, close returns promptly, and the pending message is rejected', async () => {
      await setAcpBackend(AGENT_ID);
      await grantModelPrompt();
      const fakeBridge = registerHangingAgent();
      const closeSpy = vi.spyOn(fakeBridge, 'acpClose');

      const { openChat, closeChat, send } = await setup();
      const chatId = await openChat();

      let settled: { ok: boolean } | 'pending' = 'pending';
      const pending = send(chatId).then((r) => { settled = r; return r; });
      await new Promise((r) => setTimeout(r, 20));

      const closeStarted = Date.now();
      await closeChat(chatId);
      const closeTookMs = Date.now() - closeStarted;

      expect(closeTookMs).toBeLessThan(1000);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(await freeSlots()).toBe((await import('../../page-api/acp-agent-limits')).PER_SITE_AGENT_LIMIT);

      const res = await pending;
      expect(res).toMatchObject({ ok: false });
      expect(settled).not.toBe('pending');
    });

    it("a port disconnecting (navigation) on a never-answering agent: acpClose once, the slot freed", async () => {
      await setAcpBackend(AGENT_ID);
      await grantModelPrompt();
      const fakeBridge = registerHangingAgent();
      const closeSpy = vi.spyOn(fakeBridge, 'acpClose');

      const { openChat, send, connectChatPort } = await setup();
      const chatId = await openChat();
      const port = connectChatPort(chatId);

      const pending = send(chatId);
      await new Promise((r) => setTimeout(r, 20));
      port.disconnect();

      const res = await pending;
      expect(res).toMatchObject({ ok: false });
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(await freeSlots()).toBe((await import('../../page-api/acp-agent-limits')).PER_SITE_AGENT_LIMIT);
    });

    it('an agent that eventually answers after the chat was already closed leaves no session and no held slot', async () => {
      await setAcpBackend(AGENT_ID);
      await grantModelPrompt();
      const fakeBridge = createFakeAcpBridge();
      mocks.bridge.current = fakeBridge;
      let releaseInit: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { releaseInit = resolve; });
      const app = buildAgentApp({ name: 'slow-agent' })
        .onRequest(AGENT_METHODS.initialize, async () => { await gate; return { protocolVersion: 1 }; })
        .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }))
        .onNotification(AGENT_METHODS.session_cancel, async () => {})
        .onRequest(AGENT_METHODS.session_prompt, async () => ({ stopReason: 'end_turn' as StopReason }));
      fakeBridge.registerAgent(AGENT_ID, app, {});
      const closeSpy = vi.spyOn(fakeBridge, 'acpClose');

      const { openChat, closeChat, send } = await setup();
      const chatId = await openChat();

      const pending = send(chatId);
      await new Promise((r) => setTimeout(r, 20));
      await closeChat(chatId);
      // The agent finally answers, well after the chat (and its session)
      // were already torn down.
      releaseInit?.();
      const res = await pending;

      expect(res).toMatchObject({ ok: false });
      expect(await freeSlots()).toBe((await import('../../page-api/acp-agent-limits')).PER_SITE_AGENT_LIMIT);
      // Only closed once, regardless of the agent's late answer.
      expect(closeSpy.mock.calls.length).toBeLessThanOrEqual(1);
    });
  });

  it('a chat dropped from the registry while its session is still (successfully) opening is still caught, after the open, before the agent is prompted', async () => {
    // Drops the chat's *registry* entry directly (chat.ts's own
    // forgetChat), not through closeAgentChatSession — so nothing aborts
    // the still-opening session; it finishes opening normally. This
    // isolates the after-open re-check (page-chat-handlers.ts) from the
    // close-cancellation path above: removing that re-check, specifically,
    // would let this message reach the agent even though its chat is
    // already gone.
    await setAcpBackend(AGENT_ID);
    await grantModelPrompt();
    let promptCalled = false;
    let chatIdRef = '';
    registerFakeAgent(async () => { promptCalled = true; return { stopReason: 'end_turn' }; }, () => {
      void import('../../agents/handlers/chat').then(({ forgetChat }) => forgetChat(chatIdRef));
    });

    const { openChat, send } = await setup();
    const chatId = await openChat();
    chatIdRef = chatId;

    const res = await send(chatId);

    expect(res).toMatchObject({ ok: false, type: 'error', error: { message: 'This chat is not open on this page' } });
    expect(promptCalled).toBe(false);
  });
});
