import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent as buildAgentApp, AGENT_METHODS, CLIENT_METHODS, type StopReason } from '@agentclientprotocol/sdk';

// HBR-174: Harbor keeps its own record of every turn on the person's own
// agent, whatever the page does with the result. These drive each of the
// three page APIs that reach the agent (window.ai, agent.sessions,
// agent.run) through the real background port, against a fake bridge whose
// agent is a real ACP SDK app, and read the record Harbor kept.

const mocks = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  getFeatureFlags: vi.fn(),
  harborRequest: vi.fn(),
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
    forgetSiteServersInTab: vi.fn(),
    harborRequest: mocks.harborRequest,
    harborStreamRequest: vi.fn(),
    acpOpenStream: (agentId: string, workspace: string) => mocks.bridge.current!.acpOpenStream(agentId, workspace),
    acpSend: (channel: string, message: unknown) => mocks.bridge.current!.acpSend(channel, message),
    acpClose: (channel: string) => mocks.bridge.current!.acpClose(channel),
    checkAgentPromptAction: async () => null,
    requireAgentPromptAction: async () => true,
    isModelPromptGrantedForAgent: async () => true,
  });
});
vi.mock('../handlers/permission-handlers', async (importOriginal) => ({
  ...(await importOriginal<object>()), hasPermission: mocks.hasPermission,
}));
vi.mock('../policy/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../policy/feature-flags')>()),
  getFeatureFlags: mocks.getFeatureFlags,
}));
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

const AGENT_ID = 'turn-agent';
const ORIGIN = 'https://example.test';
const TOOL = { title: 'Edit notes.md', kind: 'edit' };

type TurnLog = typeof import('../agent-turns');
let turns: TurnLog;
let onConnectListener: (port: unknown) => void;
let nextTabId = 500;

interface Port {
  receive: (m: unknown) => Promise<void>;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: () => void;
}

function connectPort(): Port {
  let receiveFn: (m: unknown) => Promise<void> = async () => {};
  let disconnectFn: () => void = () => {};
  const postMessage = vi.fn();
  onConnectListener({
    name: 'harbor-page-api', sender: { url: `${ORIGIN}/page`, tab: { id: nextTabId++ } }, postMessage,
    onMessage: { addListener: (l: typeof receiveFn) => { receiveFn = l; } },
    onDisconnect: { addListener: (l: () => void) => { disconnectFn = l; } },
  });
  return { receive: (m) => receiveFn(m), postMessage, disconnect: () => disconnectFn() };
}

function responseFor(port: Port, id: string) {
  return port.postMessage.mock.calls.map(([m]) => m).find((m) => m.id === id);
}

/**
 * An agent that, on each prompt, reports one tool call and then either
 * answers (`hang: false`) or waits until Harbor cancels the turn.
 */
function registerAgent({ hang }: { hang: boolean }) {
  const state = { toolReported: false, cancelled: false };
  let resolvePrompt: ((r: { stopReason: StopReason }) => void) | null = null;
  const app = buildAgentApp({ name: 'fake-turn-agent' })
    .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
    .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 'sess-1' }))
    .onNotification(AGENT_METHODS.session_cancel, async () => {
      state.cancelled = true;
      resolvePrompt?.({ stopReason: 'cancelled' });
    })
    .onRequest(AGENT_METHODS.session_prompt, async (promptCtx) => {
      const sessionId = promptCtx.params.sessionId;
      await promptCtx.client.notify(CLIENT_METHODS.session_update, {
        sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: TOOL.title, kind: TOOL.kind, status: 'completed', rawInput: { path: 'notes.md' } },
      });
      state.toolReported = true;
      if (hang) return new Promise<{ stopReason: StopReason }>((resolve) => { resolvePrompt = resolve; });
      await promptCtx.client.notify(CLIENT_METHODS.session_update, {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } },
      });
      return { stopReason: 'end_turn' };
    });
  const bridge = createFakeAcpBridge();
  bridge.registerAgent(AGENT_ID, app, {});
  mocks.bridge.current = bridge;
  return state;
}

async function waitForToolRecorded() {
  await vi.waitFor(async () => {
    const all = await turns.listAgentTurns();
    expect(all.at(-1)?.tools).toHaveLength(1);
  });
}

async function lastTurn() {
  return (await turns.listAgentTurns()).at(-1)!;
}

// --- How each API starts a turn on the agent -------------------------------

interface ApiDriver {
  api: 'window.ai' | 'agent.sessions' | 'agent.run';
  /** Sends one turn with this prompt; resolves once the page has its terminal answer. `id` is the page's request id. */
  start: (port: Port, prompt: string, id: string) => Promise<() => Promise<void>>;
}

async function createTextSession(port: Port): Promise<string> {
  const id = crypto.randomUUID();
  await port.receive({ id, type: 'ai.createTextSession', payload: {} });
  return responseFor(port, id)!.result as string;
}

let explicitCount = 0;
async function createExplicitSession(port: Port): Promise<string> {
  const sessionId = `explicit-turn-${explicitCount++}`;
  mocks.harborRequest.mockImplementation(async (method: string) => {
    if (method === 'session.create') return { sessionId, capabilities: {} };
    // resolveTextSession asks Harbor whether an explicit session still has model access.
    if (method === 'session.get') return { session: { sessionId, capabilities: { hasLLM: true } } };
    return { bridgeReady: true };
  });
  const id = crypto.randomUUID();
  await port.receive({ id, type: 'agent.sessions.create', payload: { capabilities: { llm: {} }, options: {} } });
  expect(responseFor(port, id)).toMatchObject({ ok: true });
  return sessionId;
}

