import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeRequest, bridgeStreamRequest } from '../llm/bridge-client';
import { initializeExtensionApi, routeExtensionApiMessage } from '../extension-api';
import { browserAPI } from '../browser-compat';

vi.mock('../llm/bridge-client', () => ({ bridgeRequest: vi.fn(), bridgeStreamRequest: vi.fn() }));
vi.mock('../mcp/host', () => ({}));
vi.mock('../agents/background-router', () => ({ routeExternalMessage: vi.fn() }));
vi.mock('../llm/native-bridge', () => ({}));
vi.mock('../llm/provider-registry', () => ({}));
vi.mock('../sessions', () => ({ SessionRegistry: { subscribe: vi.fn() } }));

const messages = [{ role: 'user', content: 'Hi' }];
const tools = [{ name: 'time', description: 'Time', input_schema: { type: 'object' } }];
beforeEach(() => vi.clearAllMocks());

describe('cross-extension chat request adapter', () => {
  it('maps external system to bridge system_prompt and preserves choices/tool calls', async () => {
    const choices = [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', function: { name: 'time', arguments: '{}' } }] }, finish_reason: 'tool_calls' }];
    vi.mocked(bridgeRequest).mockResolvedValue({ choices, model: 'ollama:test' });
    const response = await routeExtensionApiMessage({ type: 'llm.chat', payload: { messages, system: 'Be terse', tools, model: 'ollama:test', temperature: 0.2, max_tokens: 20 } }, {});
    expect(bridgeRequest).toHaveBeenCalledWith('llm.chat', { messages, system_prompt: 'Be terse', tools, model: 'ollama:test', temperature: 0.2, max_tokens: 20 });
    expect(response).toEqual({ ok: true, result: { content: '', choices, model: 'ollama:test' } });
  });

  it('forwards system and tools through the actual streaming port listener', async () => {
    let connect: ((port: unknown) => void) | undefined;
    const runtime = browserAPI.runtime as unknown as Record<string, unknown>;
    runtime.onMessageExternal = { addListener: vi.fn() };
    runtime.onConnectExternal = { addListener: (listener: typeof connect) => { connect = listener; } };
    initializeExtensionApi();
    let onMessage: ((message: unknown) => void) | undefined;
    let complete!: () => void;
    const done = new Promise<void>(resolve => { complete = resolve; });
    const postMessage = vi.fn(() => complete());
    connect!({ sender: { id: 'web-agents-test' }, onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; } }, onDisconnect: { addListener: vi.fn() }, postMessage });
    vi.mocked(bridgeStreamRequest).mockImplementation(async function* () { yield { id: 'stream1', type: 'done', finish_reason: 'stop' }; });
    onMessage!({ type: 'llm.chatStream', requestId: 'r1', payload: { messages, system: 'Be terse', tools, model: 'ollama:test', max_tokens: 20, temperature: 0.2 } });
    await done;
    expect(bridgeStreamRequest).toHaveBeenCalledWith('llm.chat_stream', { messages, system_prompt: 'Be terse', tools, model: 'ollama:test', max_tokens: 20, temperature: 0.2 });
    expect(postMessage).toHaveBeenCalledWith({ type: 'stream', requestId: 'r1', event: { id: 'stream1', type: 'done', finish_reason: 'stop' } });
  });
});
