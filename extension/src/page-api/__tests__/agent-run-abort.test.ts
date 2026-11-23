import { LabelFlow } from '../../policy/label-flow';
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
  createLabelFlow: () => new LabelFlow(),
  describedBySite: (_origin: string, d?: string) => d,
  siteToolsForAgent: vi.fn(async () => []),
  openPageToolEndpointForAcp: vi.fn(async () => null), closePageToolEndpoint: vi.fn(async () => {}),
  pageToolsForAgent: vi.fn(async () => null),
  syncPageTools: vi.fn(), resolvePageToolResult: vi.fn(), forgetPageToolsForConnection: vi.fn(), forgetPageToolsInTab: vi.fn(),
  onHarborSessionEnded: vi.fn(() => () => {}),
  forgetAgentsInTab: vi.fn(),
  harborRequest: mocks.harborRequest, harborStreamRequest: mocks.harborStreamRequest,
}));
vi.mock('../policy/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../policy/feature-flags')>()),
  getFeatureFlags: mocks.getFeatureFlags,
}));
vi.mock('../handlers', () => ({
  routeMessage: vi.fn(), isStreamingMessage: vi.fn(), hasPermission: mocks.hasPermission,
  getPermissions: async () => ({ scopes: {}, allowedTools: [] }),
  resolveTextSession: mocks.resolveTextSession, recordExplicitPrompt: vi.fn(), forgetTextSession: vi.fn(),
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
  const { DEFAULT_FLAGS } = await import('../policy/feature-flag-set');
  mocks.getFeatureFlags.mockResolvedValue({ ...DEFAULT_FLAGS, toolCalling: true });
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
    expect(mocks.harborRequest.mock.calls.map(([method]) => method)).not.toContain('mcp.callTool');

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
  it('still aborts a run whose id a page reused after the earlier run with that id finished', async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.harborRequest.mockImplementation(async (method: string) => {
      if (method === 'mcp.listTools') return { tools: [] };
      if (method === 'llm.chat') return new Promise((resolve) => { resolvers.push(resolve); });
      throw new Error(`unexpected ${method}`);
    });
    const start = () => receive({
      id: 'reused', type: 'agent.run', origin: 'https://example.test', payload: { task: 't' },
    });

    const first = start();
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    const second = start();
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));

    // The first run finishes normally while the second is still waiting on the model.
    resolvers[0]({ content: 'done', choices: [{ message: { role: 'assistant', content: 'done' } }] });
    await first;

    // The page aborts the id; the second run must still see it.
    await receive({ type: 'abort', id: 'reused' });
    resolvers[1](toolCallResponse('call-2'));
    await second;

    expect(resolvers).toHaveLength(2);
    const terminal = postMessage.mock.calls.map(([m]) => m).filter((m) => m.id === 'reused' && m.done);
    expect(terminal.at(-1).event).toMatchObject({ type: 'error', error: { code: 'ERR_ABORTED' } });
  });

  it('reports ERR_ABORTED, not the answer, when the page aborts while the model is answering', async () => {
    let resolveChat!: (value: unknown) => void;
    mocks.harborRequest.mockImplementation(async (method: string) => {
      if (method === 'mcp.listTools') return { tools: [] };
      if (method === 'llm.chat') return new Promise((resolve) => { resolveChat = resolve; });
      throw new Error(`unexpected ${method}`);
    });
    const run = receive({ id: 'final-run', type: 'agent.run', origin: 'https://example.test', payload: { task: 't' } });
    await vi.waitFor(() => expect(resolveChat).toBeDefined());

    await receive({ type: 'abort', id: 'final-run' });
    resolveChat({ content: 'the answer', choices: [{ message: { role: 'assistant', content: 'the answer' } }] });
    await run;

    const events = postMessage.mock.calls.map(([m]) => m).filter((m) => m.id === 'final-run');
    expect(events.some((m) => typeof m.event?.token === 'string' && m.event.token.includes('"final"'))).toBe(false);
    const terminal = events.filter((m) => m.done);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].event).toMatchObject({ type: 'error', error: { code: 'ERR_ABORTED' } });
  });

  it('ignores abort messages without a string id', async () => {
    for (const id of [undefined, 42, { toString: () => 'x' }, null]) {
      await expect(receive({ type: 'abort', id })).resolves.toBeUndefined();
    }
    expect(mocks.harborRequest).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("passes the run's signal to its model and tool calls, so Harbor can drop one the run gave up on", async () => {
    let chatCalls = 0;
    mocks.harborRequest.mockImplementation(async (method: string) => {
      if (method === 'mcp.listTools') return { tools: [{ name: 'time', serverId: 'clock' }] };
      if (method === 'mcp.callTool') return { result: 'noon' };
      if (method === 'llm.chat') {
        chatCalls++;
        return chatCalls === 1 ? toolCallResponse('call-1') : { content: 'done', choices: [{ message: { role: 'assistant', content: 'done' } }] };
      }
      throw new Error(`unexpected ${method}`);
    });

    await receive({ id: 'signal-run', type: 'agent.run', origin: 'https://example.test', payload: { task: 'what time is it' } });

    const withSignal = (method: string) =>
      expect(mocks.harborRequest).toHaveBeenCalledWith(method, expect.anything(), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    withSignal('mcp.listTools');
    withSignal('llm.chat');
    withSignal('mcp.callTool');
  });

  it("passes the run's signal to the final model call after the tool budget runs out", async () => {
    mocks.harborRequest.mockImplementation(async (method: string) => {
      if (method === 'mcp.listTools') return { tools: [{ name: 'time', serverId: 'clock' }] };
      if (method === 'mcp.callTool') return { result: 'noon' };
      if (method === 'llm.chat') return toolCallResponse(`call-${Math.random()}`);
      throw new Error(`unexpected ${method}`);
    });

    await receive({ id: 'budget-run', type: 'agent.run', origin: 'https://example.test', payload: { task: 'loop', maxToolCalls: 1 } });

    const chats = mocks.harborRequest.mock.calls.filter(([method]) => method === 'llm.chat');
    expect(chats.length).toBeGreaterThan(1); // the loop's call(s) plus the final one
    for (const [, , options] of chats) expect(options).toEqual({ signal: expect.any(AbortSignal), labelFlow: expect.any(LabelFlow) });
  });
});
