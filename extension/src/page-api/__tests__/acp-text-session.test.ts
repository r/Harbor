import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent as buildAgentApp, AGENT_METHODS, CLIENT_METHODS, type AgentApp, type StopReason } from '@agentclientprotocol/sdk';

// window.ai text sessions (ai.createTextSession / ai.languageModel.create,
// session.prompt / session.promptStreaming, session.destroy) run on the
// user's own ACP agent when `harbor_agent_backend` names one, instead of
// Harbor's built-in llm.chat — see docs/ACP_BACKEND_DESIGN.md section 2 and
// the HBR-82 brief. These drive ai-handlers.ts's handlers directly for
// create/prompt/destroy (as session-prompt-origin.test.ts and
// explicit-session-streaming.test.ts already do for this file), and the
// real background.ts port listener for session.promptStreaming, a tab
// closing, and destroy racing a streaming prompt — the same pattern
// acp-backend-selection.test.ts and agent-run-abort.test.ts use for
// agent.run's cancellation paths — against a fake bridge whose "agent" side
// is a real ACP SDK AgentApp (support/fake-acp-bridge.ts), so these tests
// speak genuine ACP JSON-RPC, not a hand-rolled stand-in.

const mocks = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  askAgentQuestion: vi.fn(),
  getFeatureFlags: vi.fn(),
  bridge: { current: null as null | ReturnType<typeof import('./support/fake-acp-bridge').createFakeAcpBridge> },
}));

vi.mock('../harbor-core', () => ({
  harborRequest: vi.fn(async () => ({ bridgeReady: true })),
  harborStreamRequest: vi.fn(),
  acpOpenStream: (agentId: string, workspace: string) => mocks.bridge.current!.acpOpenStream(agentId, workspace),
  acpSend: (channel: string, message: unknown) => mocks.bridge.current!.acpSend(channel, message),
  acpClose: (channel: string) => mocks.bridge.current!.acpClose(channel),
}));
vi.mock('../handlers/permission-handlers', async (importOriginal) => ({
  ...(await importOriginal<object>()), hasPermission: mocks.hasPermission,
}));
vi.mock('../policy/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../policy/feature-flags')>()),
  getFeatureFlags: mocks.getFeatureFlags,
}));
// The dialog itself is covered without a fake agent in agent-question.test.ts;
// here the whole module is mocked at this seam so these tests can drive what
// it resolves with, exactly as acp-backend.test.ts does for agent.run.
vi.mock('../agent-question', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-question')>()),
  askAgentQuestion: mocks.askAgentQuestion,
}));
// background.ts's own barrel import, used only for the real-port-listener
// tests below (promptStreaming, tab close, destroy racing a stream). The
// ACP-specific pieces (ai-handlers.ts's handleAiCreateTextSession etc.) are
// real; everything unrelated is stubbed the way explicit-session-streaming.test.ts
// stubs it for the same file.
vi.mock('../handlers', async () => {
  const ai = await vi.importActual<typeof import('../handlers/ai-handlers')>('../handlers/ai-handlers');
  return {
    routeMessage: vi.fn(), isStreamingMessage: vi.fn(), hasPermission: mocks.hasPermission,
    getPermissions: async () => ({ scopes: {}, allowedTools: [] }),
    resolveTextSession: ai.resolveTextSession,
    recordExplicitPrompt: ai.recordExplicitPrompt,
    forgetTextSession: ai.forgetTextSession,
    restoreSpawnedTabs: vi.fn(), handleTabRemoved: vi.fn(), getAllSpawnedTabs: vi.fn(() => ({})),
    isSpawnedTab: vi.fn(), handleIncomingInvocation: vi.fn(), resolveInvocationResponse: vi.fn(),
    cleanupAgentsForTab: vi.fn(), agentInvocationTabs: new Map(),
  };
});

import { createFakeAcpBridge } from './support/fake-acp-bridge';
import { getMockStorage, resetMockBrowser } from '../../__tests__/test-setup';
import { DEFAULT_FLAGS } from '../policy/feature-flag-set';
import type { RequestContext } from '../handlers/types';

const AGENT_ID = 'text-agent';
const ORIGIN = 'https://example.test';

