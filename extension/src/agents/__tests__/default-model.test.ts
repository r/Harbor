import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeChat } from '../../llm/chat';
import { bridgeStreamRequest } from '../../llm/bridge-client';
import { createSession, prompt, promptStreaming } from '../session-manager';
import { runAgent } from '../orchestrator';

vi.mock('../../llm/chat', () => ({ bridgeChat: vi.fn() }));
vi.mock('../../llm/bridge-client', () => ({ bridgeRequest: vi.fn(), bridgeStreamRequest: vi.fn() }));
vi.mock('../../mcp/host', () => ({ listServersWithStatus: vi.fn(async () => []), callTool: vi.fn(), startServer: vi.fn() }));
vi.mock('../../policy/permissions', () => ({ isToolAllowed: vi.fn() }));

const origin = 'https://example.com';
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(bridgeChat).mockResolvedValue({ content: 'Hello', message: { role: 'assistant', content: 'Hello' }, choices: [] });
  vi.mocked(bridgeStreamRequest).mockImplementation(async function* () {
    yield { id: 's', type: 'done' };
  });
});

const sessionCases = [
  [{}, undefined],
  [{ provider: 'apple' }, 'apple:system'],
  [{ provider: 'ollama', model: 'llama3.2' }, 'ollama:llama3.2'],
  [{ provider: 'openai' }, 'openai:default'],
  [{ provider: 'apple', model: 'ollama:llama3.2' }, 'ollama:llama3.2'],
  [{ model: 'default' }, 'default'],
] as const;

describe('session default selection', () => {
  it.each(sessionCases)('preserves selection for %j in a prompt', async (options, model) => {
    const id = createSession(origin, options);
    await prompt(id, origin, 'Hello');
    expect(bridgeChat).toHaveBeenCalledWith(expect.objectContaining({ model }));
  });

  it.each(sessionCases)('preserves selection for %j while streaming', async (options, model) => {
    const id = createSession(origin, options);
    for await (const _event of promptStreaming(id, origin, 'Hello')) { /* drain */ }
    expect(bridgeStreamRequest).toHaveBeenCalledWith('llm.chat_stream', expect.objectContaining({ model }));
  });
});

describe('agent default selection', () => {
  it.each([
    [undefined, undefined],
    ['apple', 'apple:system'],
    ['ollama:llama3.2', 'ollama:llama3.2'],
    ['default', 'default'],
  ])('preserves provider selection %s', async (provider, model) => {
    for await (const _event of runAgent(origin, { task: 'Say hello', provider })) { /* drain */ }
    expect(bridgeChat).toHaveBeenCalledWith(expect.objectContaining({ model }));
  });
});
