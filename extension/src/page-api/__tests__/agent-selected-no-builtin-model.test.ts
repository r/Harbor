/**
 * With an agent selected, nothing a page does reaches Harbor's built-in
 * model: every model call runs on the agent (docs/ACP_BACKEND_DESIGN.md,
 * "everything that uses a model runs on it").
 *
 * This drives the real page port, harbor-core's dispatch, the extension
 * API router and the real policy engine. Only the bridge is stubbed: its
 * ACP channel is a fake bridge running a real ACP agent, and every other
 * bridge call is recorded. `afterEach` fails the test if any of them was
 * the built-in model's `llm.chat` or `llm.chat_stream`, so a new path
 * that forgets the agent fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent as buildAgentApp, AGENT_METHODS, CLIENT_METHODS, type StopReason } from '@agentclientprotocol/sdk';
import { getMockStorage, resetMockBrowser } from '../../__tests__/test-setup';

const mocks = vi.hoisted(() => ({
  closedChannels: [] as string[],
  bridge: { current: null as null | ReturnType<typeof import('./support/fake-acp-bridge').createFakeAcpBridge> },
}));

vi.mock('../../llm/chat', () => ({ bridgeChat: vi.fn() }));
vi.mock('../../llm/bridge-client', () => ({
  bridgeRequest: vi.fn(),
  bridgeStreamRequest: vi.fn(),
  getBridgeConnectionState: vi.fn(() => ({ connected: true, bridgeReady: true, error: undefined })),
  checkBridgeHealth: vi.fn(async () => true),
}));
vi.mock('../../mcp/host', () => ({
  listServersWithStatus: vi.fn(async () => []),
  callTool: vi.fn(),
  startServer: vi.fn(),
  stopServer: vi.fn(),
  listTools: vi.fn(async () => []),
}));
vi.mock('../../llm/native-bridge', () => ({ isNativeBridgeReady: vi.fn(() => true), rpcRequest: vi.fn() }));
vi.mock('../../llm/provider-registry', () => ({
  listAllProviders: vi.fn(async () => []),
  getRuntimeCapabilities: vi.fn(async () => ({})),
}));
vi.mock('../../policy/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../policy/permissions')>()),
  showPermissionPrompt: vi.fn(),
}));
// The mocked module keeps its first module graph across vi.resetModules(),
// so tests reach Harbor's session registry, audit log and policy store
// through it (`__sessionRegistry`, `__audit`, `__policy`), not through a
// fresh import.
vi.mock('../harbor-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harbor-core')>()),
  __sessionRegistry: (await import('../../sessions')).SessionRegistry,
  __audit: (await import('../../policy/audit')).Audit,
  __policy: (await import('../../policy/store')).Policy,
  acpOpenStream: (agentId: string, workspace: string) => mocks.bridge.current!.acpOpenStream(agentId, workspace),
  acpSend: (channel: string, message: unknown) => mocks.bridge.current!.acpSend(channel, message),
  acpClose: (channel: string) => {
    mocks.closedChannels.push(channel);
    return mocks.bridge.current!.acpClose(channel);
  },
}));

import { createFakeAcpBridge } from './support/fake-acp-bridge';

type Reply = { id?: string; ok?: boolean; code?: string; result?: unknown; error?: { code?: string; message: string }; event?: { type: string; token?: string; error?: { code?: string } }; done?: boolean };

const ORIGIN = 'https://a.example';
const AGENT_ID = 'test-agent';
const BUILTIN_MODEL_METHODS = ['llm.chat', 'llm.chat_stream'];

let onConnect: ((port: unknown) => void) | undefined;
let bridgeRequest: ReturnType<typeof vi.fn>;
let bridgeStreamRequest: ReturnType<typeof vi.fn>;
let bridgeChat: ReturnType<typeof vi.fn>;

function buildFakeAgent(reply: string) {
  return buildAgentApp({ name: 'fake-agent' })
    .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
    .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 'sess-1' }))
    .onNotification(AGENT_METHODS.session_cancel, async () => {})
    .onRequest(AGENT_METHODS.session_prompt, async (ctx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ctx as any).client.notify(CLIENT_METHODS.session_update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } },
      });
      return { stopReason: 'end_turn' as StopReason };
    });
}

async function setAgent(agentId: string) {
  await getMockStorage().local.set({ harbor_agent_backend: { type: 'acp', agentId } });
}

/** Grants for whichever backend is selected right now (grants are per backend). */
async function grant(scopes: string[]) {
  const { grantPermissions } = await import('../../policy/permissions');
  await grantPermissions(ORIGIN, scopes as never, 'granted-always');
}