function ctx(type: string, payload: unknown, overrides: Partial<RequestContext> = {}): RequestContext {
  return { id: `req-${type}`, type, origin: ORIGIN, tabId: 1, payload, ...overrides } as RequestContext;
}

async function setAcpBackend(agentId: string | null) {
  await getMockStorage().local.set({
    harbor_agent_backend: agentId ? { type: 'acp', agentId } : undefined,
  });
}

interface FakeAgentOptions {
  cwd?: string;
  onSessionNew?: (params: unknown) => void;
  onPrompt: (ctx: {
    params: { sessionId: string; prompt: Array<{ type: string; text: string }>; _meta?: unknown };
    client: { notify: (method: string, params: unknown) => Promise<void>; request: (method: string, params: unknown, options?: unknown) => Promise<unknown> };
  }) => Promise<{ stopReason: StopReason }>;
}

function buildFakeAgent(opts: FakeAgentOptions): AgentApp {
  return buildAgentApp({ name: 'fake-text-agent' })
    .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
    .onRequest(AGENT_METHODS.session_new, async (ctx) => {
      opts.onSessionNew?.(ctx.params);
      return { sessionId: 'sess-1' };
    })
    .onNotification(AGENT_METHODS.session_cancel, async () => {})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .onRequest(AGENT_METHODS.session_prompt, async (ctx) => opts.onPrompt(ctx as any));
}

function registerFakeAgent(opts: FakeAgentOptions) {
  const fakeBridge = createFakeAcpBridge();
  mocks.bridge.current = fakeBridge;
  fakeBridge.registerAgent(AGENT_ID, buildFakeAgent(opts), { cwd: opts.cwd });
  return fakeBridge;
}

function sendsMessageChunk(text: string) {
  return async (promptCtx: { params: { sessionId: string } }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (promptCtx as any).client.notify(CLIENT_METHODS.session_update, {
      sessionId: promptCtx.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
    return { stopReason: 'end_turn' as StopReason };
  };
}

let ai: typeof import('../handlers/ai-handlers');
let onConnectListener: (port: unknown) => void;
let onTabRemovedListener: (tabId: number) => Promise<void>;
let nextTabId = 100;

/**
 * Opens a fresh port, as a real content script would — the module graph
 * (ai-handlers.ts's session map, the ACP registry, background.ts's own
 * listeners) is set up once for the whole file in `beforeAll`, below, not
 * reset per test: resetting it per test would make background.ts's
 * `vi.mock('../handlers', ...)` factory (which calls `vi.importActual` to
 * get the real ai-handlers.ts) re-resolve to a *different* module instance
 * than this file's own `ai` import, so a session created directly through
 * `ai.handleAiCreateTextSession` would be invisible to the real port
 * listener's `resolveTextSession` — same bug class as the "test a new
 * page-call message type through harbor-core's dispatch, not the router
 * directly" pitfall in docs/agent-workflow.md, one layer further down.
 * Each test instead gets its own tab id and its own port.
 */
function connectPort(origin = ORIGIN): { receive: (m: unknown) => Promise<void>; postMessage: ReturnType<typeof vi.fn>; tabId: number } {
  const tabId = nextTabId++;
  let receiveFn: (m: unknown) => Promise<void> = async () => {};
  const postMessage = vi.fn();
  onConnectListener({
    name: 'harbor-page-api', sender: { url: `${origin}/page`, tab: { id: tabId } }, postMessage,
    onMessage: { addListener: (l: typeof receiveFn) => { receiveFn = l; } },
    onDisconnect: { addListener: () => {} },
  });
  return { receive: (m: unknown) => receiveFn(m), postMessage, tabId };
}

beforeAll(async () => {
  const onConnect = { addListener: vi.fn() };
  const onTabRemoved = { addListener: vi.fn() };
  vi.stubGlobal('chrome', {
    storage: getMockStorage(),
    tabs: { onRemoved: onTabRemoved },
    windows: { onRemoved: { addListener: vi.fn() } },
    runtime: { onConnect, onMessage: { addListener: vi.fn() }, onMessageExternal: { addListener: vi.fn() } },
  });
  const { initializePageApi } = await import('../background');
  initializePageApi();
  ai = await import('../handlers/ai-handlers');
  onConnectListener = onConnect.addListener.mock.calls[0][0] as typeof onConnectListener;
  onTabRemovedListener = onTabRemoved.addListener.mock.calls[0][0] as typeof onTabRemovedListener;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasPermission.mockResolvedValue(true);
  mocks.askAgentQuestion.mockReset();
  mocks.getFeatureFlags.mockResolvedValue(DEFAULT_FLAGS);
  mocks.bridge.current = createFakeAcpBridge();
  resetMockBrowser();
});

afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('backend selection for window.ai text sessions', () => {
  it('uses the built-in backend when no setting is stored', async () => {
    const { harborRequest } = await import('../harbor-core');
    (harborRequest as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
      if (method === 'llm.chat') return { content: 'built-in answer' };
      throw new Error(`unexpected ${method}`);
    });

    const created = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', {}));
    const sessionId = (created as { result: string }).result;
    const res = await ai.handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'hi' }));
    expect(res).toMatchObject({ ok: true, result: 'built-in answer' });
  });

  it('opens an ACP session when the setting names one, and the page never sees the agent id', async () => {
    await setAcpBackend(AGENT_ID);
    registerFakeAgent({ onPrompt: sendsMessageChunk('hello from the agent') });

    const created = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', {}));
    expect(created.ok).toBe(true);
    const sessionId = (created as { result: string }).result;
    const res = await ai.handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'hi' }));
    expect(res).toMatchObject({ ok: true, result: 'hello from the agent' });
  });
});

