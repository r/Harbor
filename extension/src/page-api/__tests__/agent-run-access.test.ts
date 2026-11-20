import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  harborRequest: vi.fn(), hasPermission: vi.fn(), getFeatureFlags: vi.fn(),
  harborStreamRequest: vi.fn(), resolveTextSession: vi.fn(),
  getPermissions: vi.fn(),
}));
vi.mock('../harbor-core', () => ({
  onHarborSessionEnded: vi.fn(() => () => {}),
  harborRequest: mocks.harborRequest, harborStreamRequest: mocks.harborStreamRequest,
}));
vi.mock('../policy/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<object>()), getFeatureFlags: mocks.getFeatureFlags,
}));
vi.mock('../handlers', () => ({
  routeMessage: vi.fn(), isStreamingMessage: vi.fn(), hasPermission: mocks.hasPermission,
  getPermissions: mocks.getPermissions,
  resolveTextSession: mocks.resolveTextSession, recordExplicitPrompt: vi.fn(),
  restoreSpawnedTabs: vi.fn(), handleTabRemoved: vi.fn(), getAllSpawnedTabs: vi.fn(),
  isSpawnedTab: vi.fn(), handleIncomingInvocation: vi.fn(), resolveInvocationResponse: vi.fn(),
  cleanupAgentsForTab: vi.fn(), agentInvocationTabs: new Map(),
}));

let receive: (message: unknown) => Promise<void>;
let postMessage: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  mocks.getFeatureFlags.mockResolvedValue({ toolCalling: true });
  mocks.hasPermission.mockResolvedValue(true);
  mocks.getPermissions.mockResolvedValue({ scopes: {}, allowedTools: [] });
  mocks.harborRequest.mockImplementation(async (method) => method === 'mcp.listTools'
    ? { tools: [] } : { content: 'The time is noon.' });
  const event = () => ({ addListener: vi.fn() });
  const onConnect = event();
  vi.stubGlobal('chrome', {
    tabs: { onRemoved: event() }, windows: { onRemoved: event() },
    runtime: { onConnect, onMessage: event(), onMessageExternal: event() },
  });
  const { initializePageApi } = await import('../background');
  initializePageApi();
  postMessage = vi.fn();
  onConnect.addListener.mock.calls[0][0]({
    name: 'harbor-page-api', sender: { url: 'https://example.test/page', tab: { id: 1 } }, postMessage,
    onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
  });
});
afterEach(() => vi.unstubAllGlobals());

async function run() {
  // This is the receiving port, bypassing the page's feature-disabled wrapper.
  await receive({ id: 'test-run', type: 'agent.run', origin: 'https://example.test',
    payload: { task: 'What time is it?' } });
}