function connectPort() {
  const listeners: Array<(m: unknown) => void> = [];
  const posted: Reply[] = [];
  onConnect!({
    name: 'harbor-page-api',
    sender: { url: `${ORIGIN}/page`, tab: { id: 9 } },
    onMessage: { addListener: (l: (m: unknown) => void) => listeners.push(l) },
    onDisconnect: { addListener: () => {} },
    postMessage: (m: Reply) => posted.push(m),
  });
  let n = 0;
  const request = async (type: string, payload: unknown = {}): Promise<Reply> => {
    const id = `r${++n}`;
    listeners.forEach(l => l({ id, type, payload }));
    await vi.waitFor(() => expect(posted.some(p => p.id === id && (p.ok !== undefined || p.done))).toBe(true), { timeout: 3000 });
    return posted.find(p => p.id === id && (p.ok !== undefined || p.done))!;
  };
  const stream = async (type: string, payload: unknown): Promise<Reply[]> => {
    const id = `r${++n}`;
    listeners.forEach(l => l({ id, type, payload }));
    await vi.waitFor(() => expect(posted.some(p => p.id === id && p.done)).toBe(true), { timeout: 3000 });
    return posted.filter(p => p.id === id);
  };
  return { request, stream };
}

function streamedText(events: Reply[]): string {
  return events.filter(e => e.event?.type === 'token').map(e => e.event!.token).join('');
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  resetMockBrowser();

  const chromeGlobal = globalThis as unknown as { chrome: Record<string, unknown> };
  chromeGlobal.chrome.runtime = {
    ...(chromeGlobal.chrome.runtime as Record<string, unknown>),
    onConnect: { addListener: (l: (port: unknown) => void) => { onConnect = l; } },
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  chromeGlobal.chrome.tabs = {
    ...(chromeGlobal.chrome.tabs as Record<string, unknown>),
    onRemoved: { addListener: vi.fn() },
    get: vi.fn(async () => { throw new Error('no tab'); }),
  };

  mocks.closedChannels.length = 0;
  mocks.bridge.current = createFakeAcpBridge();
  mocks.bridge.current.registerAgent(AGENT_ID, buildFakeAgent('From the agent.'));

  const { initializePageApi } = await import('../background');
  bridgeRequest = vi.mocked((await import('../../llm/bridge-client')).bridgeRequest);
  bridgeStreamRequest = vi.mocked((await import('../../llm/bridge-client')).bridgeStreamRequest);
  bridgeChat = vi.mocked((await import('../../llm/chat')).bridgeChat);
  bridgeRequest.mockImplementation(async (method: string) => ({
    'llm.chat': { content: 'From the built-in model.' },
    'llm.model_locality': { is_local: true },
    'llm.list_providers': { providers: [{ id: 'ollama' }] },
    'llm.get_config': { default_model: 'ollama:llama3', providers: {} },
    'llm.list_configured_models': { models: [{ name: 'llama', model_id: 'ollama:llama3' }] },
    'llm.get_configured_models_metadata': { metadata: [{ model_id: 'ollama:llama3', is_local: true }] },
    'acp.get_agents': { agents: [{ id: AGENT_ID, name: 'Test Agent' }] },
  } as Record<string, unknown>)[method] ?? {});
  bridgeChat.mockResolvedValue({ content: 'From the built-in model.', model: 'ollama:llama3' });
  bridgeStreamRequest.mockImplementation(() => (async function* () {
    yield { type: 'token', token: 'From the built-in model.' };
    yield { type: 'done' };
  })());
  initializePageApi();
});

