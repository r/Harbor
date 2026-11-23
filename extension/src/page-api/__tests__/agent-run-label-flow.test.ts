import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';
import { agent, AGENT_METHODS } from '@agentclientprotocol/sdk';
import { createFakeAcpBridge } from './support/fake-acp-bridge';
import { installFakeMcpServer } from '../../mcp/__tests__/support/fake-mcp-server';

const mocks = vi.hoisted(() => ({
  bridge: { current: null as null | ReturnType<typeof createFakeAcpBridge> },
  rpcRequest: vi.fn(),
}));
vi.mock('../harbor-core', async importOriginal => ({
  ...(await importOriginal<typeof import('../harbor-core')>()),
  acpOpenStream: (agentId: string, workspace: string) => mocks.bridge.current!.acpOpenStream(agentId, workspace),
  acpSend: (channel: string, message: unknown) => mocks.bridge.current!.acpSend(channel, message),
  acpClose: (channel: string) => mocks.bridge.current!.acpClose(channel),
}));

vi.mock('../../policy/permissions', async importOriginal => ({
  ...(await importOriginal<typeof import('../../policy/permissions')>()),
  showPermissionPrompt: vi.fn(async () => ({ granted: true, grantType: 'granted-always' })),
}));

// Exercise the receiving page port, actual run loop, harbor-core dispatch and
// policy engine. Only model/bridge and installed-tool execution are faked;
// page-tool replies use the real per-connection registry. All content is dummy.
vi.mock('../../llm/chat', () => ({ bridgeChat: vi.fn() }));
vi.mock('../../llm/bridge-client', () => ({
  bridgeRequest: vi.fn(async () => ({ default_model: 'configured-cloud:dummy', is_local: false })),
  bridgeStreamRequest: vi.fn(),
  getBridgeConnectionState: vi.fn(() => ({ connected: false, bridgeReady: false })),
  checkBridgeHealth: vi.fn(async () => false),
}));
vi.mock('../../mcp/host', () => ({
  listServersWithStatus: vi.fn(async () => []), callTool: vi.fn(),
  startServer: vi.fn(), stopServer: vi.fn(), listTools: vi.fn(async () => []),
}));
vi.mock('../../llm/native-bridge', () => ({ isNativeBridgeReady: vi.fn(() => false), rpcRequest: mocks.rpcRequest }));
vi.mock('../../llm/provider-registry', () => ({
  listAllProviders: vi.fn(async () => []), getRuntimeCapabilities: vi.fn(async () => ({})),
}));

type Posted = { id?: string; type?: string; callId?: string; done?: boolean; event?: { type: string; error?: { code: string } } };
let onConnect: (port: unknown) => void;
const ORIGIN = 'https://accounts.google.com';

beforeEach(async () => {
  vi.clearAllMocks();
  const host = await import('../../mcp/host');
  vi.mocked(host.listServersWithStatus).mockResolvedValue([]);
  resetMockBrowser();
  mocks.bridge.current = createFakeAcpBridge();
  mocks.rpcRequest.mockImplementation(async method => {
    if (method === 'page_tools.open') return { endpointId: 'dummy-endpoint', url: 'http://127.0.0.1:4555/mcp/dummy' };
    if (method === 'page_tools.close') return {};
    throw new Error('Unexpected bridge RPC');
  });
  Object.assign(chrome.runtime, { onConnect: { addListener: (l: typeof onConnect) => { onConnect = l; } } });
  Object.assign(chrome.tabs, { onRemoved: { addListener: vi.fn() }, get: vi.fn(async () => { throw new Error('no tab'); }) });
  const { initializePageApi } = await import('../background');
  initializePageApi();
  const { grantPermissions } = await import('../../policy/permissions');
  await grantPermissions(ORIGIN, ['model:prompt', 'model:tools'], 'granted-always');
});

afterEach(async () => {
  (await import('../../policy/audit')).Audit.clear();
  (await import('../../policy/store')).Policy.__reset();
  (await import('../../mcp/site-servers')).resetSiteMcpServersForTests();
  vi.unstubAllGlobals();
});

