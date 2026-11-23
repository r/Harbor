import { LabelFlow } from '../../policy/label-flow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent as buildAgentApp, AGENT_METHODS, type StopReason } from '@agentclientprotocol/sdk';

// Switching `harbor_agent_backend` must end work already running on the
// *old* agent, not just change what a later call uses
// (docs/ACP_BACKEND_DESIGN.md): an open window.ai text session is
// destroyed, and an in-flight agent.run is cancelled with
// ERR_AGENT_FAILED / "The agent was changed.". Driven through the real
// port and the real `storage.onChanged` listener background.ts
// registers in initializePageApi() — not a stand-in for either — the
// way the bounce asked for ("test it through the real port").
//
// This file gets its own `chrome.storage` mock (with real onChanged
// support, wired to its own set()), rather than reusing
// src/__tests__/test-setup.ts's shared one: that shared mock's
// resetMockBrowser() clears every onChanged listener between tests,
// which would silently unwire background.ts's own listener (registered
// once, in beforeAll) after the first test — see the comment on
// resetMockBrowser() in test-setup.ts.

const mocks = vi.hoisted(() => ({
  harborRequest: vi.fn(), hasPermission: vi.fn(), getFeatureFlags: vi.fn(),
  bridge: { current: null as null | ReturnType<typeof import('./support/fake-acp-bridge').createFakeAcpBridge> },
}));
vi.mock('../harbor-core', () => ({
  createLabelFlow: () => new LabelFlow(),
  describedBySite: (_origin: string, d?: string) => d,
  siteToolsForAgent: vi.fn(async () => []),
  openPageToolEndpointForAcp: vi.fn(async () => null), closePageToolEndpoint: vi.fn(async () => {}),
  syncPageTools: vi.fn(), resolvePageToolResult: vi.fn(), forgetPageToolsForConnection: vi.fn(), forgetPageToolsInTab: vi.fn(),
  pageToolsForAgent: vi.fn(async () => null),
  onHarborSessionEnded: vi.fn(() => () => {}),
  harborRequest: mocks.harborRequest,
  acpOpenStream: (agentId: string, workspace: string) => mocks.bridge.current!.acpOpenStream(agentId, workspace),
  acpSend: (channel: string, message: unknown) => mocks.bridge.current!.acpSend(channel, message),
  acpClose: (channel: string) => mocks.bridge.current!.acpClose(channel),
  // Both the policy-rule gate and the explicit-backend defence-in-depth
  // check are covered on their own terms elsewhere
  // (acp-model-prompt-agent-policy.test.ts, is-model-prompt-granted-for-agent.test.ts);
  // this file is about ending old work on a switch, not about grants.
  requireAgentPromptAction: async () => true,
  isModelPromptGrantedForAgent: async () => true,
  // This file is about ending old work on a backend switch, not
  // site-registered MCP servers — no origin here registered any.
}));
vi.mock('../policy/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../policy/feature-flags')>()),
  getFeatureFlags: mocks.getFeatureFlags,
}));
vi.mock('../handlers/permission-handlers', async (importOriginal) => ({
  ...(await importOriginal<object>()), hasPermission: mocks.hasPermission,
}));
vi.mock('../handlers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../handlers')>();
  return {
    ...actual,
    hasPermission: mocks.hasPermission,
    getPermissions: async () => ({ scopes: {}, allowedTools: [] }),
    restoreSpawnedTabs: vi.fn(), handleTabRemoved: vi.fn(), getAllSpawnedTabs: vi.fn(() => ({})),
    isSpawnedTab: vi.fn(), handleIncomingInvocation: vi.fn(), resolveInvocationResponse: vi.fn(),
    cleanupAgentsForTab: vi.fn(), agentInvocationTabs: new Map(),
  };
});

import { createFakeAcpBridge } from './support/fake-acp-bridge';

const AGENT_ID = 'test-agent';
const ORIGIN = 'https://example.test';

/** A `chrome.storage` stand-in whose `onChanged` actually fires on `set()` — unlike acp-backend-selection.test.ts's bare `{ local: { get } }`. */
function makeStorageWithOnChanged() {
  const data: Record<string, unknown> = {};
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  return {
    local: {
      get: async (key?: string) => (key === undefined ? { ...data } : (key in data ? { [key]: data[key] } : {})),
      set: async (kv: Record<string, unknown>) => {
        const changes: Record<string, { oldValue: unknown; newValue: unknown }> = {};
        for (const [k, v] of Object.entries(kv)) { changes[k] = { oldValue: data[k], newValue: v }; data[k] = v; }
        for (const l of listeners) l(changes, 'local');
      },
      remove: async (key: string) => { delete data[key]; },
    },
    onChanged: {
      addListener: (l: (changes: Record<string, unknown>, area: string) => void) => { listeners.push(l); },
      removeListener: () => {},
    },
  };
}

