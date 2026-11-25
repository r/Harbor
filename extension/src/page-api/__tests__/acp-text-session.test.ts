import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent as buildAgentApp, AGENT_METHODS, CLIENT_METHODS, type AgentApp, type StopReason } from '@agentclientprotocol/sdk';

// window.ai text sessions (ai.createTextSession / ai.languageModel.create,
// session.prompt / session.promptStreaming, session.destroy) run on the
// user's own ACP agent when `harbor_agent_backend` names one, instead of
// Harbor's built-in llm.chat — see docs/ACP_BACKEND_DESIGN.md section 2 and
// the window.ai mapping in that section. These drive ai-handlers.ts's handlers directly for
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
  checkAgentPromptAction: vi.fn(),
  isModelPromptGrantedForAgent: vi.fn(),
  bridge: { current: null as null | ReturnType<typeof import('./support/fake-acp-bridge').createFakeAcpBridge> },
}));

vi.mock('../harbor-core', async () => {
  const { LabelFlow } = await import('../../policy/label-flow');
  return ({
  createLabelFlow: () => new LabelFlow(),
  getSessionLabelFlow: vi.fn(() => new LabelFlow()),
  describedBySite: (_origin: string, d?: string) => d,
  siteToolsForAgent: vi.fn(async () => []),
  openPageToolEndpointForAcp: vi.fn(async () => null), closePageToolEndpoint: vi.fn(async () => {}),
  pageToolsForAgent: vi.fn(async () => null),
  syncPageTools: vi.fn(), resolvePageToolResult: vi.fn(), forgetPageToolsForConnection: vi.fn(), forgetPageToolsInTab: vi.fn(),
  onHarborSessionEnded: vi.fn(() => () => {}),
  forgetAgentsInTab: vi.fn(), forgetAgentsOffOriginInTab: vi.fn(),
  // This file's tabs.onRemoved tests close a tab, which background.ts's
  // real listener also uses to forget that tab's site-registered MCP
  // servers (mcp/site-servers.ts) — a no-op here since none of these
  // sessions ever registered any.
  forgetSiteServersInTab: vi.fn(),
  harborRequest: vi.fn(async () => ({ bridgeReady: true })),
  harborStreamRequest: vi.fn(),
  acpOpenStream: (agentId: string, workspace: string) => mocks.bridge.current!.acpOpenStream(agentId, workspace),
  acpSend: (channel: string, message: unknown) => mocks.bridge.current!.acpSend(channel, message),
  acpClose: (channel: string) => mocks.bridge.current!.acpClose(channel),
  // The model.prompt.agent policy gate itself is covered, driven through
  // the real port and the real policy engine, in
  // acp-model-prompt-agent-policy.test.ts; here it's a controllable mock so
  // this file's own "deny" test can exercise how AcpTextSession handles it.
  checkAgentPromptAction: mocks.checkAgentPromptAction,
  // The defence-in-depth, explicit-backend grant check — its own real
  // behaviour is covered in is-model-prompt-granted-for-agent.test.ts;
  // here it's a controllable mock too, so a dedicated test can exercise
  // how AcpTextSession handles a mismatch distinct from a policy-rule deny.
  isModelPromptGrantedForAgent: mocks.isModelPromptGrantedForAgent,
  });
});
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
// background.ts's own barrel import, used for the real-port-listener tests
// below (promptStreaming, tab close, destroy racing a stream, and the
// mutation-coverage tests that drive ai.createTextSession/session.prompt/
// session.destroy through the real `routeMessage`, not the handlers
// directly). `routeMessage` itself is the real one — it's the thing these
// tests are routing through — spread from the actual module so a bug in
// the handler-lookup/feature-flag-gate plumbing would show up too; only
// permission checks and a few unrelated subsystems (spawned tabs, the
// multi-agent registry) are stubbed, the way explicit-session-streaming.test.ts
// stubs them for this same file.
vi.mock('../handlers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../handlers')>();
  return {
    ...actual,
    hasPermission: mocks.hasPermission,
    getPermissions: async () => ({ scopes: {}, allowedTools: [] }),
    restoreSpawnedTabs: vi.fn(), handleTabRemoved: vi.fn(), getAllSpawnedTabs: vi.fn(() => ({})),
    isSpawnedTab: vi.fn(), handleIncomingInvocation: vi.fn(), resolveInvocationResponse: vi.fn(),
    cleanupAgentsForTab: vi.fn(), failInvocationsForTab: vi.fn(), forgetPageAgentsInTab: vi.fn(), agentInvocationTabs: new Map(),
  };
});

