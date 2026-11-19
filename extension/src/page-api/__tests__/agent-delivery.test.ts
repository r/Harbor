/**
 * A page agent that accepts messages gets a message proxy in Harbor, and a
 * refusal from Harbor reaches the page with its own error code.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const harborRequest = vi.fn();
vi.mock('../harbor-core', () => ({ harborRequest: (...args: unknown[]) => harborRequest(...args) }));

import { handleAgentsRegister, handleAgentsInvoke, handleAgentsSend } from '../handlers/agent-handlers';
import type { RequestContext } from '../handlers/types';

function ctx(type: string, payload: unknown): RequestContext {
  return { id: 'r1', type, origin: 'https://b.example', tabId: 5, payload } as RequestContext;
}

beforeEach(() => harborRequest.mockReset());

describe('registering a page agent', () => {
  it('sets up a message proxy when the agent accepts messages', async () => {
    harborRequest.mockImplementation(async (type: string) =>
      type === 'agents.register'
        ? { id: 'agent-1', name: 'B', capabilities: [], tags: [], acceptsInvocations: false, acceptsMessages: true }
        : undefined,
    );
    await handleAgentsRegister(ctx('agent.agents.register', { name: 'B', acceptsMessages: true }));

    expect(harborRequest).toHaveBeenCalledWith('agents.registerMessageHandler', {
      agentId: 'agent-1',
      origin: 'https://b.example',
      tabId: 5,
    });
  });

  it('sets up no message proxy when the agent declines messages', async () => {
    harborRequest.mockImplementation(async (type: string) =>
      type === 'agents.register'
        ? { id: 'agent-1', name: 'B', capabilities: [], tags: [], acceptsInvocations: false, acceptsMessages: false }
        : undefined,
    );
    await handleAgentsRegister(ctx('agent.agents.register', { name: 'B', acceptsMessages: false }));

    expect(harborRequest.mock.calls.map(([type]) => type)).not.toContain('agents.registerMessageHandler');
  });
});

describe('a refusal keeps its code', () => {
  const refusal = Object.assign(new Error('User denied agent.delegate.crossOrigin.'), { code: 'ERR_PERMISSION_DENIED' });

  it.each([
    ['invoke', handleAgentsInvoke, { agentId: 'x', request: { task: 't' } }],
    ['send', handleAgentsSend, { agentId: 'x', payload: 1 }],
  ] as const)('%s', async (_name, handler, payload) => {
    harborRequest.mockRejectedValue(refusal);
    const response = await handler(ctx('agent.agents.x', payload));
    expect(response).toMatchObject({ ok: false, error: { code: 'ERR_PERMISSION_DENIED' } });
  });
});