let receive: (message: unknown) => Promise<void>;
let postMessage: ReturnType<typeof vi.fn>;
let storage: ReturnType<typeof makeStorageWithOnChanged>;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const { DEFAULT_FLAGS } = await import('../policy/feature-flag-set');
  mocks.getFeatureFlags.mockResolvedValue({ ...DEFAULT_FLAGS, toolCalling: true });
  mocks.hasPermission.mockResolvedValue(true);
  mocks.bridge.current = createFakeAcpBridge();
  storage = makeStorageWithOnChanged();
  await storage.local.set({ harbor_agent_backend: { type: 'acp', agentId: AGENT_ID } });

  const event = () => ({ addListener: vi.fn() });
  const onConnect = event();
  vi.stubGlobal('chrome', {
    tabs: { onRemoved: event() }, windows: { onRemoved: event() },
    runtime: { onConnect, onMessage: event(), onMessageExternal: event() },
    storage,
  });
  const { initializePageApi } = await import('../background');
  initializePageApi();
  postMessage = vi.fn();
  onConnect.addListener.mock.calls[0][0]({
    name: 'harbor-page-api', sender: { url: `${ORIGIN}/page`, tab: { id: 1 } }, postMessage,
    onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
    onDisconnect: { addListener: () => {} },
  });
});
afterEach(() => vi.unstubAllGlobals());

function eventsFor(id: string) {
  return postMessage.mock.calls.map(([m]) => m).filter((m) => m.id === id);
}
function terminalEventsFor(id: string) {
  return eventsFor(id).filter((m) => m.done);
}

async function switchBackend(agentId: string) {
  await storage.local.set({ harbor_agent_backend: { type: 'acp', agentId } });
}

describe('an in-flight agent.run on the ACP backend, when the backend switches mid-run', () => {
  it('is cancelled with ERR_AGENT_FAILED / "The agent was changed."', async () => {
    mocks.harborRequest.mockImplementation(async (method: string) => {
      if (method === 'mcp.listTools') return { tools: [] };
      throw new Error(`unexpected ${method}`);
    });
    let resolvePrompt: ((r: { stopReason: StopReason }) => void) | null = null;
    let sessionCancelled = false;
    const app = buildAgentApp({ name: 'fake-agent' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 'sess-1' }))
      .onNotification(AGENT_METHODS.session_cancel, async () => { sessionCancelled = true; resolvePrompt?.({ stopReason: 'cancelled' }); })
      .onRequest(AGENT_METHODS.session_prompt, () => new Promise((resolve) => { resolvePrompt = resolve; }));
    mocks.bridge.current!.registerAgent(AGENT_ID, app, {});

    const runPromise = receive({ id: 'switch-run', type: 'agent.run', origin: ORIGIN, payload: { task: 't' } });
    await vi.waitFor(() => expect(resolvePrompt).not.toBeNull());

    // The switch itself: a different agent (an equally valid trigger
    // would be switching back to the built-in model).
    await switchBackend('a-different-agent');
    await runPromise;

    const terminal = terminalEventsFor('switch-run');
    expect(terminal).toHaveLength(1);
    expect(terminal[0].event).toMatchObject({ type: 'error', error: { code: 'ERR_AGENT_FAILED', message: 'The agent was changed.' } });
    expect(sessionCancelled).toBe(true);
  });

  it('does not touch a concurrent run already on the built-in backend', async () => {
    // Starts on the built-in model (not ACP) — only an ACP-backed run is
    // combined with the shared generation signal, so a switch happening
    // (to some ACP agent) while this one is in flight must not cancel it.
    await storage.local.set({ harbor_agent_backend: undefined });
    let releaseChat!: (v: unknown) => void;
    const chatGate = new Promise((resolve) => { releaseChat = resolve; });
    let notifyChatStarted!: () => void;
    const chatStarted = new Promise<void>((resolve) => { notifyChatStarted = resolve; });
    mocks.harborRequest.mockImplementation(async (method: string) => {
      if (method === 'mcp.listTools') return { tools: [] };
      if (method === 'llm.chat') { notifyChatStarted(); return chatGate; }
      throw new Error(`unexpected ${method}`);
    });

    const runPromise = receive({ id: 'builtin-run', type: 'agent.run', origin: ORIGIN, payload: { task: 't' } });
    await chatStarted;

    await switchBackend(AGENT_ID);
    releaseChat({ content: 'built-in answer', choices: [{ message: { role: 'assistant', content: 'built-in answer' } }] });
    await runPromise;

    const terminal = terminalEventsFor('builtin-run');
    expect(terminal).toHaveLength(1);
    expect(terminal[0].event).toEqual({ type: 'done' });
  });

});