import { createFakeAcpBridge } from './support/fake-acp-bridge';
import { getMockStorage, resetMockBrowser } from '../../__tests__/test-setup';
import { DEFAULT_FLAGS } from '../policy/feature-flag-set';
import { liveAgentCountForOrigin } from '../acp-agent-limits';
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
function connectPort(origin = ORIGIN, tabId = nextTabId++): {
  receive: (m: unknown) => Promise<void>;
  postMessage: ReturnType<typeof vi.fn>;
  tabId: number;
  /** Simulates the page's port disconnecting — a navigation or reload, or the tab closing. */
  disconnect: () => void;
} {
  let receiveFn: (m: unknown) => Promise<void> = async () => {};
  let disconnectFn: () => void = () => {};
  const postMessage = vi.fn();
  onConnectListener({
    name: 'harbor-page-api', sender: { url: `${origin}/page`, tab: { id: tabId } }, postMessage,
    onMessage: { addListener: (l: typeof receiveFn) => { receiveFn = l; } },
    onDisconnect: { addListener: (l: () => void) => { disconnectFn = l; } },
  });
  return { receive: (m: unknown) => receiveFn(m), postMessage, tabId, disconnect: () => disconnectFn() };
}

/**
 * Drives `ai.createTextSession`/`session.prompt`/`session.destroy` through
 * the real port — `routeMessage`, not the handlers directly — for the
 * mutation-coverage and lifecycle tests the maintainer's bounce asked for.
 */
function responseFor(postMessage: ReturnType<typeof vi.fn>, id: string): { id: string; ok: boolean; result?: unknown; error?: { code: string; message: string } } | undefined {
  return postMessage.mock.calls.map(([m]) => m).find((m) => m.id === id);
}

async function createViaPort(
  port: { receive: (m: unknown) => Promise<void>; postMessage: ReturnType<typeof vi.fn> },
  payload: Record<string, unknown> = {},
) {
  const id = crypto.randomUUID();
  await port.receive({ id, type: 'ai.createTextSession', payload });
  return responseFor(port.postMessage, id)!;
}

async function promptViaPort(
  port: { receive: (m: unknown) => Promise<void>; postMessage: ReturnType<typeof vi.fn> },
  sessionId: string,
  input: string,
) {
  const id = crypto.randomUUID();
  await port.receive({ id, type: 'session.prompt', payload: { sessionId, input } });
  return responseFor(port.postMessage, id)!;
}

async function destroyViaPort(
  port: { receive: (m: unknown) => Promise<void>; postMessage: ReturnType<typeof vi.fn> },
  sessionId: string,
) {
  const id = crypto.randomUUID();
  await port.receive({ id, type: 'session.destroy', payload: { sessionId } });
  return responseFor(port.postMessage, id)!;
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

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.hasPermission.mockResolvedValue(true);
  mocks.askAgentQuestion.mockReset();
  mocks.getFeatureFlags.mockResolvedValue(DEFAULT_FLAGS);
  mocks.checkAgentPromptAction.mockReset();
  mocks.checkAgentPromptAction.mockResolvedValue(null);
  mocks.isModelPromptGrantedForAgent.mockReset();
  mocks.isModelPromptGrantedForAgent.mockResolvedValue(true);
  mocks.bridge.current = createFakeAcpBridge();
  resetMockBrowser();
  // The per-site agent-slot count (acp-agent-limits.ts) is a module-level
  // map that isn't reset by resetModules (this file doesn't call it — see
  // connectPort's own comment on why), so a test that creates a session
  // without destroying it would otherwise leave it counted against every
  // later test on the same origin.
  const { resetAgentSlotsForTests } = await import('../acp-agent-limits');
  resetAgentSlotsForTests();
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
      expect.stringMatching(/working for the person/i),
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
        order.push(`start:${promptCtx.params.prompt[promptCtx.params.prompt.length - 1].text}`);
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

describe('open() never hangs on a failed handshake', () => {
  it('settles with a coded error, through the real port, when initialize rejects', async () => {
    const fakeBridge = createFakeAcpBridge();
    mocks.bridge.current = fakeBridge;
    await setAcpBackend(AGENT_ID);
    const app = buildAgentApp({ name: 'x' })
      .onRequest(AGENT_METHODS.initialize, async () => { throw new Error('boom /Users/sam/secret'); })
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }));
    fakeBridge.registerAgent(AGENT_ID, app, {});
    const port = connectPort();

    const result = await Promise.race([
      createViaPort(port),
      new Promise<'HUNG'>((resolve) => setTimeout(() => resolve('HUNG'), 2000)),
    ]);

    expect(result).not.toBe('HUNG');
    expect(result).toMatchObject({ ok: false, error: { code: 'ERR_AGENT_FAILED' } });
  });

  it('settles with a coded error, through the real port, when the agent exits mid-handshake', async () => {
    const fakeBridge = createFakeAcpBridge();
    mocks.bridge.current = fakeBridge;
    await setAcpBackend(AGENT_ID);
    const app = buildAgentApp({ name: 'x' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => {
        setTimeout(() => fakeBridge.crashChannel('ch-0'), 0);
        return new Promise(() => { /* the agent exits before answering */ });
      });
    fakeBridge.registerAgent(AGENT_ID, app, {});
    const port = connectPort();

    const result = await Promise.race([
      createViaPort(port),
      new Promise<'HUNG'>((resolve) => setTimeout(() => resolve('HUNG'), 2000)),
    ]);

    expect(result).not.toBe('HUNG');
    expect(result).toMatchObject({ ok: false, error: { code: 'ERR_AGENT_FAILED' } });
  });
});