function connect(origin = ORIGIN, tabId = 9, toolError = false) {
  const listeners: Array<(m: unknown) => unknown> = [];
  const posted: Posted[] = [];
  const send = async (message: unknown) => { await Promise.all(listeners.map(l => l(message))); };
  onConnect({
    name: 'harbor-page-api', sender: { url: `${origin}/dummy`, tab: { id: tabId } },
    onMessage: { addListener: (l: (m: unknown) => unknown) => listeners.push(l) },
    onDisconnect: { addListener: vi.fn() },
    postMessage: (message: Posted) => {
      posted.push(message);
      if (message.type === 'page_tools.call') {
        void send({ type: 'page_tools.result', callId: message.callId, ok: !toolError,
          result: 'DUMMY-SENSITIVE-RESULT', error: { message: 'DUMMY-SENSITIVE-ERROR' } });
      }
    },
  });
  return { send, posted };
}

async function offerTool(port: ReturnType<typeof connect>) {
  await port.send({ id: 'sync', type: 'page_tools.sync', payload: { tools: [{ name: 'read_dummy', description: 'Read dummy', inputSchema: { type: 'object' } }] } });
}

function toolReply() {
  return { content: '', choices: [{ message: { role: 'assistant', content: '', tool_calls: [
    { id: 'dummy-call', function: { name: 'page_accounts_google_com_read_dummy', arguments: '{}' } },
  ] } }] };
}

async function start(port: ReturnType<typeof connect>, id: string, maxToolCalls = 5) {
  await port.send({ id, type: 'agent.run', payload: { task: 'Use the dummy tool', maxToolCalls } });
  await vi.waitFor(() => expect(port.posted.some(p => p.id === id && p.done)).toBe(true));
}

