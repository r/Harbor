import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeChat } from '../chat';
import { bridgeRequest } from '../bridge-client';

vi.mock('../bridge-client', () => ({ bridgeRequest: vi.fn() }));
const request = { messages: [{ role: 'user', content: 'Hello' }] };
const call = { id: 'call-1', type: 'function', function: { name: 'time', arguments: '{}' } };

beforeEach(() => vi.clearAllMocks());

describe('bridge chat response boundary', () => {
  it('extracts text and metadata while preserving the original choices', async () => {
    const choices = [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }];
    vi.mocked(bridgeRequest).mockResolvedValue({ model: 'ollama:test', choices });
    expect(await bridgeChat(request)).toEqual({ content: 'hello', model: 'ollama:test', message: choices[0].message, choices, finish_reason: 'stop' });
    expect(bridgeRequest).toHaveBeenCalledWith('llm.chat', request);
  });

  it('preserves tool-only responses with null content', async () => {
    vi.mocked(bridgeRequest).mockResolvedValue({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }] });
    const result = await bridgeChat(request);
    expect(result.content).toBe('');
    expect(result.message.tool_calls).toEqual([call]);
    expect(result.finish_reason).toBe('tool_calls');
  });

  it('accepts empty text as a real response', async () => {
    vi.mocked(bridgeRequest).mockResolvedValue({ choices: [{ message: { role: 'assistant', content: '' } }] });
    expect((await bridgeChat(request)).content).toBe('');
  });

  it.each([null, {}, { choices: [] }, { choices: [{ message: null }] }, { choices: [{ message: { content: 42 } }] }])('rejects malformed completion %j instead of reporting empty success', async (raw) => {
    vi.mocked(bridgeRequest).mockResolvedValue(raw);
    await expect(bridgeChat(request)).rejects.toThrow(/Invalid chat response/);
  });

  it('propagates provider errors', async () => {
    vi.mocked(bridgeRequest).mockRejectedValue(new Error('Provider unavailable'));
    await expect(bridgeChat(request)).rejects.toThrow('Provider unavailable');
  });
});