describe('the agent process is never leaked on an open() failure', () => {
  it('calls acp.close when the protocol version is unsupported', async () => {
    const fakeBridge = createFakeAcpBridge();
    mocks.bridge.current = fakeBridge;
    await setAcpBackend(AGENT_ID);
    const app = buildAgentApp({ name: 'x' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 2 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }));
    fakeBridge.registerAgent(AGENT_ID, app, {});
    const closeSpy = vi.spyOn(fakeBridge, 'acpClose');
    const port = connectPort();

    const result = await createViaPort(port);

    expect(result).toMatchObject({ ok: false, error: { code: 'ERR_AGENT_FAILED', message: expect.stringContaining('protocol version') } });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('calls acp.close when initialize rejects after the channel opened', async () => {
    const fakeBridge = createFakeAcpBridge();
    mocks.bridge.current = fakeBridge;
    await setAcpBackend(AGENT_ID);
    const app = buildAgentApp({ name: 'x' })
      .onRequest(AGENT_METHODS.initialize, async () => { throw new Error('boom'); })
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }));
    fakeBridge.registerAgent(AGENT_ID, app, {});
    const closeSpy = vi.spyOn(fakeBridge, 'acpClose');
    const port = connectPort();

    await createViaPort(port);

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('a tab (or its port) going away while a session is still opening', () => {
  it('does not register the session, and kills the agent process', async () => {
    const fakeBridge = createFakeAcpBridge();
    mocks.bridge.current = fakeBridge;
    await setAcpBackend(AGENT_ID);
    let releaseInit!: () => void;
    const gate = new Promise<void>((resolve) => { releaseInit = resolve; });
    const app = buildAgentApp({ name: 'x' })
      .onRequest(AGENT_METHODS.initialize, async () => { await gate; return { protocolVersion: 1 }; })
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }))
      .onRequest(AGENT_METHODS.session_prompt, async () => ({ stopReason: 'end_turn' as StopReason }));
    fakeBridge.registerAgent(AGENT_ID, app, {});
    const closeSpy = vi.spyOn(fakeBridge, 'acpClose');
    const port = connectPort();

    const createPromise = createViaPort(port);
    await new Promise((r) => setTimeout(r, 20));
    await onTabRemovedListener(port.tabId);
    releaseInit();
    const result = await createPromise;

    const { isAcpTextSession } = await import('../acp-text-session-registry');
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'ERR_ABORTED' });
    if (result.ok) expect(isAcpTextSession(result.result as string)).toBe(false);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("kills the agent process when the page's port disconnects (navigation), with no tabs.onRemoved event", async () => {
    await setAcpBackend(AGENT_ID);
    const b = registerFakeAgent({ onPrompt: async () => ({ stopReason: 'end_turn' }) });
    const closeSpy = vi.spyOn(b, 'acpClose');
    const port = connectPort();

    const created = await createViaPort(port);
    const sessionId = created.result as string;
    const { isAcpTextSession } = await import('../acp-text-session-registry');
    expect(isAcpTextSession(sessionId)).toBe(true);

    port.disconnect();
    await new Promise((r) => setTimeout(r, 10));

    expect(isAcpTextSession(sessionId)).toBe(false);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps the session while the page is in the back/forward cache, and the restored page can prompt it', async () => {
    await setAcpBackend(AGENT_ID);
    const b = registerFakeAgent({ onPrompt: async () => ({ stopReason: 'end_turn' }) });
    const closeSpy = vi.spyOn(b, 'acpClose');
    const port = connectPort();
    const sessionId = (await createViaPort(port)).result as string;

    // The content script says the page is going into the cache, then closes its port.
    await port.receive({ type: 'page_hidden' });
    port.disconnect();
    await new Promise((r) => setTimeout(r, 10));
    const { isAcpTextSession } = await import('../acp-text-session-registry');
    expect(isAcpTextSession(sessionId)).toBe(true);
    expect(closeSpy).not.toHaveBeenCalled();

    // Back: the same page, on a new port in the same tab.
    const restored = connectPort(ORIGIN, port.tabId);
    await restored.receive({ type: 'page_shown' });
    const reply = await promptViaPort(restored, sessionId, 'hello again');
    expect(reply.ok).toBe(true);
  });

  it("ends a cached page's session after 30 minutes if the page doesn't come back", async () => {
    await setAcpBackend(AGENT_ID);
    const b = registerFakeAgent({ onPrompt: async () => ({ stopReason: 'end_turn' }) });
    const closeSpy = vi.spyOn(b, 'acpClose');
    const port = connectPort();
    const sessionId = (await createViaPort(port)).result as string;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await port.receive({ type: 'page_hidden' });
      port.disconnect();
      await vi.advanceTimersByTimeAsync(29 * 60_000);
      const { isAcpTextSession } = await import('../acp-text-session-registry');
      expect(isAcpTextSession(sessionId)).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(isAcpTextSession(sessionId)).toBe(false);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't let a later cached page in the tab push back an earlier page's 30 minutes", async () => {
    await setAcpBackend(AGENT_ID);
    registerFakeAgent({ onPrompt: async () => ({ stopReason: 'end_turn' }) });
    const port = connectPort();
    const sessionId = (await createViaPort(port)).result as string;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await port.receive({ type: 'page_hidden' });
      port.disconnect();
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      // The next page in the tab goes into the cache too.
      const next = connectPort(ORIGIN, port.tabId);
      await next.receive({ type: 'page_hidden' });
      next.disconnect();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const { isAcpTextSession } = await import('../acp-text-session-registry');
      expect(isAcpTextSession(sessionId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a page breaking out of promptStreaming (the abort message)', () => {
  it('sends session/cancel for that turn, and the page sees ERR_ABORTED', async () => {
    const fakeBridge = createFakeAcpBridge();
    mocks.bridge.current = fakeBridge;
    await setAcpBackend(AGENT_ID);
    let resolvePrompt: ((r: { stopReason: StopReason }) => void) | null = null;
    let cancelled = false;
    const app = buildAgentApp({ name: 'x' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }))
      .onNotification(AGENT_METHODS.session_cancel, async () => {
        cancelled = true;
        resolvePrompt?.({ stopReason: 'cancelled' });
      })
      .onRequest(AGENT_METHODS.session_prompt, () => new Promise((resolve) => { resolvePrompt = resolve; }));
    fakeBridge.registerAgent(AGENT_ID, app, {});
    const port = connectPort();

    const created = await createViaPort(port);
    const sessionId = created.result as string;

    const streamPromise = port.receive({ id: 'abort-st', type: 'session.promptStreaming', payload: { sessionId, input: 'hi' } });
    await vi.waitFor(() => expect(resolvePrompt).not.toBeNull());
    await port.receive({ type: 'abort', id: 'abort-st' });
    await streamPromise;

    expect(cancelled).toBe(true);
    const terminal = port.postMessage.mock.calls.map(([m]) => m).filter((m) => m.id === 'abort-st' && m.done);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].event).toMatchObject({ type: 'error', error: { code: 'ERR_ABORTED' } });
  });
});