describe('run-scoped labels at the model boundary', () => {
  it.each([1, 5])('blocks sensitive page output before the next model call (budget %s)', async max => {
    const { bridgeChat } = await import('../../llm/chat');
    vi.mocked(bridgeChat).mockResolvedValueOnce(toolReply() as never).mockResolvedValue({ content: 'unused' } as never);
    const port = connect();
    await offerTool(port);
    await start(port, 'sensitive', max);
    expect(port.posted.some(p => p.type === 'page_tools.call')).toBe(true);
    expect(bridgeChat).toHaveBeenCalledTimes(1);
    expect(port.posted.find(p => p.id === 'sensitive' && p.done)?.event?.error?.code).toBe('ERR_LABEL_FLOW_BLOCKED');
    const { Audit } = await import('../../policy/audit');
    expect(Audit.query({ origin: ORIGIN, action: 'model.prompt.remote.firstParty' }).some(r => r.errorCode === 'ERR_LABEL_FLOW_BLOCKED')).toBe(true);
  });

  it('blocks sensitive tool error text before a later prompt', async () => {
    const { bridgeChat } = await import('../../llm/chat');
    vi.mocked(bridgeChat).mockResolvedValueOnce(toolReply() as never).mockResolvedValue({ content: 'unused' } as never);
    const port = connect(ORIGIN, 9, true);
    await offerTool(port);
    await start(port, 'error');
    expect(bridgeChat).toHaveBeenCalledTimes(1);
    expect(port.posted.find(p => p.id === 'error' && p.done)?.event?.error?.code).toBe('ERR_LABEL_FLOW_BLOCKED');
  });

  it('labels the authenticated site origin on its registered server result', async () => {
    installFakeMcpServer({ tools: [{ name: 'read_dummy' }] });
    const { grantPermissions } = await import('../../policy/permissions');
    await grantPermissions(ORIGIN, ['mcp:servers.register'], 'granted-always');
    const port = connect();
    await port.send({ id: 'register', type: 'agent.mcp.register', payload: {
      name: 'dummy', url: 'https://accounts.google.com/mcp', transport: 'sse',
    } });
    expect(port.posted.find(p => p.id === 'register')).toMatchObject({ ok: true });
    const { bridgeChat } = await import('../../llm/chat');
    const reply = toolReply();
    reply.choices[0].message.tool_calls[0].function.name = 'site_accounts_google_com_dummy_read_dummy';
    vi.mocked(bridgeChat).mockResolvedValueOnce(reply as never).mockResolvedValue({ content: 'unused' } as never);
    await start(port, 'site');
    expect(bridgeChat).toHaveBeenCalledTimes(1);
    expect(port.posted.find(p => p.id === 'site' && p.done)?.event?.error?.code).toBe('ERR_LABEL_FLOW_BLOCKED');
  });

  it('carries page output labels into an installed-tool call in the same model turn', async () => {
    const host = await import('../../mcp/host');
    vi.mocked(host.listServersWithStatus).mockResolvedValue([{ id: 'dummy', running: true, tools: [{ name: 'send_dummy' }] }] as never);
    const { grantPermissions } = await import('../../policy/permissions');
    await grantPermissions(ORIGIN, ['mcp:tools.list', 'mcp:tools.call'], 'granted-always', undefined, ['dummy/send_dummy']);
    const { bridgeChat } = await import('../../llm/chat');
    const reply = toolReply();
    reply.choices[0].message.tool_calls.push({ id: 'outgoing', function: { name: 'dummy_send_dummy', arguments: '{}' } });
    vi.mocked(bridgeChat).mockResolvedValueOnce(reply as never).mockResolvedValue({ content: 'unused' } as never);
    const port = connect();
    await offerTool(port);
    await start(port, 'installed');
    expect(port.posted.some(p => p.type === 'page_tools.call')).toBe(true);
    expect(host.callTool).not.toHaveBeenCalled();
    const { Audit } = await import('../../policy/audit');
    expect(Audit.query({ origin: ORIGIN, action: 'tool.call' }).some(r => r.errorCode === 'ERR_LABEL_FLOW_BLOCKED')).toBe(true);
    expect(bridgeChat).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh flow for a later run on the same tab and origin', async () => {
    const { bridgeChat } = await import('../../llm/chat');
    vi.mocked(bridgeChat).mockResolvedValueOnce(toolReply() as never).mockResolvedValue({ content: 'clean run' } as never);
    const port = connect();
    await offerTool(port);
    await start(port, 'first');
    expect(bridgeChat).toHaveBeenCalledTimes(1);
    await start(port, 'second');
    expect(bridgeChat).toHaveBeenCalledTimes(2);
    expect(port.posted.find(p => p.id === 'second' && p.done)?.event).toEqual({ type: 'done' });
  });
});


describe('ACP run output boundary', () => {
  it.each([false, true])('withholds sensitive page output/error from the agent (error=%s)', async toolError => {
    await chrome.storage.local.set({ harbor_agent_backend: { type: 'acp', agentId: 'dummy-agent' } });
    const { grantPermissions } = await import('../../policy/permissions');
    await grantPermissions(ORIGIN, ['model:prompt', 'model:tools'], 'granted-always');
    const port = connect(ORIGIN, 9, toolError);
    await offerTool(port);
    const core = await import('../harbor-core');
    let received: unknown;
    const peer = agent({ name: 'dummy-peer' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 'dummy-session' }))
      .onRequest(AGENT_METHODS.session_prompt, async () => {
        received = await core.handlePageToolsHostRequest('page_tools.call', {
          endpointId: 'dummy-endpoint', name: 'read_dummy', arguments: {},
        });
        return { stopReason: 'end_turn' };
      });
    mocks.bridge.current!.registerAgent('dummy-agent', peer, {});
    await start(port, 'acp');
    expect(received).toMatchObject({ isError: true });
    expect(JSON.stringify(received)).not.toContain('DUMMY-SENSITIVE');
    const { Audit } = await import('../../policy/audit');
    expect(Audit.query({ origin: ORIGIN, action: 'model.prompt.agent' }).some(r => r.errorCode === 'ERR_LABEL_FLOW_BLOCKED')).toBe(true);
  });
});
