import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { RequestContext, ResponseSender } from '../router-types';
import type { TransportResponse } from '../../types';

// A page's orchestrate.pipeline() and orchestrate.route() calls go through the
// page handler, which forwards { config, ... } to Harbor. These tests connect
// the page handler straight to Harbor's handler, so the two sides have to
// agree on the payload shape that injected.ts documents.

// The permission prompt is covered elsewhere; let every call through.
vi.mock('../helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../helpers')>()),
  requireAction: vi.fn(async () => true),
}));

// Record what Harbor would deliver to each target agent instead of
// delivering it to a page.
const invokeAgent = vi.fn(async (request: { agentId: string; task: string; input?: unknown }) => ({
  success: true,
  result: `${request.agentId}:${request.task}`,
  executionTime: 0,
}));
vi.mock('../../../multi-agent/messaging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../multi-agent/messaging')>()),
  invokeAgent: (request: { agentId: string; task: string; input?: unknown }) => invokeAgent(request),
}));

// Connect the page handler to Harbor's handler.
const harborHandlers: Record<string, (ctx: RequestContext, sender: ResponseSender) => Promise<void>> = {};
vi.mock('../../../page-api/harbor-core', () => ({
  harborRequest: async (type: string, payload: { origin: string; tabId?: number }) => {
    const handler = harborHandlers[type];
    if (!handler) throw new Error(`no Harbor handler for ${type}`);
    const responses: TransportResponse[] = [];
    await handler(
      { id: 'h1', type, origin: payload.origin, tabId: payload.tabId, payload } as RequestContext,
      { sendResponse: (r: TransportResponse) => responses.push(r), sendStreamEvent: () => {} },
    );
    const response = responses[0];
    if (!response?.ok) throw new Error(response?.error?.message ?? 'no response');
    return response.result;
  },
}));

import {
  handleAgentsRegister,
  handleOrchestratePipeline,
  handleOrchestrateRoute,
} from '../multi-agent';
import { handleAgentsPipeline, handleAgentsRoute } from '../../../page-api/handlers/agent-handlers';
import type { RequestContext as PageRequestContext } from '../../../page-api/handlers/types';

harborHandlers['agents.orchestrate.pipeline'] = handleOrchestratePipeline;
harborHandlers['agents.orchestrate.route'] = handleOrchestrateRoute;

const ORIGIN = 'https://orchestrator.example';

function pageCtx(type: string, payload: unknown): PageRequestContext {
  return { id: 'p1', type, origin: ORIGIN, tabId: 3, payload } as PageRequestContext;
}

beforeEach(async () => {
  invokeAgent.mockClear();
  // Orchestration needs the calling origin to be a registered agent.
  const responses: TransportResponse[] = [];
  await handleAgentsRegister(
    { id: 'r1', type: 'agents.register', origin: ORIGIN, tabId: 3, payload: { name: 'Orchestrator' } } as RequestContext,
    { sendResponse: (r: TransportResponse) => responses.push(r), sendStreamEvent: () => {} },
  );
  expect(responses[0]?.ok).toBe(true);
});

describe('orchestrate calls from a page reach Harbor in the documented shape', () => {
  it('pipeline runs each step with its task, in order', async () => {
    const response = await handleAgentsPipeline(pageCtx('agent.agents.orchestrate.pipeline', {
      config: {
        steps: [
          { agentId: 'researcher', task: 'research' },
          { agentId: 'writer', task: 'write' },
        ],
      },
      initialInput: { topic: 'tides' },
    }));

    expect(response).toMatchObject({ ok: true, result: { success: true, result: 'writer:write' } });
    expect(invokeAgent.mock.calls.map(([r]) => [r.agentId, r.task])).toEqual([
      ['researcher', 'research'],
      ['writer', 'write'],
    ]);
    expect(invokeAgent.mock.calls[0][0].input).toEqual({ topic: 'tides' });
    expect(invokeAgent.mock.calls[1][0].input).toBe('researcher:research');
  });

  it('route sends the task to the agent whose condition matches', async () => {
    const response = await handleAgentsRoute(pageCtx('agent.agents.orchestrate.route', {
      config: {
        routes: [
          { condition: 'hasProperty:code', agentId: 'tech' },
          { condition: 'hasProperty:poem', agentId: 'creative' },
        ],
        defaultAgentId: 'general',
      },
      input: { poem: 'harbor lights' },
      task: 'review',
    }));

    expect(response).toMatchObject({
      ok: true,
      result: { selectedAgentId: 'creative', invocationResult: { success: true, result: 'creative:review' } },
    });
    expect(invokeAgent).toHaveBeenCalledTimes(1);
    expect(invokeAgent.mock.calls[0][0]).toMatchObject({ agentId: 'creative', task: 'review', input: { poem: 'harbor lights' } });
  });

  it('route falls back to the default agent', async () => {
    const response = await handleAgentsRoute(pageCtx('agent.agents.orchestrate.route', {
      config: { routes: [{ condition: 'hasProperty:code', agentId: 'tech' }], defaultAgentId: 'general' },
      input: { note: 'hello' },
      task: 'answer',
    }));

    expect(response).toMatchObject({ ok: true, result: { selectedAgentId: 'general' } });
  });
});