describe('mid-turn model:prompt revoke, on a tool call during a text-session turn', () => {
  it('cancels the turn with ERR_PERMISSION_DENIED and tells the agent session/cancel, on tool_call', async () => {
    const fakeBridge = createFakeAcpBridge();
    mocks.bridge.current = fakeBridge;
    await setAcpBackend(AGENT_ID);
    let sessionCancelled = false;
    const app = buildAgentApp({ name: 'x' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }))
      .onNotification(AGENT_METHODS.session_cancel, async () => { sessionCancelled = true; })
      .onRequest(AGENT_METHODS.session_prompt, async (promptCtx) => {
        // The grant is revoked only once the turn is already running — the
        // same hasPermission check that gates every session.prompt
        // (resolveTextSession) must still pass to reach the agent at all,
        // so this flips it after, not before, the prompt is sent.
        mocks.hasPermission.mockResolvedValue(false);
        await promptCtx.client.notify(CLIENT_METHODS.session_update, {
          sessionId: promptCtx.params.sessionId,
          update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read a file' },
        });
        return new Promise(() => { /* the backend ends this once it cancels, via the client's own cancellation */ });
      });
    fakeBridge.registerAgent(AGENT_ID, app, {});
    const port = connectPort();
    const created = await createViaPort(port);
    const sessionId = created.result as string;

    const result = await promptViaPort(port, sessionId, 'hi');

    expect(result).toMatchObject({ ok: false, error: { code: 'ERR_PERMISSION_DENIED' } });
    // session/cancel is fire-and-forget (stopWaitingOnCancel means our own
    // promptViaPort() resolves without waiting for the agent to see it), so
    // this can briefly lag the response.
    await vi.waitFor(() => expect(sessionCancelled).toBe(true));
  });

  it('cancels the turn with ERR_PERMISSION_DENIED on tool_call_update, mirroring agent.run', async () => {
    await setAcpBackend(AGENT_ID);
    let sessionCancelled = false;
    const fakeBridge = createFakeAcpBridge();
    mocks.bridge.current = fakeBridge;
    const app = buildAgentApp({ name: 'x' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }))
      .onNotification(AGENT_METHODS.session_cancel, async () => { sessionCancelled = true; })
      .onRequest(AGENT_METHODS.session_prompt, async (promptCtx) => {
        // Same as the tool_call test above: the grant is revoked only once
        // the turn is running, after resolveTextSession's own check passed.
        mocks.hasPermission.mockResolvedValue(false);
        await promptCtx.client.notify(CLIENT_METHODS.session_update, {
          sessionId: promptCtx.params.sessionId,
          update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' },
        });
        return new Promise(() => { /* the backend ends this once it cancels */ });
      });
    fakeBridge.registerAgent(AGENT_ID, app, {});
    const port = connectPort();
    const created = await createViaPort(port);
    const sessionId = created.result as string;

    const result = await promptViaPort(port, sessionId, 'hi');

    expect(result).toMatchObject({ ok: false, error: { code: 'ERR_PERMISSION_DENIED' } });
    await vi.waitFor(() => expect(sessionCancelled).toBe(true));
  });
});