afterEach(async () => {
  const builtinCalls = [
    ...bridgeRequest.mock.calls.map(([method]) => method),
    ...bridgeStreamRequest.mock.calls.map(([method]) => method),
  ].filter(method => BUILTIN_MODEL_METHODS.includes(method));
  const directChats = bridgeChat.mock.calls.length;
  const { __policy: Policy } = await import('../harbor-core') as unknown as { __policy: typeof import('../../policy/store').Policy };
  Policy.__reset();
  vi.resetModules();
  expect(builtinCalls, 'a path reached the built-in model on the bridge').toEqual([]);
  expect(directChats, 'a path called bridgeChat').toBe(0);
});

describe('with an agent selected, agent.sessions run on it', () => {
  async function createSession(port: ReturnType<typeof connectPort>) {
    const created = await port.request('agent.sessions.create', {
      capabilities: { llm: {} },
      options: { systemPrompt: 'Be terse' },
    });
    expect(created.ok, created.error?.message).toBe(true);
    return (created.result as { sessionId: string }).sessionId;
  }

  it('prompt() is answered by the agent', async () => {
    await setAgent(AGENT_ID);
    await grant(['model:prompt']);
    const port = connectPort();
    const sessionId = await createSession(port);
    const reply = await port.request('session.prompt', { sessionId, input: 'Hi' });
    expect(reply.ok, reply.error?.message).toBe(true);
    expect(reply.result).toBe('From the agent.');
  });

  it('promptStreaming() is answered by the agent', async () => {
    await setAgent(AGENT_ID);
    await grant(['model:prompt']);
    const port = connectPort();
    const sessionId = await createSession(port);
    const events = await port.stream('session.promptStreaming', { sessionId, input: 'Hi' });
    expect(events.at(-1)?.event?.type).toBe('done');
    expect(streamedText(events)).toBe('From the agent.');
  });
});

describe('creating an agent.sessions session with model access on an agent', () => {
  it('is checked as a prompt to the agent, not to the built-in model', async () => {
    await setAgent(AGENT_ID);
    await grant(['model:prompt']);
    const port = connectPort();
    const created = await port.request('agent.sessions.create', { capabilities: { llm: {} } });
    expect(created.ok, created.error?.message).toBe(true);
    const { __audit: Audit } = await import('../harbor-core') as unknown as { __audit: typeof import('../../policy/audit').Audit };
    const actions = Audit.query({ origin: ORIGIN }).map((r) => r.action);
    expect(actions).toContain('model.prompt.agent');
    expect(actions.filter(a => a.startsWith('model.prompt.') && a !== 'model.prompt.agent')).toEqual([]);
    expect(bridgeRequest.mock.calls.map(([m]) => m)).not.toContain('llm.model_locality');
  });

  it('is refused by a rule denying prompts to the agent', async () => {
    await setAgent(AGENT_ID);
    await grant(['model:prompt']);
    const { __policy: Policy } = await import('../harbor-core') as unknown as { __policy: typeof import('../../policy/store').Policy };
    const { compileRule } = await import('../../policy/rules');
    Policy.__setForTesting([compileRule({ source: 'user', id: 'no-agent', effect: 'deny', principal: { origin: '*' }, action: 'model.prompt.agent' } as never)]);
    const created = await connectPort().request('agent.sessions.create', { capabilities: { llm: {} } });
    expect(created.ok).toBe(false);
    expect(mocks.bridge.current!.openCalls).toEqual([]);
  });
});