describe('create, then a multi-turn prompt reusing the same ACP session', () => {
  it('sends systemPrompt only on the first prompt, and provenance on every prompt', async () => {
    await setAcpBackend(AGENT_ID);
    const prompts: Array<{ blocks: Array<{ type: string; text: string }>; meta: unknown }> = [];
    registerFakeAgent({
      onPrompt: async (promptCtx) => {
        prompts.push({ blocks: promptCtx.params.prompt, meta: promptCtx.params._meta });
        return { stopReason: 'end_turn' };
      },
    });

    const created = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', { systemPrompt: 'Be terse.' }));
    const sessionId = (created as { result: string }).result;

    await ai.handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'first' }));
    await ai.handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'second' }));

    expect(prompts).toHaveLength(2);
    expect(prompts[0].blocks.map((b) => b.text)).toEqual([
      expect.stringContaining('Instructions from https://example.test:'),
      'first',
    ]);
    expect(prompts[0].blocks.some((b) => b.text.includes('Be terse.'))).toBe(true);
    expect(prompts[1].blocks.map((b) => b.text)).toEqual(['second']);

    for (const p of prompts) {
      expect(p.meta).toEqual({ 'harbor/provenance': { source: 'website', origin: 'https://example.test' } });
    }
  });

  it('opens only one ACP session for the lifetime of the text session', async () => {
    await setAcpBackend(AGENT_ID);
    let sessionNewCalls = 0;
    registerFakeAgent({
      onSessionNew: () => { sessionNewCalls++; },
      onPrompt: async () => ({ stopReason: 'end_turn' }),
    });

    const created = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', {}));
    const sessionId = (created as { result: string }).result;
    await ai.handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'a' }));
    await ai.handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'b' }));
    await ai.handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'c' }));

    expect(sessionNewCalls).toBe(1);
  });
});

describe('scrubbing', () => {
  it('replaces the session working directory and the home path in the agent\'s reply', async () => {
    await setAcpBackend(AGENT_ID);
    registerFakeAgent({
      cwd: '/Users/sam/.harbor/acp/workspaces/example.test',
      onPrompt: sendsMessageChunk('see /Users/sam/.harbor/acp/workspaces/example.test/x.txt'),
    });

    const created = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', {}));
    const sessionId = (created as { result: string }).result;
    const res = await ai.handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'hi' }));
    expect(res).toMatchObject({ ok: true, result: 'see ./x.txt' });
  });
});