describe('the model.prompt.agent policy gate, before session/prompt', () => {
  // checkAgentPromptAction (harbor-core.ts) itself is covered against the
  // real policy engine and audit log, driven through the real port, in
  // acp-model-prompt-agent-policy.test.ts. This only checks that
  // AcpTextSession respects a `false` from it: no prompt sent, and the page
  // sees the same ERR_PERMISSION_DENIED the pre-existing model:prompt
  // origin-grant check already produces.
  it('never sends session/prompt when the gate denies, and reports ERR_PERMISSION_DENIED', async () => {
    await setAcpBackend(AGENT_ID);
    const fakeBridge = createFakeAcpBridge();
    mocks.bridge.current = fakeBridge;
    let promptCalled = false;
    const app = buildAgentApp({ name: 'x' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }))
      .onRequest(AGENT_METHODS.session_prompt, async () => { promptCalled = true; return { stopReason: 'end_turn' as StopReason }; });
    fakeBridge.registerAgent(AGENT_ID, app, {});
    const port = connectPort();
    const created = await createViaPort(port);
    const sessionId = created.result as string;

    mocks.checkAgentPromptAction.mockResolvedValue({ code: 'ERR_PERMISSION_DENIED', message: 'Permission denied' });
    const result = await promptViaPort(port, sessionId, 'hi');

    expect(result).toMatchObject({ ok: false, error: { code: 'ERR_PERMISSION_DENIED' } });
    expect(promptCalled).toBe(false);
    // The exact origin and tab this session was opened for — not some
    // other origin/tabId — must reach the gate.
    expect(mocks.checkAgentPromptAction).toHaveBeenCalledWith(ORIGIN, port.tabId, expect.anything());
  });

  it('is checked on every prompt, not just the first', async () => {
    await setAcpBackend(AGENT_ID);
    const fakeBridge = createFakeAcpBridge();
    mocks.bridge.current = fakeBridge;
    let promptCalls = 0;
    const app = buildAgentApp({ name: 'x' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }))
      .onRequest(AGENT_METHODS.session_prompt, async () => { promptCalls++; return { stopReason: 'end_turn' as StopReason }; });
    fakeBridge.registerAgent(AGENT_ID, app, {});
    const port = connectPort();
    const created = await createViaPort(port);
    const sessionId = created.result as string;

    const first = await promptViaPort(port, sessionId, 'one');
    expect(first).toMatchObject({ ok: true });
    expect(promptCalls).toBe(1);

    mocks.checkAgentPromptAction.mockResolvedValue({ code: 'ERR_PERMISSION_DENIED', message: 'Permission denied' });
    const second = await promptViaPort(port, sessionId, 'two');
    expect(second).toMatchObject({ ok: false, error: { code: 'ERR_PERMISSION_DENIED' } });
    expect(promptCalls).toBe(1);
  });
});

