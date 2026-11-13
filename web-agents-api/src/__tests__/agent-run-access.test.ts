import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  harborRequest: vi.fn(), hasPermission: vi.fn(), getFeatureFlags: vi.fn(),
}));
vi.mock('../harbor-client', () => ({
  harborRequest: mocks.harborRequest, harborStreamRequest: vi.fn(),
  discoverHarbor: async () => null, setHarborExtensionId: vi.fn(), getHarborState: vi.fn(),
}));
vi.mock('../policy/feature-flags', () => ({ getFeatureFlags: mocks.getFeatureFlags }));
vi.mock('../handlers', () => ({
  routeMessage: vi.fn(), isStreamingMessage: vi.fn(), hasPermission: mocks.hasPermission,
  getPermissions: async () => ({ scopes: {} }), listAllPermissions: vi.fn(),
  revokeOriginPermissions: vi.fn(), resolvePromptClosed: vi.fn(),
  handlePermissionPromptResponse: vi.fn(), getTextSession: vi.fn(),
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
  mocks.harborRequest.mockImplementation(async (method) => method === 'mcp.listTools'
    ? { tools: [] } : { content: 'The time is noon.' });
  const event = () => ({ addListener: vi.fn() });
  const onConnect = event();
  vi.stubGlobal('chrome', {
    tabs: { onRemoved: event() }, windows: { onRemoved: event() },
    runtime: { onConnect, onMessage: event(), onMessageExternal: event() },
  });
  await import('../background');
  postMessage = vi.fn();
  onConnect.addListener.mock.calls[0][0]({
    name: 'web-agent-transport', sender: { tab: { id: 1 } }, postMessage,
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

  it('runs when enabled and explicitly permitted', async () => {
    await run();
    expect(mocks.harborRequest).toHaveBeenCalledWith('llm.chat', expect.anything());
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
    expect(mocks.harborRequest).toHaveBeenCalledWith('mcp.callTool', expect.anything());
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      event: { type: 'token', token: JSON.stringify({ type: 'final', output: 'Noon' }) },
    }));
  });

});
