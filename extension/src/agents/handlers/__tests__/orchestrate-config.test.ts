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
type Invocation = { agentId: string; task: string; input?: unknown };
type InvocationResponse = { success: boolean; result?: unknown; error?: { code: string; message: string }; executionTime: number };
const invokeAgent = vi.fn(async (request: Invocation): Promise<InvocationResponse> => ({
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
    expect((response as { result: { stepResults: unknown[] } }).result.stepResults).toHaveLength(2);
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
      // injected.ts promises the chosen agent's AgentInvocationResponse.
      result: { success: true, result: 'creative:review', selectedAgentId: 'creative' },
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

    expect(response).toMatchObject({
      ok: true,
      result: { success: true, result: 'general:answer', selectedAgentId: 'general', matchedCondition: null },
    });
  });

  it('route with no match and no default reports ERR_NO_ROUTE', async () => {
    const response = await handleAgentsRoute(pageCtx('agent.agents.orchestrate.route', {
      config: { routes: [{ condition: 'hasProperty:code', agentId: 'tech' }] },
      input: { note: 'hello' },
      task: 'answer',
    }));

    expect(response).toMatchObject({ ok: true, result: { success: false, error: { code: 'ERR_NO_ROUTE' } } });
    expect(invokeAgent).not.toHaveBeenCalled();
  });

  it('pipeline stops at a failed step and reports it', async () => {
    invokeAgent.mockImplementationOnce(async (request) => ({ success: true, result: `${request.agentId}:${request.task}`, executionTime: 0 }));
    invokeAgent.mockImplementationOnce(async () => ({
      success: false,
      error: { code: 'ERR_AGENT_NOT_FOUND', message: 'Target agent not found' },
      executionTime: 0,
    }));

    const response = await handleAgentsPipeline(pageCtx('agent.agents.orchestrate.pipeline', {
      config: {
        steps: [
          { agentId: 'researcher', task: 'research' },
          { agentId: 'missing', task: 'write' },
          { agentId: 'reviewer', task: 'review' },
        ],
      },
      initialInput: 'x',
    }));

    expect(response).toMatchObject({ ok: true, result: { success: false, result: undefined } });
    expect((response as { result: { stepResults: unknown[]; error: string } }).result.stepResults).toHaveLength(2);
    expect((response as { result: { error: string } }).result.error).toContain('Target agent not found');
    expect(invokeAgent).toHaveBeenCalledTimes(2);
  });

  it('pipeline applies a step\'s outputTransform and fills {{input}} in the next task', async () => {
    invokeAgent.mockImplementationOnce(async () => ({ success: true, result: { title: 'Tides' }, executionTime: 0 }));

    await handleAgentsPipeline(pageCtx('agent.agents.orchestrate.pipeline', {
      config: {
        steps: [
          { agentId: 'researcher', task: 'research', outputTransform: '.title' },
          { agentId: 'writer', task: 'write about {{input}}' },
        ],
      },
      initialInput: 'x',
    }));

    expect(invokeAgent.mock.calls[1][0]).toMatchObject({ agentId: 'writer', task: 'write about Tides', input: 'Tides' });
  });

  it('both calls refuse a page that has not registered as an agent', async () => {
    const other = (type: string, payload: unknown) =>
      ({ id: 'p2', type, origin: 'https://unregistered.example', tabId: 4, payload }) as PageRequestContext;

    const pipeline = await handleAgentsPipeline(other('agent.agents.orchestrate.pipeline', {
      config: { steps: [{ agentId: 'a', task: 't' }] },
    }));
    const route = await handleAgentsRoute(other('agent.agents.orchestrate.route', {
      config: { routes: [{ condition: 'always', agentId: 'a' }] },
      input: 1,
      task: 't',
    }));

    expect(pipeline).toMatchObject({ ok: false, error: { message: 'Must register as an agent first' } });
    expect(route).toMatchObject({ ok: false, error: { message: 'Must register as an agent first' } });
    expect(invokeAgent).not.toHaveBeenCalled();
  });
});
