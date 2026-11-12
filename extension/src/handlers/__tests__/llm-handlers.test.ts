import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeRequest } from '../../llm/bridge-client';
import { registerLlmHandlers } from '../llm-handlers';
import type { MessageHandler, HandlerResponse } from '../types';

vi.mock('../../llm/bridge-client', () => ({ bridgeRequest: vi.fn() }));
const handlers = new Map<string, MessageHandler>();
vi.mock('../types', async (original) => ({
  ...await original<typeof import('../types')>(),
  registerHandler: (type: string, handler: MessageHandler) => handlers.set(type, handler),
}));
beforeAll(() => registerLlmHandlers());
beforeEach(() => vi.clearAllMocks());
function dispatch(type: string, fields: Record<string, unknown> = {}): Promise<HandlerResponse> {
  return new Promise(resolve => handlers.get(type)!({ type, ...fields }, {}, resolve));
}
describe('sidebar model calls', () => {
  it('Test model displays the completion text', async () => {
    vi.mocked(bridgeRequest).mockResolvedValue({ choices: [{ message: { role: 'assistant', content: 'hello' } }] });
    expect(await dispatch('llm_test_model', { model: 'ollama:test' })).toEqual({ ok: true, response: 'hello' });
  });
  it('chat preserves its sidebar response envelope', async () => {
    vi.mocked(bridgeRequest).mockResolvedValue({ model: 'ollama:test', choices: [{ message: { role: 'assistant', content: 'hello' } }] });
    expect(await dispatch('llm_chat', { messages: [{ role: 'user', content: 'Hi' }] })).toEqual({ ok: true, response: { role: 'assistant', content: 'hello' }, model: 'ollama:test' });
  });
  it('Test model reports bridge failures', async () => {
    vi.mocked(bridgeRequest).mockRejectedValue(new Error('Model unavailable'));
    expect(await dispatch('llm_test_model', { model: 'ollama:test' })).toEqual({ ok: false, error: 'Model unavailable' });
  });
});