describe('the agent behind an agent.sessions session', () => {
  it('ends when the page terminates the session', async () => {
    await setAgent(AGENT_ID);
    await grant(['model:prompt']);
    const port = connectPort();
    const created = await port.request('agent.sessions.create', { capabilities: { llm: {} } });
    const sessionId = (created.result as { sessionId: string }).sessionId;
    expect(mocks.closedChannels).toEqual([]);
    const terminated = await port.request('agent.sessions.terminate', { sessionId });
    expect(terminated.ok, terminated.error?.message).toBe(true);
    expect(mocks.closedChannels).toHaveLength(1);
    const reply = await port.request('session.prompt', { sessionId, input: 'Hi' });
    expect(reply.error?.code).toBe('ERR_SESSION_NOT_FOUND');
  });

  /** Ages a session in Harbor's registry, then runs its periodic sweep. */
  async function ageAndSweep(sessionId: string, change: (s: { lastActiveAt: number; capabilities: { limits?: { expiresAt?: number } } }) => void) {
    const core = await import('../harbor-core') as unknown as { __sessionRegistry: { sessions: Map<string, never>; cleanupOldSessions(): void } };
    const registry = core.__sessionRegistry;
    change(registry.sessions.get(sessionId)!);
    registry.cleanupOldSessions();
  }

  it('ends when the session expires in Harbor, freeing its agent slot', async () => {
    await setAgent(AGENT_ID);
    await grant(['model:prompt']);
    const port = connectPort();
    const created = await port.request('agent.sessions.create', { capabilities: { llm: {} }, limits: { ttlMinutes: 1 } });
    expect(created.ok, created.error?.message).toBe(true);
    const sessionId = (created.result as { sessionId: string }).sessionId;
    expect(mocks.closedChannels).toEqual([]);
    await ageAndSweep(sessionId, (s) => { s.capabilities.limits!.expiresAt = Date.now() - 1; });
    await vi.waitFor(() => expect(mocks.closedChannels).toHaveLength(1));
    const reply = await port.request('session.prompt', { sessionId, input: 'Hi' });
    expect(reply.error?.code).toBe('ERR_SESSION_NOT_FOUND');
    // The site's agent slot is free again: it can start a new session.
    const again = await port.request('agent.sessions.create', { capabilities: { llm: {} } });
    expect(again.ok, again.error?.message).toBe(true);
    const another = await port.request('agent.sessions.create', { capabilities: { llm: {} } });
    expect(another.ok, another.error?.message).toBe(true);
  });

  it('ends when Harbor drops the session for inactivity', async () => {
    await setAgent(AGENT_ID);
    await grant(['model:prompt']);
    const port = connectPort();
    const created = await port.request('agent.sessions.create', { capabilities: { llm: {} } });
    expect(created.ok, created.error?.message).toBe(true);
    const sessionId = (created.result as { sessionId: string }).sessionId;
    await ageAndSweep(sessionId, (s) => { s.lastActiveAt = Date.now() - 2 * 60 * 60_000; });
    await vi.waitFor(() => expect(mocks.closedChannels).toHaveLength(1));
  });

  it("failing to start doesn't leave a Harbor session behind", async () => {
    mocks.bridge.current!.registerAgent('broken-agent', buildFakeAgent('unused'), { failToStart: 'no such command' });
    await setAgent('broken-agent');
    await grant(['model:prompt']);
    const port = connectPort();
    const before = (await port.request('agent.sessions.list')).result as unknown[];
    const created = await port.request('agent.sessions.create', { capabilities: { llm: {} } });
    expect(created.ok).toBe(false);
    const after = (await port.request('agent.sessions.list')).result as unknown[];
    expect(after).toHaveLength(before.length);
  });

  it("doesn't start for a session without model access", async () => {
    await setAgent(AGENT_ID);
    await grant(['mcp:tools.call']);
    const port = connectPort();
    const created = await port.request('agent.sessions.create', { capabilities: { tools: ['time/now'] } });
    expect(created.ok, created.error?.message).toBe(true);
    expect(mocks.bridge.current!.openCalls).toEqual([]);
  });
});