describe('an open window.ai text session on the ACP backend, when the backend switches', () => {
  async function createSession(): Promise<string> {
    const id = 'create-1';
    await receive({ id, type: 'ai.createTextSession', payload: {} });
    const response = eventsFor(id)[0];
    return response!.result as string;
  }
  async function promptSession(sessionId: string, input: string) {
    const id = `prompt-${Math.random()}`;
    await receive({ id, type: 'session.prompt', payload: { sessionId, input } });
    return eventsFor(id)[0];
  }

  it('is destroyed on the switch: a later prompt gets the same "session not found" an explicit destroy produces', async () => {
    const app = buildAgentApp({ name: 'fake-text-agent' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 'sess-1' }))
      .onRequest(AGENT_METHODS.session_prompt, async () => ({ stopReason: 'end_turn' as StopReason }));
    mocks.bridge.current!.registerAgent(AGENT_ID, app, {});

    const sessionId = await createSession();
    expect(await promptSession(sessionId, 'before')).toMatchObject({ ok: true });

    await switchBackend('a-different-agent');

    const result = await promptSession(sessionId, 'after');
    expect(result).toMatchObject({ ok: false, error: { code: 'ERR_SESSION_NOT_FOUND', message: 'Session not found' } });
  });
});

describe('agent.run: the race between selectAgentBackend() and a switch landing mid-read', () => {
  it('does not start a stale built-in backend after a switch during tool discovery', async () => {
    await storage.local.set({ harbor_agent_backend: undefined });
    mocks.harborRequest.mockImplementation(async (method: string) => {
      if (method === 'mcp.listTools') {
        await switchBackend(AGENT_ID);
        return { tools: [] };
      }
      return { content: 'stale built-in answer' };
    });
    await receive({ id: 'discovery-switch', type: 'agent.run', payload: { task: 't' } });
    expect(terminalEventsFor('discovery-switch')).toEqual([
      expect.objectContaining({ event: { type: 'error', error: { code: 'ERR_AGENT_FAILED', message: 'The agent was changed.' } } }),
    ]);
    expect(mocks.harborRequest.mock.calls.map(([method]) => method)).toEqual(['mcp.listTools']);
  });

  it('is cancelled even when the switch lands while selectAgentBackend() is still reading the (soon-to-be-stale) setting', async () => {
    // The race this models: `handleAgentRun` captures the
    // generation signal *before* `selectAgentBackend()`'s own storage
    // read — not after — so a switch landing in the gap while that read
    // is still in flight still cancels this run, even though the read
    // goes on to resolve with the agent that was selected *before* the
    // switch (a real storage read already dispatched doesn't rewind
    // itself just because a write lands before it returns).
    mocks.harborRequest.mockImplementation(async (method: string) => {
      if (method === 'mcp.listTools') return { tools: [] };
      throw new Error(`unexpected ${method}`);
    });
    let promptCalled = false;
    const app = buildAgentApp({ name: 'fake-agent' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 'sess-1' }))
      .onRequest(AGENT_METHODS.session_prompt, async () => { promptCalled = true; return { stopReason: 'end_turn' as StopReason }; });
    mocks.bridge.current!.registerAgent(AGENT_ID, app, {});

    // Snapshots the stored value as soon as the read starts (as a real,
    // already in-flight storage read would), notifies this test that the
    // read has started (so the switch below is guaranteed to land while
    // it's still pending, not racing against it unpredictably), and only
    // delivers the snapshot to the caller once this test releases the gate.
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let notifyReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { notifyReadStarted = resolve; });
    const realGet = storage.local.get;
    storage.local.get = (async (key?: string) => {
      const snapshot = await realGet(key);
      notifyReadStarted();
      await readGate;
      return snapshot;
    }) as typeof storage.local.get;

    const runPromise = receive({ id: 'race-run', type: 'agent.run', origin: ORIGIN, payload: { task: 't' } });
    await readStarted;

    // The switch lands *after* the read already snapshotted the
    // pre-switch value, but *before* that snapshot is delivered to the
    // run's own selectAgentBackend() call — deterministically, not by
    // chance microtask ordering.
    await switchBackend('a-different-agent');
    releaseRead();
    await runPromise;

    const terminal = terminalEventsFor('race-run');
    expect(terminal).toHaveLength(1);
    expect(terminal[0].event).toMatchObject({ type: 'error', error: { code: 'ERR_AGENT_FAILED', message: 'The agent was changed.' } });
    expect(promptCalled).toBe(false);
  });
});
