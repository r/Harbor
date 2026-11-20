import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent as buildAgentApp, AGENT_METHODS, type StopReason } from '@agentclientprotocol/sdk';

// background.ts's handleAgentRun picks a backend for `agent.run` from a
// stored setting (`harbor_agent_backend` in chrome.storage.local), after
// its existing feature-flag and grant checks. These tests drive that
// through the real port listener, as agent-run-abort.test.ts does for
// builtinAgentBackend, so the selection and the page-visible cancellation
// paths (page abort, tab close, a grant revoked mid-run) are exercised the
// way a real page's `agent.run` reaches them — not only by calling
// AcpAgentBackend directly (see acp-backend.test.ts for that).

const mocks = vi.hoisted(() => ({
  harborRequest: vi.fn(), hasPermission: vi.fn(), getFeatureFlags: vi.fn(),
  storageGet: vi.fn(),
  bridge: { current: null as null | ReturnType<typeof import('./support/fake-acp-bridge').createFakeAcpBridge> },
}));
vi.mock('../harbor-core', () => ({
  onHarborSessionEnded: vi.fn(() => () => {}),
  forgetAgentsInTab: vi.fn(),
  harborRequest: mocks.harborRequest,
  acpOpenStream: (agentId: string, workspace: string) => mocks.bridge.current!.acpOpenStream(agentId, workspace),
  acpSend: (channel: string, message: unknown) => mocks.bridge.current!.acpSend(channel, message),
  acpClose: (channel: string) => mocks.bridge.current!.acpClose(channel),
  // The model.prompt.agent policy gate itself is covered, driven through
  // the real port and the real policy engine, in
  // acp-model-prompt-agent-policy.test.ts.
  requireAgentPromptAction: async () => true,
  // This file is about backend selection and cancellation, not
  // site-registered MCP servers — no origin here registered any.
  listSiteServersForAcp: () => [],
  policyAllowsSiteToolsForAcp: async () => true,
}));
vi.mock('../policy/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../policy/feature-flags')>()),
  getFeatureFlags: mocks.getFeatureFlags,
}));
vi.mock('../handlers', () => ({
  routeMessage: vi.fn(), isStreamingMessage: vi.fn(), hasPermission: mocks.hasPermission,
  getPermissions: async () => ({ scopes: {}, allowedTools: [] }),
  resolveTextSession: vi.fn(), recordExplicitPrompt: vi.fn(), forgetTextSession: vi.fn(),
  restoreSpawnedTabs: vi.fn(), handleTabRemoved: vi.fn(), getAllSpawnedTabs: vi.fn(),
  isSpawnedTab: vi.fn(), handleIncomingInvocation: vi.fn(), resolveInvocationResponse: vi.fn(),
  cleanupAgentsForTab: vi.fn(), agentInvocationTabs: new Map(),
}));

import { createFakeAcpBridge } from './support/fake-acp-bridge';

const AGENT_ID = 'test-agent';

let receive: (message: unknown) => Promise<void>;
let disconnect: () => void;
let postMessage: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  const { DEFAULT_FLAGS } = await import('../policy/feature-flag-set');
  mocks.getFeatureFlags.mockResolvedValue({ ...DEFAULT_FLAGS, toolCalling: true });
  mocks.hasPermission.mockResolvedValue(true);
  mocks.storageGet.mockResolvedValue({});
  mocks.bridge.current = createFakeAcpBridge();

  const event = () => ({ addListener: vi.fn() });
  const onConnect = event();
  vi.stubGlobal('chrome', {
    tabs: { onRemoved: event() }, windows: { onRemoved: event() },
    runtime: { onConnect, onMessage: event(), onMessageExternal: event() },
    storage: { local: { get: mocks.storageGet } },
  });
  const { initializePageApi } = await import('../background');
  initializePageApi();
  postMessage = vi.fn();
  let onDisconnect: () => void = () => {};
  onConnect.addListener.mock.calls[0][0]({
    name: 'harbor-page-api', sender: { url: 'https://example.test/page', tab: { id: 1 } }, postMessage,
    onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
    onDisconnect: { addListener: (listener: () => void) => { onDisconnect = listener; } },
  });
  disconnect = () => onDisconnect();
});
afterEach(() => vi.unstubAllGlobals());