describe('model:prompt revoked between prompts', () => {
  it('refuses the next prompt with ERR_PERMISSION_DENIED without reaching the agent', async () => {
    await setAcpBackend(AGENT_ID);
    let promptCalls = 0;
    registerFakeAgent({
      onPrompt: async () => { promptCalls++; return { stopReason: 'end_turn' }; },
    });

    const created = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', {}));
    const sessionId = (created as { result: string }).result;
    await ai.handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'first' }));
    expect(promptCalls).toBe(1);

    mocks.hasPermission.mockResolvedValue(false);
    const res = await ai.handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'second' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'ERR_PERMISSION_DENIED' } });
    expect(promptCalls).toBe(1);
  });
});

describe('temperature and topK are ignored silently', () => {
  it('still creates and prompts the ACP session when the page sends them', async () => {
    await setAcpBackend(AGENT_ID);
    registerFakeAgent({ onPrompt: sendsMessageChunk('ok') });

    const created = await ai.handleAiCreateTextSession(
      ctx('ai.createTextSession', { temperature: 0.9, topK: 10 }),
    );
    expect(created.ok).toBe(true);
    const sessionId = (created as { result: string }).result;
    const res = await ai.handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'hi' }));
    expect(res).toMatchObject({ ok: true, result: 'ok' });
  });
});

describe('concurrent prompts on one ACP session', () => {
  it('queues a second prompt instead of sending two session/prompt calls at once', async () => {
    await setAcpBackend(AGENT_ID);
    const order: string[] = [];
    const resolvers: Array<(r: { stopReason: StopReason }) => void> = [];
    registerFakeAgent({
      onPrompt: async (promptCtx) => {
        order.push(`start:${promptCtx.params.prompt[0].text}`);
        return new Promise((resolve) => { resolvers.push(resolve); });
      },
    });

    const created = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', {}));
    const sessionId = (created as { result: string }).result;

    const first = ai.handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'one' }));
    // Give the first call a chance to reach the agent before starting the second.
    await vi.waitFor(() => expect(order).toEqual(['start:one']));
    const second = ai.handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'two' }));

    // The second prompt must not have reached the agent while the first is
    // still pending — it's queued, not sent concurrently.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['start:one']);

    resolvers[0]({ stopReason: 'end_turn' });
    await first;
    await vi.waitFor(() => expect(order).toEqual(['start:one', 'start:two']));
    resolvers[1]({ stopReason: 'end_turn' });
    await second;

    expect(order).toEqual(['start:one', 'start:two']);
  });
});

describe('a permission question relayed through the agent-question dialog', () => {
  it('passes the agent\'s own question to askAgentQuestion and the chosen option back unchanged', async () => {
    await setAcpBackend(AGENT_ID);
    mocks.askAgentQuestion.mockResolvedValue({ outcome: 'selected', optionId: 'allow-1' });

    registerFakeAgent({
      onPrompt: async (promptCtx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const outcome = await (promptCtx as any).client.request(CLIENT_METHODS.session_request_permission, {
          sessionId: promptCtx.params.sessionId,
          toolCall: { toolCallId: 'tc-1', title: 'Read a file', kind: 'read' },
          options: [{ optionId: 'allow-1', name: 'Allow', kind: 'allow_once' }],
        });
        expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-1' } });
        return { stopReason: 'end_turn' };
      },
    });

    const created = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', {}));
    const sessionId = (created as { result: string }).result;
    const res = await ai.handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'hi' }));
    expect(res).toMatchObject({ ok: true });
    expect(mocks.askAgentQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ origin: ORIGIN, agentName: AGENT_ID, toolCall: expect.objectContaining({ title: 'Read a file' }) }),
      expect.anything(),
    );
  });
});

describe('a turn that never ends is cancelled after the per-turn timeout', () => {
  it('ends with ERR_TIMEOUT and tells the agent session/cancel', async () => {
    vi.useFakeTimers();
    await setAcpBackend(AGENT_ID);
    let sessionCancelled = false;
    const fakeBridge = createFakeAcpBridge();
    mocks.bridge.current = fakeBridge;
    const app = buildAgentApp({ name: 'fake-text-agent' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 'sess-1' }))
      .onNotification(AGENT_METHODS.session_cancel, async () => { sessionCancelled = true; })
      .onRequest(AGENT_METHODS.session_prompt, () => new Promise(() => { /* never resolves */ }));
    fakeBridge.registerAgent(AGENT_ID, app, {});

    const created = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', {}));
    const sessionId = (created as { result: string }).result;

    const promptPromise = ai.handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'hi' }));
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);
    const res = await promptPromise;

    expect(res).toMatchObject({ ok: false, error: { code: 'ERR_TIMEOUT' } });
    expect(sessionCancelled).toBe(true);
  });
});