const drivers: ApiDriver[] = [
  {
    api: 'window.ai',
    start: async (port, prompt, id) => {
      const sessionId = await createTextSession(port);
      const done = port.receive({ id, type: 'session.promptStreaming', payload: { sessionId, input: prompt } });
      return () => done;
    },
  },
  {
    api: 'agent.sessions',
    start: async (port, prompt, id) => {
      const sessionId = await createExplicitSession(port);
      const done = port.receive({ id, type: 'session.promptStreaming', payload: { sessionId, input: prompt } });
      return () => done;
    },
  },
  {
    api: 'agent.run',
    start: async (port, prompt, id) => {
      const done = port.receive({ id, type: 'agent.run', origin: ORIGIN, payload: { task: prompt } });
      return () => done;
    },
  },
];

beforeAll(async () => {
  const onConnect = { addListener: vi.fn() };
  vi.stubGlobal('chrome', {
    storage: getMockStorage(),
    tabs: { onRemoved: { addListener: vi.fn() } },
    windows: { onRemoved: { addListener: vi.fn() } },
    runtime: { onConnect, onMessage: { addListener: vi.fn() }, onMessageExternal: { addListener: vi.fn() } },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
  });
  const { initializePageApi } = await import('../background');
  initializePageApi();
  turns = await import('../agent-turns');
  onConnectListener = onConnect.addListener.mock.calls[0][0] as typeof onConnectListener;
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.hasPermission.mockResolvedValue(true);
  mocks.getFeatureFlags.mockResolvedValue({ ...DEFAULT_FLAGS, toolCalling: true });
  mocks.harborRequest.mockImplementation(async () => ({ bridgeReady: true }));
  resetMockBrowser();
  await getMockStorage().local.set({ harbor_agent_backend: { type: 'acp', agentId: AGENT_ID } });
  const { resetAgentSlotsForTests } = await import('../acp-agent-limits');
  resetAgentSlotsForTests();
  await turns.__resetAgentTurnsForTests();
});

afterEach(() => { vi.useRealTimers(); });
afterAll(() => { vi.unstubAllGlobals(); });

describe.each(drivers)('a turn on the person\'s own agent through $api', (driver) => {
  it('is recorded with its site, prompt, tool calls and "answered", and stays unflagged', async () => {
    registerAgent({ hang: false });
    const port = connectPort();
    const wait = await driver.start(port, 'tidy my notes', 'turn-ok');
    await wait();

    expect(await lastTurn()).toMatchObject({
      origin: ORIGIN,
      api: driver.api,
      prompt: 'tidy my notes',
      tools: [TOOL],
      outcome: 'answered',
      unseen: false,
    });
    expect(await turns.unseenAgentTurnCount()).toBe(0);
  });

  it('is recorded as "cancelled" and flagged unseen when the page cancels it after a tool call', async () => {
    const agent = registerAgent({ hang: true });
    const port = connectPort();
    const wait = await driver.start(port, 'tidy my notes', 'turn-abort');
    await waitForToolRecorded();

    await port.receive({ type: 'abort', id: 'turn-abort' });
    await wait();

    expect(agent.cancelled).toBe(true);
    expect(await lastTurn()).toMatchObject({ api: driver.api, tools: [TOOL], outcome: 'cancelled', unseen: true });
    expect(await turns.unseenAgentTurnCount()).toBe(1);
  });

  it('is recorded as "cancelled" and flagged unseen when the page leaves mid-turn', async () => {
    const agent = registerAgent({ hang: true });
    const port = connectPort();
    const wait = await driver.start(port, 'tidy my notes', 'turn-left');
    await waitForToolRecorded();

    port.disconnect();
    await wait();
    await vi.waitFor(async () => expect((await lastTurn()).outcome).toBe('cancelled'));

    expect(agent.cancelled).toBe(true);
    expect(await lastTurn()).toMatchObject({ api: driver.api, tools: [TOOL], unseen: true });
    expect(await turns.unseenAgentTurnCount()).toBe(1);
  });
});

describe('a turn that runs past the per-turn timeout', () => {
  it('is recorded as "timed-out" and flagged unseen', async () => {
    registerAgent({ hang: true });
    const port = connectPort();
    const sessionId = await createTextSession(port);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const done = port.receive({ id: 'turn-timeout', type: 'session.promptStreaming', payload: { sessionId, input: 'slow job' } });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);
    await done;

    expect(await lastTurn()).toMatchObject({ api: 'window.ai', prompt: 'slow job', outcome: 'timed-out', unseen: true });
  });
});

describe('a turn whose agent fails', () => {
  it('is recorded as "failed"', async () => {
    const app = buildAgentApp({ name: 'failing-agent' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 'sess-1' }))
      .onRequest(AGENT_METHODS.session_prompt, async () => { throw new Error('boom'); });
    const bridge = createFakeAcpBridge();
    bridge.registerAgent(AGENT_ID, app, {});
    mocks.bridge.current = bridge;
    const port = connectPort();
    await port.receive({ id: 'turn-fail', type: 'agent.run', origin: ORIGIN, payload: { task: 'break' } });

    expect(await lastTurn()).toMatchObject({ api: 'agent.run', prompt: 'break', tools: [], outcome: 'failed', unseen: false });
  });
});