describe('the explicit-backend grant check, before session/prompt (defence in depth)', () => {
  // isModelPromptGrantedForAgent's own real behaviour (judging the grant
  // against the session's own agentId, not a live read of the selection)
  // is covered in is-model-prompt-granted-for-agent.test.ts. This only
  // checks that AcpTextSession respects a `false` from it, distinctly
  // from a policy-rule deny (checkAgentPromptAction).
  it('never sends session/prompt when the session\'s own backend no longer holds the grant, and reports ERR_PERMISSION_DENIED', async () => {
    await setAcpBackend(AGENT_ID);
    const fakeBridge = createFakeAcpBridge();
    mocks.bridge.current = fakeBridge;
    let promptCalled = false;
    const app = buildAgentApp({ name: 'x' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }))
      .onRequest(AGENT_METHODS.session_prompt, async () => { promptCalled = true; return { stopReason: 'end_turn' as StopReason }; });
    fakeBridge.registerAgent(AGENT_ID, app, {});
    const port = connectPort();
    const created = await createViaPort(port);
    const sessionId = created.result as string;

    mocks.isModelPromptGrantedForAgent.mockResolvedValue(false);
    const result = await promptViaPort(port, sessionId, 'hi');

    expect(result).toMatchObject({ ok: false, error: { code: 'ERR_PERMISSION_DENIED' } });
    expect(promptCalled).toBe(false);
    // The session's own agentId — not whatever the live selection happens
    // to be — is what gets checked.
    expect(mocks.isModelPromptGrantedForAgent).toHaveBeenCalledWith(ORIGIN, AGENT_ID, port.tabId);
  });
});