describe('sessions made on the built-in model before an agent was picked', () => {
  it('a window.ai text session no longer reaches the built-in model', async () => {
    await grant(['model:prompt']);
    const port = connectPort();
    const created = await port.request('ai.createTextSession', {});
    expect(created.ok, created.error?.message).toBe(true);
    await setAgent(AGENT_ID);
    await grant(['model:prompt']);
    const reply = await port.request('session.prompt', { sessionId: created.result, input: 'Hi' });
    expect(reply.error?.code).toBe('ERR_SESSION_NOT_FOUND');
  });

  it('an agent.sessions session no longer reaches the built-in model', async () => {
    await grant(['model:prompt']);
    const port = connectPort();
    const created = await port.request('agent.sessions.create', { capabilities: { llm: {} } });
    expect(created.ok, created.error?.message).toBe(true);
    const sessionId = (created.result as { sessionId: string }).sessionId;
    await setAgent(AGENT_ID);
    await grant(['model:prompt']);
    const reply = await port.request('session.prompt', { sessionId, input: 'Hi' });
    expect(reply.error?.code).toBe('ERR_SESSION_NOT_FOUND');
    const events = await port.stream('session.promptStreaming', { sessionId, input: 'Hi' });
    expect(events.at(-1)?.event?.error?.code).toBe('ERR_SESSION_NOT_FOUND');
  });

  it("an agent.sessions session with model access is ended in Harbor's registry too", async () => {
    await grant(['model:prompt']);
    const port = connectPort();
    const created = await port.request('agent.sessions.create', { capabilities: { llm: {} } });
    const sessionId = (created.result as { sessionId: string }).sessionId;
    await setAgent(AGENT_ID);
    await vi.waitFor(async () => {
      const listed = (await port.request('agent.sessions.list')).result as Array<{ sessionId: string }>;
      expect(listed.map(s => s.sessionId)).not.toContain(sessionId);
    });
  });

  it('a tools-only agent.sessions session is left alone', async () => {
    await grant(['mcp:tools.call']);
    const port = connectPort();
    const created = await port.request('agent.sessions.create', { capabilities: { tools: ['time/now'] } });
    expect(created.ok, created.error?.message).toBe(true);
    const sessionId = (created.result as { sessionId: string }).sessionId;
    await setAgent(AGENT_ID);
    await new Promise(r => setTimeout(r, 50));
    const listed = (await port.request('agent.sessions.list')).result as Array<{ sessionId: string }>;
    expect(listed.map(s => s.sessionId)).toContain(sessionId);
    await grant(['model:prompt']);
    const reply = await port.request('session.prompt', { sessionId, input: 'Hi' });
    expect(reply.error?.message).toMatch(/does not have LLM access/);
  });
});

describe('a session created while the person switches agents', () => {
  /**
   * Selects `agentId` while the create handler's own read of the agent
   * setting is in flight, so that read still sees the old value. (The
   * permission check reads the setting first; this waits for the handler.)
   */
  function switchDuringNextBackendRead(agentId: string) {
    const local = getMockStorage().local;
    const original = local.get.bind(local);
    let done = false;
    vi.spyOn(local, 'get').mockImplementation(async (keys?: unknown) => {
      const fromCreate = /handleAiCreateTextSession|handleSessionsCreate/.test(new Error().stack ?? '');
      const value = await original(keys as never);
      if (!done && fromCreate && keys === 'harbor_agent_backend') {
        done = true;
        await local.set({ harbor_agent_backend: { type: 'acp', agentId } });
      }
      return value;
    });
  }

  it.each([
    ['ai.createTextSession', {}],
    ['agent.sessions.create', { capabilities: { llm: {} } }],
  ])("%s doesn't outlive the switch", async (type, payload) => {
    await grant(['model:prompt']);
    const port = connectPort();
    switchDuringNextBackendRead(AGENT_ID);
    const created = await port.request(type, payload);
    expect(created.ok).toBe(false);
    expect(created.error?.message).toMatch(/agent was changed/i);
  });
});

