/**
 * A prompt Harbor's policy engine refuses reaches the page with the
 * engine's code (ERR_QUARANTINED, ERR_BLOCKED_BY_POLICY,
 * ERR_PERMISSION_DENIED), whether the page prompts once, streams, or runs
 * an agent. A model that fails is still ERR_MODEL_FAILED.
 *
 * This drives the real page port, page handlers, harbor-core, the policy
 * gate and the policy engine. Only the bridge and the prompt UI are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';

const bridge = vi.hoisted(() => ({ chat: vi.fn(), stream: vi.fn() }));

vi.mock('../../llm/chat', () => ({ bridgeChat: bridge.chat }));
vi.mock('../../llm/bridge-client', () => ({
  bridgeRequest: vi.fn(async () => ({ default_model: 'ollama:test' })),
  bridgeStreamRequest: bridge.stream,
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

type Listener = (port: unknown) => void;
type Posted = {
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message: string };
  event?: { type: string; error?: { code?: string; message: string } };
  done?: boolean;
};

const ORIGIN = 'https://a.example';
let onConnect: Listener;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  resetMockBrowser();
  bridge.chat.mockResolvedValue({
    choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    model: 'ollama:test',
  });
  bridge.stream.mockImplementation(async function* () {
    yield { type: 'token', token: 'hi' };
    yield { type: 'done' };
  });

  const chromeGlobal = globalThis as unknown as { chrome: Record<string, unknown> };
  chromeGlobal.chrome.runtime = {
    ...(chromeGlobal.chrome.runtime as Record<string, unknown>),
    onConnect: { addListener: (l: Listener) => { onConnect = l; } },
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  chromeGlobal.chrome.tabs = {
    ...(chromeGlobal.chrome.tabs as Record<string, unknown>),
    onRemoved: { addListener: vi.fn() },
    get: vi.fn(async () => { throw new Error('no tab'); }),
  };

  const { initializePageApi } = await import('../background');
  const { grantPermissions } = await import('../../policy/permissions');
  await grantPermissions(ORIGIN, ['model:prompt', 'model:tools', 'mcp:tools.list', 'mcp:tools.call'], 'granted-always');
  initializePageApi();
});

afterEach(async () => {
  const { Policy } = await import('../../policy/store');
  Policy.__reset();
  vi.resetModules();
});

function connectPort() {
  const listeners: Array<(m: unknown) => void> = [];
  const posted: Posted[] = [];
  onConnect({
    name: 'harbor-page-api',
    sender: { url: `${ORIGIN}/page`, tab: { id: 9 } },
    onMessage: { addListener: (l: (m: unknown) => void) => listeners.push(l) },
    onDisconnect: { addListener: () => {} },
    postMessage: (m: Posted) => posted.push(m),
  });
  let n = 0;
  const send = (type: string, payload: unknown) => {
    const id = `r${++n}`;
    listeners.forEach(l => l({ id, type, payload }));
    return id;
  };
  /** A one-shot request's reply. */
  const request = async (type: string, payload: unknown): Promise<Posted> => {
    const id = send(type, payload);
    await vi.waitFor(() => expect(posted.some(p => p.id === id)).toBe(true));
    return posted.find(p => p.id === id)!;
  };
  /** The error event that ends a stream. */
  const streamError = async (type: string, payload: unknown) => {
    const id = send(type, payload);
    await vi.waitFor(() => expect(posted.some(p => p.id === id && p.done)).toBe(true));
    return posted.find(p => p.id === id && p.done)!.event?.error;
  };
  return { request, streamError };
}

async function textSession(request: ReturnType<typeof connectPort>['request']) {
  const created = await request('ai.createTextSession', {});
  expect(created.ok, created.error?.message).toBe(true);
  return created.result as string;
}

async function quarantine() {
  const { Watchdog } = await import('../../policy/watchdog');
  const { setWatchdogResolver } = await import('../../policy/engine');
  setWatchdogResolver(Watchdog.resolve);
  Watchdog.quarantine(ORIGIN, 'test');
}

async function denyPrompts() {
  const { Policy } = await import('../../policy/store');
  const { compileRule } = await import('../../policy/rules');
  Policy.__setForTesting([
    compileRule({ id: 'no-prompts', effect: 'deny', principal: { origin: '*' }, action: 'model.prompt.local', source: 'user' } as never),
  ]);
}

async function askForPrompts() {
  const { Policy } = await import('../../policy/store');
  const { compileRule } = await import('../../policy/rules');
  Policy.__setForTesting([
    compileRule({ id: 'ask-prompts', effect: 'ask', principal: { origin: '*' }, action: 'model.prompt.local', source: 'user' } as never),
  ]);
}

