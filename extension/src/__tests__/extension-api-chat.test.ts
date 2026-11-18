import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeRequest, bridgeStreamRequest } from '../llm/bridge-client';
import { routeExtensionApiMessage, streamLlmChat } from '../extension-api';

vi.mock('../llm/bridge-client', () => ({ bridgeRequest: vi.fn(), bridgeStreamRequest: vi.fn() }));
vi.mock('../mcp/host', () => ({}));
vi.mock('../llm/native-bridge', () => ({}));
vi.mock('../llm/provider-registry', () => ({}));
vi.mock('../sessions', () => ({ SessionRegistry: { subscribe: vi.fn() } }));

const messages = [{ role: 'user', content: 'Hi' }];
const tools = [{ name: 'time', description: 'Time', input_schema: { type: 'object' } }];
beforeEach(() => vi.clearAllMocks());

describe('page chat request adapter', () => {
  it('maps external system to bridge system_prompt and preserves choices/tool calls', async () => {
    const choices = [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', function: { name: 'time', arguments: '{}' } }] }, finish_reason: 'tool_calls' }];
    vi.mocked(bridgeRequest).mockResolvedValue({ choices, model: 'ollama:test' });
    const response = await routeExtensionApiMessage({ type: 'llm.chat', payload: { origin: 'https://page.example', messages, system: 'Be terse', tools, model: 'ollama:test', temperature: 0.2, max_tokens: 20 } }, {});
    expect(bridgeRequest).toHaveBeenCalledWith('llm.chat', { messages, system_prompt: 'Be terse', tools, model: 'ollama:test', temperature: 0.2, max_tokens: 20 });
    expect(response).toEqual({ ok: true, result: { content: '', choices, model: 'ollama:test' } });
  });

  it('forwards system and tools through the streamLlmChat generator page-api/harbor-core.ts calls', async () => {
    vi.mocked(bridgeStreamRequest).mockImplementation(async function* () { yield { id: 'stream1', type: 'done', finish_reason: 'stop' }; });
    const events = [];
    for await (const event of streamLlmChat({ origin: 'https://page.example', messages, system: 'Be terse', tools, model: 'ollama:test', max_tokens: 20, temperature: 0.2 }, 'r1')) {
      events.push(event);
    }
    expect(bridgeStreamRequest).toHaveBeenCalledWith('llm.chat_stream', { messages, system_prompt: 'Be terse', tools, model: 'ollama:test', max_tokens: 20, temperature: 0.2 });
    expect(events).toEqual([{ id: 'stream1', type: 'done', finish_reason: 'stop' }]);
  });
});