describe('mutation coverage: destroy() actually kills the agent process', () => {
  it('calls acp.close when destroy() runs with no turn in progress', async () => {
    await setAcpBackend(AGENT_ID);
    const b = registerFakeAgent({ onPrompt: async () => ({ stopReason: 'end_turn' }) });
    const closeSpy = vi.spyOn(b, 'acpClose');
    const port = connectPort();

    const created = await createViaPort(port);
    const sessionId = created.result as string;
    expect(closeSpy).not.toHaveBeenCalled();

    const destroyed = await destroyViaPort(port, sessionId);

    expect(destroyed).toMatchObject({ ok: true });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('mutation coverage: tab-close cleanup actually kills every agent process for that tab', () => {
  it('calls acp.close for each ACP-backed session the tab opened', async () => {
    await setAcpBackend(AGENT_ID);
    const b = registerFakeAgent({ onPrompt: async () => ({ stopReason: 'end_turn' }) });
    const closeSpy = vi.spyOn(b, 'acpClose');
    const port = connectPort();

    await createViaPort(port);
    await createViaPort(port);
    expect(closeSpy).not.toHaveBeenCalled();

    await onTabRemovedListener(port.tabId);

    expect(closeSpy).toHaveBeenCalledTimes(2);
  });
});

describe('mutation coverage: the streaming chunk is actually scrubbed', () => {
  it('replaces the working directory in a streamed agent_message_chunk, not just the final text', async () => {
    const fakeBridge = createFakeAcpBridge();
    mocks.bridge.current = fakeBridge;
    await setAcpBackend(AGENT_ID);
    const cwd = '/Users/sam/.harbor/acp/workspaces/example.test';
    const app = buildAgentApp({ name: 'x' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }))
      .onRequest(AGENT_METHODS.session_prompt, async (promptCtx) => {
        await promptCtx.client.notify(CLIENT_METHODS.session_update, {
          sessionId: promptCtx.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `see ${cwd}/x.txt` } },
        });
        return { stopReason: 'end_turn' as StopReason };
      });
    fakeBridge.registerAgent(AGENT_ID, app, { cwd });
    const port = connectPort();

    const created = await createViaPort(port);
    const sessionId = created.result as string;

    await port.receive({ id: 'scrub-st', type: 'session.promptStreaming', payload: { sessionId, input: 'hi' } });

    const tokenEvents = port.postMessage.mock.calls.map(([m]) => m).filter((m) => m.id === 'scrub-st' && m.event?.type === 'token');
    expect(tokenEvents).toHaveLength(1);
    expect(tokenEvents[0].event.token).toBe('see ./x.txt');
    expect(tokenEvents[0].event.token).not.toContain('/Users/sam');
  });
});

describe('a page-side abort during ai.createTextSession, through the real port', () => {
  it('ends the open with ERR_ABORTED, closes the agent process, and frees the per-site slot', async () => {
    await setAcpBackend(AGENT_ID);
    const fakeBridge = createFakeAcpBridge();
    mocks.bridge.current = fakeBridge;
    // Hangs at initialize forever, so only the page's own abort can end this.
    const app = buildAgentApp({ name: 'x' })
      .onRequest(AGENT_METHODS.initialize, () => new Promise(() => {}))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }));
    fakeBridge.registerAgent(AGENT_ID, app, {});
    const closeSpy = vi.spyOn(fakeBridge, 'acpClose');
    const port = connectPort();

    const id = 'create-1';
    const createPromise = port.receive({ id, type: 'ai.createTextSession', payload: {} });
    await vi.waitFor(() => expect(fakeBridge.openCalls).toHaveLength(1));

    await port.receive({ type: 'abort', id });
    await createPromise;

    expect(responseFor(port.postMessage, id)).toMatchObject({ ok: false, error: { code: 'ERR_ABORTED' } });
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(liveAgentCountForOrigin(ORIGIN)).toBe(0);
  });
});

describe('a page-side abort during a non-streaming session.prompt, through the real port', () => {
  it('cancels that turn (session/cancel) with ERR_ABORTED, and a prompt already queued behind it then runs', async () => {
    await setAcpBackend(AGENT_ID);
    const fakeBridge = createFakeAcpBridge();
    mocks.bridge.current = fakeBridge;
    let resolveFirstPrompt: ((r: { stopReason: StopReason }) => void) | null = null;
    let promptCalls = 0;
    let sessionCancelled = false;
    const app = buildAgentApp({ name: 'x' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }))
      .onNotification(AGENT_METHODS.session_cancel, async () => {
        sessionCancelled = true;
        resolveFirstPrompt?.({ stopReason: 'cancelled' });
      })
      .onRequest(AGENT_METHODS.session_prompt, () => {
        promptCalls++;
        if (promptCalls === 1) return new Promise((resolve) => { resolveFirstPrompt = resolve; });
        return Promise.resolve({ stopReason: 'end_turn' as StopReason });
      });
    fakeBridge.registerAgent(AGENT_ID, app, {});
    const port = connectPort();

    const created = await createViaPort(port);
    const sessionId = created.result as string;

    const firstId = 'prompt-1';
    const firstPromise = port.receive({ id: firstId, type: 'session.prompt', payload: { sessionId, input: 'a' } });
    await vi.waitFor(() => expect(resolveFirstPrompt).not.toBeNull());

    // Queued behind the first turn — must not run until it ends.
    const secondPromise = promptViaPort(port, sessionId, 'b');
    expect(promptCalls).toBe(1);

    await port.receive({ type: 'abort', id: firstId });
    await firstPromise;

    expect(responseFor(port.postMessage, firstId)).toMatchObject({ ok: false, error: { code: 'ERR_ABORTED' } });
    expect(sessionCancelled).toBe(true);

    const second = await secondPromise;
    expect(second).toMatchObject({ ok: true });
    expect(promptCalls).toBe(2);
  });
});