describe('a prompt the policy engine refuses', () => {
  it('reports ERR_QUARANTINED on session.prompt', async () => {
    const { request } = connectPort();
    const sessionId = await textSession(request);
    await quarantine();

    const reply = await request('session.prompt', { sessionId, input: 'Hi' });
    expect(reply.error?.code).toBe('ERR_QUARANTINED');
    expect(bridge.chat).not.toHaveBeenCalled();
  });

  it('reports ERR_BLOCKED_BY_POLICY on session.prompt for a deny rule', async () => {
    const { request } = connectPort();
    const sessionId = await textSession(request);
    await denyPrompts();

    const reply = await request('session.prompt', { sessionId, input: 'Hi' });
    expect(reply.error?.code).toBe('ERR_BLOCKED_BY_POLICY');
  });

  it('reports ERR_QUARANTINED on session.promptStreaming', async () => {
    const { request, streamError } = connectPort();
    const sessionId = await textSession(request);
    await quarantine();

    const error = await streamError('session.promptStreaming', { sessionId, input: 'Hi' });
    expect(error?.code).toBe('ERR_QUARANTINED');
    expect(bridge.stream).not.toHaveBeenCalled();
  });

  it('reports ERR_BLOCKED_BY_POLICY on session.promptStreaming for a deny rule', async () => {
    const { request, streamError } = connectPort();
    const sessionId = await textSession(request);
    await denyPrompts();

    const error = await streamError('session.promptStreaming', { sessionId, input: 'Hi' });
    expect(error?.code).toBe('ERR_BLOCKED_BY_POLICY');
  });

  it('reports ERR_QUARANTINED on agent.run', async () => {
    const { streamError } = connectPort();
    await quarantine();

    const error = await streamError('agent.run', { task: 'What time is it?' });
    expect(error?.code).toBe('ERR_QUARANTINED');
    expect(bridge.chat).not.toHaveBeenCalled();
  });
});

describe('a prompt refusal reached mid-run or by prompt', () => {
  it('reports ERR_BLOCKED_BY_POLICY when agent.run\'s first model call is refused', async () => {
    const { streamError } = connectPort();
    await denyPrompts(); // the tool list is still allowed

    const error = await streamError('agent.run', { task: 'What time is it?' });
    expect(error?.code).toBe('ERR_BLOCKED_BY_POLICY');
    expect(bridge.chat).not.toHaveBeenCalled();
  });

  it('reports ERR_BLOCKED_BY_POLICY when agent.run\'s final-answer call is refused', async () => {
    const { streamError } = connectPort();
    await denyPrompts();

    // With no tool calls allowed, the run goes straight to its final answer.
    const error = await streamError('agent.run', { task: 'What time is it?', maxToolCalls: 0 });
    expect(error?.code).toBe('ERR_BLOCKED_BY_POLICY');
  });

  it('reports ERR_PERMISSION_DENIED when the person declines the prompt for session.prompt', async () => {
    const { showPermissionPrompt } = await import('../../policy/permissions');
    const { request } = connectPort();
    const sessionId = await textSession(request);
    await askForPrompts();
    vi.mocked(showPermissionPrompt).mockResolvedValueOnce({ granted: false } as never);

    const reply = await request('session.prompt', { sessionId, input: 'Hi' });
    expect(reply.error?.code).toBe('ERR_PERMISSION_DENIED');
    expect(showPermissionPrompt).toHaveBeenCalledTimes(1);
    expect(bridge.chat).not.toHaveBeenCalled();
  });

  it('reports ERR_PERMISSION_DENIED when the person declines the prompt for session.promptStreaming', async () => {
    const { showPermissionPrompt } = await import('../../policy/permissions');
    const { request, streamError } = connectPort();
    const sessionId = await textSession(request);
    await askForPrompts();
    vi.mocked(showPermissionPrompt).mockResolvedValueOnce({ granted: false } as never);

    const error = await streamError('session.promptStreaming', { sessionId, input: 'Hi' });
    expect(error?.code).toBe('ERR_PERMISSION_DENIED');
    expect(bridge.stream).not.toHaveBeenCalled();
  });
});

describe('a model that fails', () => {
  it('is still ERR_MODEL_FAILED on session.prompt', async () => {
    const { request } = connectPort();
    const sessionId = await textSession(request);
    bridge.chat.mockRejectedValueOnce(Object.assign(new Error('model down'), { code: 'ERR_QUARANTINED' }));

    const reply = await request('session.prompt', { sessionId, input: 'Hi' });
    expect(reply.error?.code).toBe('ERR_MODEL_FAILED');
  });

  it('is still ERR_MODEL_FAILED on session.promptStreaming', async () => {
    const { request, streamError } = connectPort();
    const sessionId = await textSession(request);
    bridge.stream.mockImplementationOnce(async function* () {
      yield { type: 'error', error: { code: -32000, message: 'model down' } };
    });

    const error = await streamError('session.promptStreaming', { sessionId, input: 'Hi' });
    expect(error).toEqual({ code: 'ERR_MODEL_FAILED', message: 'model down' });
  });
});