describe('with an agent selected, provider info reports the agent', () => {
  beforeEach(async () => {
    await setAgent(AGENT_ID);
    await grant(['model:list']);
  });

  it('providers.list() lists the agent alone', async () => {
    const reply = await connectPort().request('ai.providers.list');
    expect(reply.ok, reply.error?.message).toBe(true);
    expect(reply.result).toEqual([
      { id: AGENT_ID, type: 'agent', name: 'Test Agent', available: true, isDefault: true },
    ]);
  });

  it('providers.getActive() names the agent and no model', async () => {
    const reply = await connectPort().request('ai.providers.getActive');
    expect(reply.ok, reply.error?.message).toBe(true);
    expect(reply.result).toEqual({ provider: AGENT_ID, model: null });
  });

  it.each(['ai.providers.listConfiguredModels', 'ai.providers.getConfiguredModelsMetadata'])(
    '%s is empty: the agent picks its own model',
    async (type) => {
      const reply = await connectPort().request(type);
      expect(reply.ok, reply.error?.message).toBe(true);
      expect(reply.result).toEqual([]);
    },
  );
});

describe("Harbor's extension API with an agent selected", () => {
  it('refuses llm.chat instead of using the built-in model', async () => {
    await setAgent(AGENT_ID);
    await grant(['model:prompt']);
    const { routeExtensionApiMessage } = await import('../../extension-api');
    const reply = await routeExtensionApiMessage(
      { type: 'llm.chat', payload: { origin: ORIGIN, tabId: 9, messages: [{ role: 'user', content: 'Hi' }] } } as never,
      { id: chrome.runtime.id },
    );
    expect(reply.ok).toBe(false);
    expect(reply.code).toBe('ERR_AGENT_FAILED');
    expect(reply.error).toMatch(/agent/i);
  });

  it('refuses llm.chatStream instead of using the built-in model', async () => {
    await setAgent(AGENT_ID);
    await grant(['model:prompt']);
    const { streamLlmChat } = await import('../../extension-api');
    const events = [];
    for await (const event of streamLlmChat({ origin: ORIGIN, tabId: 9, messages: [{ role: 'user', content: 'Hi' }] })) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'error', error: { code: 'ERR_AGENT_FAILED', message: expect.stringMatching(/agent/i) } }]);
  });
});

/**
 * Selects `agentId` right after a read of the agent setting whose call stack
 * matches `predicate`, so that read still sees the old value: a switch
 * landing at that exact point.
 */
function switchAfterRead(predicate: (stack: string) => boolean, agentId: string) {
  const local = getMockStorage().local;
  const original = local.get.bind(local);
  let done = false;
  vi.spyOn(local, 'get').mockImplementation(async (keys?: unknown) => {
    const stack = new Error().stack ?? '';
    const value = await original(keys as never);
    if (!done && keys === 'harbor_agent_backend' && predicate(stack)) {
      done = true;
      await local.set({ harbor_agent_backend: { type: 'acp', agentId } });
    }
    return value;
  });
}