function eventsFor(id: string) {
  return postMessage.mock.calls.map(([m]) => m).filter((m) => m.id === id);
}

function terminalEventsFor(id: string) {
  return eventsFor(id).filter((m) => m.done);
}

/** The built-in backend's `final` token, which arrives before the terminal `done` event. */
function finalOutputFor(id: string): string | undefined {
  for (const m of eventsFor(id)) {
    if (typeof m.event?.token !== 'string') continue;
    try {
      const parsed = JSON.parse(m.event.token);
      if (parsed.type === 'final') return parsed.output;
    } catch { /* not JSON */ }
  }
  return undefined;
}

function stubListTools() {
  mocks.harborRequest.mockImplementation(async (method: string) => {
    if (method === 'mcp.listTools') return { tools: [] };
    throw new Error(`unexpected ${method}`);
  });
}

function registerHappyAcpAgent(onPrompt: (ctx: { params: { sessionId: string } }) => Promise<{ stopReason: StopReason }>) {
  const app = buildAgentApp({ name: 'fake-agent' })
    .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
    .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 'sess-1' }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .onRequest(AGENT_METHODS.session_prompt, async (ctx) => onPrompt(ctx as any));
  mocks.bridge.current!.registerAgent(AGENT_ID, app, {});
}

describe('agent.run backend selection', () => {
  it('uses the built-in backend when no setting is stored', async () => {
    stubListTools();
    mocks.harborRequest.mockImplementation(async (method: string) => {
      if (method === 'mcp.listTools') return { tools: [] };
      if (method === 'llm.chat') return { content: 'built-in answer', choices: [{ message: { role: 'assistant', content: 'built-in answer' } }] };
      throw new Error(`unexpected ${method}`);
    });

    await receive({ id: 'run-1', type: 'agent.run', origin: 'https://example.test', payload: { task: 't' } });

    const terminal = terminalEventsFor('run-1');
    expect(terminal).toHaveLength(1);
    expect(terminal[0].event).toEqual({ type: 'done' });
    expect(finalOutputFor('run-1')).toBe('built-in answer');
  });

  it('falls back to the built-in backend when the stored setting has the wrong shape', async () => {
    mocks.storageGet.mockResolvedValue({ harbor_agent_backend: { type: 'acp' } }); // missing agentId
    mocks.harborRequest.mockImplementation(async (method: string) => {
      if (method === 'mcp.listTools') return { tools: [] };
      if (method === 'llm.chat') return { content: 'fallback answer', choices: [{ message: { role: 'assistant', content: 'fallback answer' } }] };
      throw new Error(`unexpected ${method}`);
    });

    await receive({ id: 'run-2', type: 'agent.run', origin: 'https://example.test', payload: { task: 't' } });

    expect(terminalEventsFor('run-2')[0].event).toEqual({ type: 'done' });
    expect(finalOutputFor('run-2')).toBe('fallback answer');
  });

  it('uses the configured ACP agent when the setting names one', async () => {
    mocks.storageGet.mockResolvedValue({ harbor_agent_backend: { type: 'acp', agentId: AGENT_ID } });
    stubListTools();
    registerHappyAcpAgent(async () => ({ stopReason: 'end_turn' }));

    await receive({ id: 'run-3', type: 'agent.run', origin: 'https://example.test', payload: { task: 't' } });

    const terminal = terminalEventsFor('run-3');
    expect(terminal).toHaveLength(1);
    expect(terminal[0].event).toEqual({ type: 'done' });
  });
});

