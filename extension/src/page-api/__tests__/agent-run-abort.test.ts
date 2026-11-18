import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The content script posts {type:'abort', id} on the port when the page
// breaks its for-await loop (injected.ts's createStreamIterable.return()),
// and the port disconnects outright when a tab closes or navigates. Either
// way, an in-flight agent.run must stop calling the model and end its
// stream with one terminal event — not keep going after the page has
// already stopped listening.

const mocks = vi.hoisted(() => ({
  harborRequest: vi.fn(), hasPermission: vi.fn(), getFeatureFlags: vi.fn(),
  harborStreamRequest: vi.fn(), resolveTextSession: vi.fn(),
}));
vi.mock('../harbor-core', () => ({
  harborRequest: mocks.harborRequest, harborStreamRequest: mocks.harborStreamRequest,
}));
vi.mock('../policy/feature-flags', () => ({ getFeatureFlags: mocks.getFeatureFlags }));
vi.mock('../handlers', () => ({
  routeMessage: vi.fn(), isStreamingMessage: vi.fn(), hasPermission: mocks.hasPermission,
  getPermissions: async () => ({ scopes: {}, allowedTools: [] }),
  resolveTextSession: mocks.resolveTextSession, recordExplicitPrompt: vi.fn(),
  restoreSpawnedTabs: vi.fn(), handleTabRemoved: vi.fn(), getAllSpawnedTabs: vi.fn(),
  isSpawnedTab: vi.fn(), handleIncomingInvocation: vi.fn(), resolveInvocationResponse: vi.fn(),
  cleanupAgentsForTab: vi.fn(), agentInvocationTabs: new Map(),
}));

let receive: (message: unknown) => Promise<void>;
let disconnect: () => void;
let postMessage: ReturnType<typeof vi.fn>;

function toolCallResponse(callId: string) {
  return {
    content: '',
    choices: [{ message: { role: 'assistant', content: '', tool_calls: [
      { id: callId, function: { name: 'clock_time', arguments: '{}' } },
    ] } }],
  };
}

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  mocks.getFeatureFlags.mockResolvedValue({ toolCalling: true });
  mocks.hasPermission.mockResolvedValue(true);
  const event = () => ({ addListener: vi.fn() });
  const onConnect = event();
  vi.stubGlobal('chrome', {
    tabs: { onRemoved: event() }, windows: { onRemoved: event() },
    runtime: { onConnect, onMessage: event(), onMessageExternal: event() },
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

describe('agent.run cancellation at the background port boundary', () => {
  it('stops calling the model after an {type: "abort"} message and ends the stream once', async () => {
    let chatCalls = 0;
    let resolveFirstChat!: (value: unknown) => void;
    mocks.harborRequest.mockImplementation(async (method: string) => {
      if (method === 'mcp.listTools') return { tools: [{ name: 'time', serverId: 'clock' }] };
      if (method === 'mcp.callTool') return { result: 'noon' };
      if (method === 'llm.chat') {
        chatCalls++;
        return new Promise((resolve) => { resolveFirstChat = resolve; });
      }
      throw new Error(`unexpected ${method}`);
    });

    const runPromise = receive({
      id: 'abort-run', type: 'agent.run', origin: 'https://example.test',
      payload: { task: 'keep going forever' },
    });

    await vi.waitFor(() => expect(chatCalls).toBe(1));

    // The page broke its for-await loop; the content script posted abort.
    await receive({ type: 'abort', id: 'abort-run' });

    // The in-flight llm.chat call was already running; it resolves with
    // another tool call, as a slow backend would.
    resolveFirstChat(toolCallResponse('call-1'));

    await runPromise;

    // No further llm.chat call after the abort — neither for the tool
    // call's turn nor any later one.
    expect(chatCalls).toBe(1);
    expect(mocks.harborRequest).not.toHaveBeenCalledWith('mcp.callTool', expect.anything());

    const terminal = postMessage.mock.calls.map(([m]) => m).filter((m) => m.id === 'abort-run' && m.done);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].event).toMatchObject({ type: 'error', error: { code: 'ERR_ABORTED' } });
  });

  it('aborts every in-flight run on this port when the port disconnects', async () => {
    let chatCalls = 0;
    let resolveFirstChat!: (value: unknown) => void;
    mocks.harborRequest.mockImplementation(async (method: string) => {
      if (method === 'mcp.listTools') return { tools: [] };
      if (method === 'llm.chat') {
        chatCalls++;
        return new Promise((resolve) => { resolveFirstChat = resolve; });
      }
      throw new Error(`unexpected ${method}`);
    });

    const runPromise = receive({
      id: 'disconnect-run', type: 'agent.run', origin: 'https://example.test',
      payload: { task: 'keep going forever' },
    });

    await vi.waitFor(() => expect(chatCalls).toBe(1));

    // Tab closed or navigated away: the port disconnects without an
    // explicit abort message.
    disconnect();

    resolveFirstChat(toolCallResponse('call-1'));

    await runPromise;

    expect(chatCalls).toBe(1);
    const terminal = postMessage.mock.calls.map(([m]) => m).filter((m) => m.id === 'disconnect-run' && m.done);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].event).toMatchObject({ type: 'error', error: { code: 'ERR_ABORTED' } });
  });
});