describe('an agent switch landing mid-call', () => {
  it("doesn't let llm.chat reach the built-in model when it lands during the policy check", async () => {
    await grant(['model:prompt']);
    switchAfterRead(s => /builtinModelRefusal/.test(s), AGENT_ID);
    const { routeExtensionApiMessage } = await import('../../extension-api');
    const reply = await routeExtensionApiMessage(
      { type: 'llm.chat', payload: { origin: ORIGIN, tabId: 9, messages: [{ role: 'user', content: 'Hi' }] } } as never,
      { id: chrome.runtime.id },
    );
    expect(reply.ok).toBe(false);
    expect(reply.code).toBe('ERR_AGENT_FAILED');
  });

  it("doesn't let llm.chatStream reach the built-in model when it lands during the policy check", async () => {
    await grant(['model:prompt']);
    switchAfterRead(s => /builtinModelRefusal/.test(s), AGENT_ID);
    const { streamLlmChat } = await import('../../extension-api');
    const events = [];
    for await (const event of streamLlmChat({ origin: ORIGIN, tabId: 9, messages: [{ role: 'user', content: 'Hi' }] })) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ERR_AGENT_FAILED' } });
  });

  it("doesn't start the agent for an agent.sessions session whose create was checked for the built-in model", async () => {
    await grant(['model:prompt']);
    const { __policy: Policy } = await import('../harbor-core') as unknown as { __policy: typeof import('../../policy/store').Policy };
    const { compileRule } = await import('../../policy/rules');
    Policy.__setForTesting([compileRule({ source: 'user', id: 'no-agent', effect: 'deny', principal: { origin: '*' }, action: 'model.prompt.agent' } as never)]);
    const port = connectPort();
    switchAfterRead(s => /promptCheck/.test(s), AGENT_ID);
    const created = await port.request('agent.sessions.create', { capabilities: { llm: {} } });
    expect(created.ok).toBe(false);
    expect(created.error?.message).toMatch(/agent was changed/i);
    expect(mocks.bridge.current!.openCalls).toEqual([]);
  });

  it.each([
    ['ai.createTextSession', {}],
    ['agent.sessions.create', { capabilities: { llm: {} } }],
  ])('%s says the agent was changed when it lands while the agent is starting', async (type, payload) => {
    let releaseInit!: () => void;
    const initStarted = new Promise<void>((started) => {
      mocks.bridge.current!.registerAgent('slow-agent', buildAgentApp({ name: 'slow' })
        .onRequest(AGENT_METHODS.initialize, async () => {
          started();
          await new Promise<void>((r) => { releaseInit = r; });
          return { protocolVersion: 1 };
        })
        .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }))
        .onNotification(AGENT_METHODS.session_cancel, async () => {}));
    });
    await setAgent('slow-agent');
    await grant(['model:prompt']);
    const port = connectPort();
    const pending = port.request(type, payload);
    await initStarted;
    await setAgent(AGENT_ID);
    releaseInit();
    const created = await pending;
    expect(created.ok).toBe(false);
    expect(created.error?.code).toBe('ERR_AGENT_FAILED');
    expect(created.error?.message).toMatch(/agent was changed/i);
  });
});

describe('prompts on an agent.sessions session that runs on an agent', () => {
  it("count as the session's activity, so Harbor doesn't drop a session in use", async () => {
    await setAgent(AGENT_ID);
    await grant(['model:prompt']);
    const port = connectPort();
    const created = await port.request('agent.sessions.create', { capabilities: { llm: {} } });
    const sessionId = (created.result as { sessionId: string }).sessionId;
    const core = await import('../harbor-core') as unknown as { __sessionRegistry: { sessions: Map<string, { lastActiveAt: number; usage: { promptCount: number } }>; cleanupOldSessions(): void } };
    const session = core.__sessionRegistry.sessions.get(sessionId)!;
    session.lastActiveAt = Date.now() - 2 * 60 * 60_000;
    expect((await port.request('session.prompt', { sessionId, input: 'Hi' })).ok).toBe(true);
    const events = await port.stream('session.promptStreaming', { sessionId, input: 'Again' });
    expect(events.at(-1)?.event?.type).toBe('done');
    await vi.waitFor(() => expect(session.usage.promptCount).toBe(2));
    core.__sessionRegistry.cleanupOldSessions();
    expect(mocks.closedChannels).toEqual([]);
    expect((await port.request('session.prompt', { sessionId, input: 'Still here?' })).ok).toBe(true);
  });
});
