import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeChat } from '../../../llm/chat';
import { bridgeRequest } from '../../../llm/bridge-client';
import { requireAction } from '../helpers';
import { handleCanCreateTextSession, handleCreateTextSession, handleSessionPrompt } from '../ai-sessions';
import { getActiveProvider, listProviders } from '../../session-manager';
import type { RequestContext, ResponseSender } from '../router-types';

vi.mock('../../../llm/chat', () => ({ bridgeChat: vi.fn() }));
vi.mock('../../../llm/bridge-client', () => ({ bridgeRequest: vi.fn() }));
vi.mock('../helpers', () => ({ requireAction: vi.fn(), log: vi.fn() }));

const ctx: RequestContext = {
  id: 'apple-request', type: 'ai.createTextSession', origin: 'https://example.com', payload: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAction).mockResolvedValue(true);
  vi.mocked(bridgeChat).mockResolvedValue({ content: 'Hello from Apple Intelligence', message: { role: 'assistant', content: 'Hello from Apple Intelligence' }, choices: [] });
});

async function prompt(model?: string) {
  const sendResponse = vi.fn();
  const sender: ResponseSender = { sendResponse, sendStreamEvent: vi.fn() };
  await handleCreateTextSession({ ...ctx, payload: { model } }, sender);
  const sessionId = sendResponse.mock.calls[0][0].result;
  vi.mocked(requireAction).mockClear();
  await handleSessionPrompt({ ...ctx, payload: { sessionId, input: 'Hello' } }, sender);
  return sender;
}

describe('Apple Intelligence sessions', () => {
  it.each(['apple:system', undefined])('uses the local prompt permission for %s', async (model) => {
    await prompt(model);
    expect(requireAction).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'model.prompt.local', { promptAsScope: 'model:prompt' });
    expect(bridgeChat).toHaveBeenCalledWith({ model, messages: expect.arrayContaining([{ role: 'user', content: 'Hello' }]) });
  });

  it('blocks an Apple prompt when its existing permission is denied', async () => {
    vi.mocked(requireAction).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await prompt('apple:system');
    expect(bridgeChat).not.toHaveBeenCalled();
  });

  it('reports ready for the automatic model supplied by the bridge', async () => {
    vi.mocked(bridgeRequest).mockResolvedValue({ models: [{ name: 'Apple Intelligence', model_id: 'apple:system', is_default: true, automatic: true }] });
    const sender: ResponseSender = { sendResponse: vi.fn(), sendStreamEvent: vi.fn() };
    await handleCanCreateTextSession(ctx, sender);
    expect(sender.sendResponse).toHaveBeenCalledWith({ id: ctx.id, ok: true, result: 'readily' });
  });

  it('reports tool support for the Apple provider', async () => {
    vi.mocked(bridgeRequest).mockResolvedValue({ providers: [{ id: 'apple', type: 'apple', name: 'Apple Intelligence', is_local: true, configured: false, is_default: true }] });
    expect(await listProviders()).toEqual([expect.objectContaining({ id: 'apple', supportsTools: true })]);
  });

  it('respects the bridge availability when Apple Intelligence is disabled', async () => {
    vi.mocked(bridgeRequest).mockResolvedValue({ providers: [{ id: 'apple', type: 'apple', name: 'Apple Intelligence', is_local: true, available: false, configured: false }] });
    expect(await listProviders()).toEqual([expect.objectContaining({ id: 'apple', available: false })]);
  });

  it('exposes the automatic model as the active provider without a saved provider', async () => {
    vi.mocked(bridgeRequest).mockResolvedValue({ default_model: 'apple:system', providers: {} });
    expect(await getActiveProvider()).toEqual({ provider: 'apple', model: 'system' });
  });
});