describe('session.promptStreaming on the ACP backend, through the real background port', () => {
  function eventsFor(postMessage: ReturnType<typeof vi.fn>, id: string) {
    return postMessage.mock.calls.map(([m]) => m).filter((m) => m.id === id);
  }

  it('streams agent_message_chunk tokens in order, then done', async () => {
    await setAcpBackend(AGENT_ID);
    registerFakeAgent({
      onPrompt: async (promptCtx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const notify = (promptCtx as any).client.notify.bind((promptCtx as any).client);
        await notify(CLIENT_METHODS.session_update, {
          sessionId: promptCtx.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } },
        });
        await notify(CLIENT_METHODS.session_update, {
          sessionId: promptCtx.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } },
        });
        return { stopReason: 'end_turn' };
      },
    });
    const { receive, postMessage, tabId } = connectPort();

    const created = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', {}, { tabId }));
    const sessionId = (created as { result: string }).result;

    await receive({ id: 'st-1', type: 'session.promptStreaming', payload: { sessionId, input: 'hi' } });

    const events = eventsFor(postMessage, 'st-1');
    expect(events.map((e) => e.event)).toEqual([
      { type: 'token', token: 'Hel' },
      { type: 'token', token: 'lo' },
      { type: 'done' },
    ]);

    await ai.handleSessionDestroy(ctx('session.destroy', { sessionId }, { tabId }));
  });

  it('cancels a running turn, kills the agent process, and the page sees ERR_ABORTED when destroy() races a streaming prompt', async () => {
    await setAcpBackend(AGENT_ID);
    let resolvePrompt: ((r: { stopReason: StopReason }) => void) | null = null;
    let sessionCancelled = false;
    const fakeBridge = createFakeAcpBridge();
    mocks.bridge.current = fakeBridge;
    const app = buildAgentApp({ name: 'fake-text-agent' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 'sess-1' }))
      .onNotification(AGENT_METHODS.session_cancel, async () => {
        sessionCancelled = true;
        resolvePrompt?.({ stopReason: 'cancelled' });
      })
      .onRequest(AGENT_METHODS.session_prompt, () => new Promise((resolve) => { resolvePrompt = resolve; }));
    fakeBridge.registerAgent(AGENT_ID, app, {});
    const { receive, postMessage, tabId } = connectPort();

    const created = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', {}, { tabId }));
    const sessionId = (created as { result: string }).result;

    const streamPromise = receive({ id: 'st-2', type: 'session.promptStreaming', payload: { sessionId, input: 'hi' } });
    await vi.waitFor(() => expect(resolvePrompt).not.toBeNull());

    await ai.handleSessionDestroy(ctx('session.destroy', { sessionId }, { tabId }));
    await streamPromise;

    expect(sessionCancelled).toBe(true);
    const terminal = eventsFor(postMessage, 'st-2').filter((e) => e.done);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].event).toMatchObject({ type: 'error', error: { code: 'ERR_ABORTED' } });
    expect(fakeBridge.openCalls).toHaveLength(1);
  });

  it('closes the agent process when the tab closes, and forgets the session', async () => {
    await setAcpBackend(AGENT_ID);
    registerFakeAgent({ onPrompt: async () => ({ stopReason: 'end_turn' }) });
    const { tabId } = connectPort();

    const created = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', {}, { tabId }));
    const sessionId = (created as { result: string }).result;

    await onTabRemovedListener(tabId);

    // The session is gone: a prompt against it now fails closed.
    const res = await ai.handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'hi' }, { tabId }));
    expect(res).toMatchObject({ ok: false, error: { code: 'ERR_SESSION_NOT_FOUND' } });
  });
});