describe('agent.run receiving boundary', () => {
  it('offers the built-in model only installed tools on the site allowlist', async () => {
    mocks.getPermissions.mockResolvedValue({ scopes: {}, allowedTools: ['clock/time'] });
    mocks.harborRequest.mockImplementation(async (method) => method === 'mcp.listTools'
      ? { tools: [{ serverId: 'clock', name: 'time' }, { serverId: 'private', name: 'read' }] }
      : { content: 'Noon' });
    await run();
    expect(mocks.harborRequest).toHaveBeenCalledWith('mcp.listTools',
      { origin: 'https://example.test', tabId: 1 }, expect.anything());
    const modelCall = mocks.harborRequest.mock.calls.find(([method]) => method === 'llm.chat');
    expect(modelCall?.[1].tools).toHaveLength(1);
    expect(modelCall?.[1].tools[0].name).toBe('clock_time');
  });

  it('rejects a direct transport request when Agentic Tool Use is off', async () => {
    mocks.getFeatureFlags.mockResolvedValue({ toolCalling: false });
    await run();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      done: true, event: expect.objectContaining({ error: expect.objectContaining({ code: 'ERR_FEATURE_DISABLED' }) }),
    }));
    expect(mocks.harborRequest).not.toHaveBeenCalled();
  });

  it.each(['model:prompt', 'model:tools'])('requires %s before model or tool requests', async (denied) => {
    mocks.hasPermission.mockImplementation(async (_origin, scope) => scope !== denied);
    await run();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      done: true, event: expect.objectContaining({ error: expect.objectContaining({
        code: 'ERR_PERMISSION_DENIED', message: `Permission ${denied} required`,
      }) }),
    }));
    expect(mocks.harborRequest).not.toHaveBeenCalled();
  });

  it('stops before the next model turn once model:prompt is revoked mid-run', async () => {
    const toolCall = { id: 'call-clock', function: { name: 'clock_time', arguments: '{}' } };
    let promptGranted = true;
    mocks.hasPermission.mockImplementation(async (_origin, scope) => scope !== 'model:prompt' || promptGranted);
    mocks.harborRequest.mockImplementation(async (method) => {
      if (method === 'mcp.listTools') return { tools: [{ name: 'time', serverId: 'clock' }] };
      if (method === 'mcp.callTool') { promptGranted = false; return { result: 'Noon' }; }
      return { content: '', choices: [{ message: { role: 'assistant', content: '', tool_calls: [toolCall] } }] };
    });
    await run();
    expect(mocks.harborRequest.mock.calls.filter(([m]) => m === 'llm.chat')).toHaveLength(1);
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      done: true, event: expect.objectContaining({ error: expect.objectContaining({
        code: 'ERR_PERMISSION_DENIED', message: 'Permission model:prompt required',
      }) }),
    }));
  });

  it('skips the final answer once model:prompt is revoked as the tool budget runs out', async () => {
    const toolCall = { id: 'call-clock', function: { name: 'clock_time', arguments: '{}' } };
    let promptGranted = true;
    mocks.hasPermission.mockImplementation(async (_origin, scope) => scope !== 'model:prompt' || promptGranted);
    mocks.harborRequest.mockImplementation(async (method) => {
      if (method === 'mcp.listTools') return { tools: [{ name: 'time', serverId: 'clock' }] };
      if (method === 'mcp.callTool') { promptGranted = false; return { result: 'Noon' }; }
      return { content: '', choices: [{ message: { role: 'assistant', content: '', tool_calls: [toolCall] } }] };
    });
    await receive({ id: 'budget-run', type: 'agent.run', origin: 'https://example.test',
      payload: { task: 'What time is it?', maxToolCalls: 1 } });
    expect(mocks.harborRequest.mock.calls.filter(([m]) => m === 'llm.chat')).toHaveLength(1);
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      done: true, event: expect.objectContaining({ error: expect.objectContaining({ code: 'ERR_PERMISSION_DENIED' }) }),
    }));
  });

  it('ends with a coded error event when the model call fails', async () => {
    mocks.harborRequest.mockImplementation(async (method) => {
      if (method === 'mcp.listTools') return { tools: [] };
      throw new Error('bridge unavailable');
    });
    await run();
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      done: true,
      event: { type: 'error', error: { code: 'ERR_MODEL_FAILED', message: 'LLM request failed: bridge unavailable' } },
    }));
  });

  it('ends with a coded error event when the run fails for another reason', async () => {
    mocks.harborRequest.mockImplementation(async (method) => {
      if (method === 'mcp.listTools') throw new Error('tool host crashed');
      return { content: 'unused' };
    });
    await run();
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      done: true,
      event: { type: 'error', error: { code: 'ERR_AGENT_FAILED', message: 'tool host crashed' } },
    }));
    expect(mocks.harborRequest.mock.calls.map(([method]) => method)).not.toContain('llm.chat');
  });

  it('runs when enabled and explicitly permitted', async () => {
    await run();
    expect(mocks.harborRequest).toHaveBeenCalledWith('llm.chat', expect.anything(), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ done: true, event: { type: 'done' } }));
  });
  it('uses normalized content as the text contract across the Harbor boundary', async () => {
    mocks.harborRequest.mockImplementation(async (method) => method === 'mcp.listTools'
      ? { tools: [] } : { content: 'Canonical reply', choices: [{ message: { role: 'assistant', content: 'Raw provider text' } }] });
    await run();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      event: { type: 'token', token: JSON.stringify({ type: 'final', output: 'Canonical reply' }) },
    }));
  });

  it.each(['', 'Checking the clock.'])('keeps structured tool history without a synthetic summary (%j)', async (content) => {
    const toolCall = { id: 'call-clock', function: { name: 'clock_time', arguments: '{}' } };
    const history: unknown[] = [];
    mocks.harborRequest.mockImplementation(async (method, params) => {
      if (method === 'mcp.listTools') return { tools: [{ name: 'time', serverId: 'clock' }] };
      if (method === 'mcp.callTool') return { result: { content: [{ type: 'text', text: 'Noon' }] } };
      if (method === 'llm.chat') {
        history.push(structuredClone(params.messages));
        return history.length === 1
          ? { content, choices: [{ message: { role: 'assistant', content, tool_calls: [toolCall] } }] }
          : { content: 'It is noon.' };
      }
    });
    await run();
    expect(history).toHaveLength(2);
    expect(history[1]).toEqual([
      { role: 'system', content: 'You are a helpful assistant that can use tools to help users.' },
      { role: 'user', content: 'What time is it?' },
      { role: 'assistant', content, tool_calls: [{ ...toolCall, type: 'function' }] },
      { role: 'tool', tool_call_id: 'call-clock', content: 'Noon' },
    ]);
  });

  it('preserves tool-only replies and uses normalized text after the tool budget', async () => {
    const toolCall = { id: 'call-1', function: { name: 'clock_time', arguments: '{}' } };
    let calls = 0;
    mocks.harborRequest.mockImplementation(async (method) => {
      if (method === 'mcp.listTools') return { tools: [{ name: 'time', serverId: 'clock', description: 'Time', inputSchema: {} }] };
      if (method === 'mcp.callTool') return { content: [{ type: 'text', text: 'noon' }] };
      if (method === 'llm.chat') {
        calls++;
        return calls === 1
          ? { content: '', choices: [{ message: { role: 'assistant', content: null, tool_calls: [toolCall] } }] }
          : { content: 'Noon', choices: [{ message: { role: 'assistant', content: 'Raw text' } }] };
      }
    });
    await receive({ id: 'tool-run', type: 'agent.run', origin: 'https://example.test', payload: { task: 'What time is it?', maxToolCalls: 1 } });
    expect(mocks.harborRequest).toHaveBeenCalledWith('mcp.callTool', expect.anything(), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      event: { type: 'token', token: JSON.stringify({ type: 'final', output: 'Noon' }) },
    }));
  });

  it('forwards the page origin and tab on every Harbor model and tool call', async () => {
    const toolCall = { id: 'call-clock', function: { name: 'clock_time', arguments: '{}' } };
    let chats = 0;
    mocks.harborRequest.mockImplementation(async (method) => {
      if (method === 'mcp.listTools') return { tools: [{ name: 'time', serverId: 'clock' }] };
      if (method === 'mcp.callTool') return { result: 'Noon' };
      chats++;
      return chats === 1
        ? { content: '', choices: [{ message: { role: 'assistant', content: '', tool_calls: [toolCall] } }] }
        : { content: 'It is noon.' };
    });
    await run();
    const calls = mocks.harborRequest.mock.calls;
    expect(calls.map(([method]) => method)).toEqual(['mcp.listTools', 'llm.chat', 'mcp.callTool', 'llm.chat']);
    for (const [, payload] of calls) {
      expect(payload).toMatchObject({ origin: 'https://example.test', tabId: 1 });
    }
  });
});

describe('window.ai session promptStreaming()', () => {
  it('forwards the page origin and tab on llm.chatStream', async () => {
    mocks.resolveTextSession.mockResolvedValue({ session: {
      sessionId: 's1', origin: 'https://example.test', options: {}, history: [], createdAt: 0,
    } });
    mocks.harborStreamRequest.mockReturnValue({
      stream: (async function* () { yield { type: 'done' }; })(), cancel: vi.fn(),
    });
    await receive({ id: 'stream-1', type: 'session.promptStreaming', origin: 'https://example.test',
      payload: { sessionId: 's1', input: 'Hi' } });
    expect(mocks.harborStreamRequest).toHaveBeenCalledWith('llm.chatStream',
      expect.objectContaining({ origin: 'https://example.test', tabId: 1 }), 'stream-1', expect.any(AbortSignal));
  });
});
