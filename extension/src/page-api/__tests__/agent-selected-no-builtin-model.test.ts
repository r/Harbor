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
vi.mock('../harbor-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harbor-core')>()),
  acpOpenStream: (agentId: string, workspace: string) => mocks.bridge.current!.acpOpenStream(agentId, workspace),
  acpSend: (channel: string, message: unknown) => mocks.bridge.current!.acpSend(channel, message),
  acpClose: (channel: string) => mocks.bridge.current!.acpClose(channel),
}));

import { createFakeAcpBridge } from './support/fake-acp-bridge';

type Reply = { id?: string; ok?: boolean; result?: unknown; error?: { code?: string; message: string }; event?: { type: string; token?: string; error?: { code?: string } }; done?: boolean };

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

async function setAgent(agentId: string | null) {
  if (agentId) await getMockStorage().local.set({ harbor_agent_backend: { type: 'acp', agentId } });
  else await getMockStorage().local.remove('harbor_agent_backend');
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
  const { Policy } = await import('../../policy/store');
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

describe('sessions made on the built-in model before an agent was picked', () => {
  it('a window.ai text session no longer reaches the built-in model', async () => {
    await grant(['model:prompt']);
    const port = connectPort();
    const created = await port.request('ai.createTextSession', {});
    expect(created.ok, created.error?.message).toBe(true);
    await setAgent(AGENT_ID);
    await grant(['model:prompt']);
    const reply = await port.request('session.prompt', { sessionId: created.result, input: 'Hi' });
    expect(reply.ok).toBe(false);
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
    expect(reply.ok).toBe(false);
    const events = await port.stream('session.promptStreaming', { sessionId, input: 'Hi' });
    expect(events.at(-1)?.event?.type).toBe('error');
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
    expect(reply.error).toMatch(/agent/i);
  });
});
