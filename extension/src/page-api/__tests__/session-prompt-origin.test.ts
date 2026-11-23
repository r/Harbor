import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ harborRequest: vi.fn() }));
vi.mock('../harbor-core', () => ({
  siteToolsForAgent: vi.fn(async () => []),
  openPageToolEndpointForAcp: vi.fn(async () => null), closePageToolEndpoint: vi.fn(async () => {}),
  syncPageTools: vi.fn(), resolvePageToolResult: vi.fn(), forgetPageToolsForConnection: vi.fn(), forgetPageToolsInTab: vi.fn(),
  pageToolsForAgent: vi.fn(async () => null),
  harborRequest: mocks.harborRequest,
}));
vi.mock('../handlers/permission-handlers', () => ({ hasPermission: async () => true }));

import { handleAiCreateTextSession, handleSessionPrompt } from '../handlers/ai-handlers';

const ORIGIN = 'https://page.example';

beforeEach(() => vi.clearAllMocks());

describe('window.ai text session prompt()', () => {
  it('forwards the page origin and tab on llm.chat so Harbor can gate and audit it', async () => {
    const created = await handleAiCreateTextSession({
      id: 'c1', type: 'ai.createTextSession', origin: ORIGIN, tabId: 3, payload: { model: 'ollama:test' },
    } as never);
    const sessionId = (created as { result: string }).result;
    mocks.harborRequest.mockResolvedValue({ content: 'Hello' });

    const res = await handleSessionPrompt({
      id: 'p1', type: 'session.prompt', origin: ORIGIN, tabId: 3, payload: { sessionId, input: 'Hi' },
    } as never);

    expect(res).toMatchObject({ ok: true, result: 'Hello' });
    expect(mocks.harborRequest).toHaveBeenCalledWith('llm.chat', expect.objectContaining({ origin: ORIGIN, tabId: 3 }), expect.anything());
  });
});