describe('agent.run cancellation on the ACP backend, at the page port boundary', () => {
  beforeEach(() => {
    mocks.storageGet.mockResolvedValue({ harbor_agent_backend: { type: 'acp', agentId: AGENT_ID } });
    stubListTools();
  });

  it('aborts the ACP run with ERR_ABORTED on {type: "abort"}', async () => {
    let resolvePrompt: ((r: { stopReason: StopReason }) => void) | null = null;
    const app = buildAgentApp({ name: 'fake-agent' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 'sess-1' }))
      .onNotification(AGENT_METHODS.session_cancel, async () => { resolvePrompt?.({ stopReason: 'cancelled' }); })
      .onRequest(AGENT_METHODS.session_prompt, () => new Promise((resolve) => { resolvePrompt = resolve; }));
    mocks.bridge.current!.registerAgent(AGENT_ID, app, {});

    const runPromise = receive({ id: 'abort-run', type: 'agent.run', origin: 'https://example.test', payload: { task: 't' } });
    await vi.waitFor(() => expect(resolvePrompt).not.toBeNull());

    await receive({ type: 'abort', id: 'abort-run' });
    await runPromise;

    const terminal = terminalEventsFor('abort-run');
    expect(terminal).toHaveLength(1);
    expect(terminal[0].event).toMatchObject({ type: 'error', error: { code: 'ERR_ABORTED' } });
  });

  it('aborts every in-flight ACP run on this port when the port disconnects', async () => {
    let resolvePrompt: ((r: { stopReason: StopReason }) => void) | null = null;
    const app = buildAgentApp({ name: 'fake-agent' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 'sess-1' }))
      .onNotification(AGENT_METHODS.session_cancel, async () => { resolvePrompt?.({ stopReason: 'cancelled' }); })
      .onRequest(AGENT_METHODS.session_prompt, () => new Promise((resolve) => { resolvePrompt = resolve; }));
    mocks.bridge.current!.registerAgent(AGENT_ID, app, {});

    const runPromise = receive({ id: 'disconnect-run', type: 'agent.run', origin: 'https://example.test', payload: { task: 't' } });
    await vi.waitFor(() => expect(resolvePrompt).not.toBeNull());

    disconnect();
    await runPromise;

    const terminal = terminalEventsFor('disconnect-run');
    expect(terminal).toHaveLength(1);
    expect(terminal[0].event).toMatchObject({ type: 'error', error: { code: 'ERR_ABORTED' } });
  });

  it('cancels the ACP run with ERR_PERMISSION_DENIED when model:prompt is revoked mid-run', async () => {
    let resolvePrompt: ((r: { stopReason: StopReason }) => void) | null = null;
    let sessionCancelled = false;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let notifyPromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => { notifyPromptStarted = resolve; });

    const app = buildAgentApp({ name: 'fake-agent' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 'sess-1' }))
      .onNotification(AGENT_METHODS.session_cancel, async () => {
        sessionCancelled = true;
        resolvePrompt?.({ stopReason: 'cancelled' });
      })
      .onRequest(AGENT_METHODS.session_prompt, async (ctx) => {
        // The backend's own pre-prompt grant check already passed (it's
        // still `true` at this point); signal, then wait for the test to
        // revoke the grant before sending the tool_call_update that
        // triggers the backend's next recheck.
        notifyPromptStarted();
        await gate;
        await ctx.client.notify('session/update', {
          sessionId: ctx.params.sessionId,
          update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' },
        });
        return new Promise((resolve) => { resolvePrompt = resolve; });
      });
    mocks.bridge.current!.registerAgent(AGENT_ID, app, {});

    mocks.hasPermission.mockResolvedValue(true);

    const runPromise = receive({ id: 'revoked-run', type: 'agent.run', origin: 'https://example.test', payload: { task: 't' } });
    await promptStarted;

    mocks.hasPermission.mockResolvedValue(false);
    releaseGate();
    await runPromise;

    expect(sessionCancelled).toBe(true);
    const terminal = terminalEventsFor('revoked-run');
    expect(terminal).toHaveLength(1);
    expect(terminal[0].event).toMatchObject({ type: 'error', error: { code: 'ERR_PERMISSION_DENIED' } });
  });
});
