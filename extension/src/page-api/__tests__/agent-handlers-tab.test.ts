import { describe, it, expect, beforeEach, vi } from 'vitest';

const harborRequest = vi.fn(async (_type: string, _payload: Record<string, unknown>) => ({}) as never);
vi.mock('../harbor-core', () => ({
  describedBySite: (_origin: string, d?: string) => d,
  siteToolsForAgent: vi.fn(async () => []),
  openPageToolEndpointForAcp: vi.fn(async () => null), closePageToolEndpoint: vi.fn(async () => {}),
  syncPageTools: vi.fn(), resolvePageToolResult: vi.fn(), forgetPageToolsForConnection: vi.fn(), forgetPageToolsInTab: vi.fn(),
  pageToolsForAgent: vi.fn(async () => null), harborRequest: (type: string, payload: Record<string, unknown>) => harborRequest(type, payload) }));

import {
  handleAgentsUnregister,
  handleAgentsGetInfo,
  handleAgentsDiscover,
  handleAgentsList,
  handleAgentsInvoke,
  handleAgentsSend,
  handleAgentsPipeline,
  handleAgentsParallel,
  handleAgentsRoute,
} from '../handlers/agent-handlers';
import type { RequestContext } from '../handlers/types';

// An "Allow once" grant covers only the tab that gave it, so Harbor needs to
// know which tab each agent call comes from. Without it, another tab on the
// same site could use the grant.
function ctx(payload: unknown): RequestContext {
  return { id: 'r1', type: 'agent.agents.invoke', origin: 'https://example.com', tabId: 7, payload } as RequestContext;
}

const cases: Array<[string, (c: RequestContext) => Promise<unknown>, unknown]> = [
  ['unregister', handleAgentsUnregister, { agentId: 'a1' }],
  ['getInfo', handleAgentsGetInfo, { agentId: 'a1' }],
  ['discover', handleAgentsDiscover, {}],
  ['list', handleAgentsList, {}],
  ['invoke', handleAgentsInvoke, { agentId: 'a1', request: { task: 't' } }],
  ['send', handleAgentsSend, { agentId: 'a1', payload: 'hi' }],
  ['orchestrate.pipeline', handleAgentsPipeline, { config: { steps: [{ agentId: 'a1', task: 't' }] } }],
  ['orchestrate.parallel', handleAgentsParallel, { config: { tasks: [{ agentId: 'a1', task: 't' }] } }],
  ['orchestrate.route', handleAgentsRoute, { config: { routes: [{ condition: 'x', agentId: 'a1' }] }, input: 1, task: 't' }],
];

describe('page agent calls tell Harbor which tab they come from', () => {
  beforeEach(() => harborRequest.mockClear());

  it.each(cases)('%s forwards the calling tab', async (_name, handler, payload) => {
    await handler(ctx(payload));
    expect(harborRequest).toHaveBeenCalledTimes(1);
    expect(harborRequest.mock.calls[0][1]).toMatchObject({ origin: 'https://example.com', tabId: 7 });
  });
});
