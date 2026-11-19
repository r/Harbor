import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { RequestContext, ResponseSender } from '../router-types';
import type { TransportResponse } from '../../types';
import type { TypedAction } from '../../../policy/actions';
import type { PolicyResource } from '../../../policy/engine';

// Orchestration checks each step's target the way a direct agents.invoke
// does: a cross-origin target needs `agent.delegate.crossOrigin` (prompting as
// agents:crossOrigin), a same-origin one needs `agent.invoke`, and both carry
// the target agent as the resource. The checks run through the real
// requireAction and PolicyEngine. The prompt window is replaced, and so is
// the origin-grant lookup, which records each check and answers from `granted`.

const prompts: Array<{ origin: string; scopes: string[] }> = [];
let promptAnswer: (scopes: string[]) => boolean = () => true;
// How many prompt windows were open at once, at most.
let openPrompts = 0;
let mostOpenPrompts = 0;
vi.mock('../../../policy/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../policy/permissions')>()),
  showPermissionPrompt: vi.fn(async (origin: string, scopes: string[]) => {
    prompts.push({ origin, scopes });
    openPrompts += 1;
    mostOpenPrompts = Math.max(mostOpenPrompts, openPrompts);
    try {
      // A real prompt waits for the person; let other checks run meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const granted = promptAnswer(scopes);
      return granted ? { granted, grantType: 'granted-once' as const } : { granted, explicitDeny: true };
    } finally {
      openPrompts -= 1;
    }
  }),
  grantPermissions: vi.fn(async () => {}),
}));

import { setOriginGrantResolver, setWatchdogResolver } from '../../../policy/engine';
import { Policy } from '../../../policy/store';
import { resetMockBrowser } from '../../../__tests__/test-setup';
import { registerAgent } from '../../../multi-agent/registry';
import { registerInvocationHandler } from '../../../multi-agent/messaging';
import {
  handleAgentsRegister,
  handleOrchestratePipeline,
  handleOrchestrateParallel,
  handleOrchestrateRoute,
  handleOrchestrateSupervisor,
} from '../multi-agent';

const ORCHESTRATOR = 'https://orchestrator.example';
const OTHER = 'https://other.example';

// Every engine evaluation the orchestration makes, in order.
const checks: Array<{ action: TypedAction; server?: string }> = [];
// Which (action, server) pairs the origin already holds a grant for.
let granted: (action: TypedAction, resource?: PolicyResource) => boolean = () => false;
// Which agents actually received an invocation.
const delivered: string[] = [];

function target(origin: string, name: string): string {
  const agent = registerAgent({ name }, origin, 7);
  registerInvocationHandler(agent.id, async (request) => {
    delivered.push(agent.id);
    return { success: true, result: `${name}:${request.task}`, executionTime: 0 };
  });
  return agent.id;
}

async function call(
  handler: (ctx: RequestContext, sender: ResponseSender) => Promise<void>,
  type: string,
  payload: unknown,
): Promise<TransportResponse[]> {
  const responses: TransportResponse[] = [];
  await handler(
    { id: 'o1', type, origin: ORCHESTRATOR, tabId: 3, payload } as RequestContext,
    { sendResponse: (r: TransportResponse) => responses.push(r), sendStreamEvent: () => {} },
  );
  return responses;
}

let sameOriginAgent: string;
let crossOriginAgent: string;
let secondCrossOriginAgent: string;

beforeEach(async () => {
  resetMockBrowser();
  Policy.__reset();
  setWatchdogResolver(() => ({ status: 'normal' }));
  checks.length = 0;
  prompts.length = 0;
  delivered.length = 0;
  promptAnswer = () => true;
  openPrompts = 0;
  mostOpenPrompts = 0;
  // The orchestrator may register and orchestrate; nothing else is granted.
  granted = (action) => action === 'agent.register' || action === 'agent.invoke';
  setOriginGrantResolver((_origin, action, resource) => {
    if (action !== 'agent.register') checks.push({ action, server: resource?.server });
    return granted(action, resource) ? { effect: 'allow', persistence: 'once' } : null;
  });

  const responses: TransportResponse[] = [];
  await handleAgentsRegister(
    { id: 'r1', type: 'agents.register', origin: ORCHESTRATOR, tabId: 3, payload: { name: 'Orchestrator' } } as RequestContext,
    { sendResponse: (r: TransportResponse) => responses.push(r), sendStreamEvent: () => {} },
  );
  expect(responses[0]?.ok).toBe(true);

  sameOriginAgent = target(ORCHESTRATOR, 'local');
  crossOriginAgent = target(OTHER, 'remote');
  secondCrossOriginAgent = target(OTHER, 'remote2');
  checks.length = 0;
});

function stepChecks() {
  // Drop the up-front check on the orchestrate call itself (no resource).
  return checks.filter((c) => c.server !== undefined);
}

describe('pipeline checks each step target', () => {
  it('checks a same-origin step as agent.invoke on that agent, without prompting', async () => {
    const responses = await call(handleOrchestratePipeline, 'agents.orchestrate.pipeline', {
      config: { steps: [{ agentId: sameOriginAgent, task: 'one' }] },
      initialInput: 'x',
    });

    expect(responses[0]?.ok).toBe(true);
    expect((responses[0] as { result: { success: boolean } }).result.success).toBe(true);
    expect(stepChecks()).toEqual([{ action: 'agent.invoke', server: sameOriginAgent }]);
    expect(prompts).toEqual([]);
    expect(delivered).toEqual([sameOriginAgent]);
  });

  it('prompts for agents:crossOrigin at a cross-origin step and runs it once allowed', async () => {
    const responses = await call(handleOrchestratePipeline, 'agents.orchestrate.pipeline', {
      config: { steps: [{ agentId: sameOriginAgent, task: 'one' }, { agentId: crossOriginAgent, task: 'two' }] },
      initialInput: 'x',
    });

    expect(responses).toHaveLength(1);
    expect((responses[0] as { result: { success: boolean } }).result.success).toBe(true);
    expect(stepChecks()).toEqual([
      { action: 'agent.invoke', server: sameOriginAgent },
      { action: 'agent.delegate.crossOrigin', server: crossOriginAgent },
    ]);
    expect(prompts).toEqual([{ origin: ORCHESTRATOR, scopes: ['agents:crossOrigin'] }]);
    expect(delivered).toEqual([sameOriginAgent, crossOriginAgent]);
  });

  it('stops at a denied cross-origin step and never reaches later steps', async () => {
    promptAnswer = () => false;
    const responses = await call(handleOrchestratePipeline, 'agents.orchestrate.pipeline', {
      config: {
        steps: [
          { agentId: sameOriginAgent, task: 'one' },
          { agentId: crossOriginAgent, task: 'two' },
          { agentId: sameOriginAgent, task: 'three' },
        ],
      },
      initialInput: 'x',
    });

    // One response, carrying the pipeline's failure at step 2.
    expect(responses).toHaveLength(1);
    const result = (responses[0] as { ok: true; result: { success: boolean; stepResults: Array<{ success: boolean; error?: string }> } }).result;
    expect(result.success).toBe(false);
    expect(result.stepResults).toHaveLength(2);
    expect(result.stepResults[1]?.success).toBe(false);
    expect(delivered).toEqual([sameOriginAgent]);
    expect(stepChecks()).toEqual([
      { action: 'agent.invoke', server: sameOriginAgent },
      { action: 'agent.delegate.crossOrigin', server: crossOriginAgent },
    ]);
  });

  it('runs a cross-origin step without a prompt when the origin already holds a grant for it', async () => {
    granted = (action) => action === 'agent.invoke' || action === 'agent.delegate.crossOrigin';
    await call(handleOrchestratePipeline, 'agents.orchestrate.pipeline', {
      config: { steps: [{ agentId: crossOriginAgent, task: 'one' }] },
      initialInput: 'x',
    });

    expect(prompts).toEqual([]);
    expect(delivered).toEqual([crossOriginAgent]);
  });
});

describe('route checks only the target it selected', () => {
  it('checks the selected cross-origin agent and not the others', async () => {
    const responses = await call(handleOrchestrateRoute, 'agents.orchestrate.route', {
      config: {
        routes: [
          { condition: 'type:number', agentId: sameOriginAgent },
          { condition: 'type:string', agentId: crossOriginAgent },
        ],
        defaultAgentId: secondCrossOriginAgent,
      },
      input: 'hello',
      task: 't',
    });

    expect((responses[0] as { result: { success: boolean } }).result.success).toBe(true);
    expect(stepChecks()).toEqual([{ action: 'agent.delegate.crossOrigin', server: crossOriginAgent }]);
    expect(prompts).toEqual([{ origin: ORCHESTRATOR, scopes: ['agents:crossOrigin'] }]);
    expect(delivered).toEqual([crossOriginAgent]);
  });

  it('reports a denied selected target as the route result without invoking it', async () => {
    promptAnswer = () => false;
    const responses = await call(handleOrchestrateRoute, 'agents.orchestrate.route', {
      config: { routes: [{ condition: 'always', agentId: crossOriginAgent }] },
      input: 'hello',
      task: 't',
    });

    expect(responses).toHaveLength(1);
    const result = (responses[0] as { result: { success: boolean; error?: { code: string } } }).result;
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ERR_PERMISSION_DENIED');
    expect(delivered).toEqual([]);
  });
});

describe('parallel checks each task target', () => {
  it('checks every target, prompts for the cross-origin ones, and fails only a denied branch', async () => {
    promptAnswer = () => prompts.length === 1; // allow the first prompt, deny the second
    const responses = await call(handleOrchestrateParallel, 'agents.orchestrate.parallel', {
      config: {
        tasks: [
          { agentId: sameOriginAgent, task: 'a' },
          { agentId: crossOriginAgent, task: 'b' },
          { agentId: secondCrossOriginAgent, task: 'c' },
        ],
        combineStrategy: 'array',
      },
    });

    expect(responses).toHaveLength(1);
    const result = (responses[0] as { result: { success: boolean; taskResults: Array<{ agentId: string; success: boolean }> } }).result;
    expect(result.success).toBe(false);
    expect(result.taskResults.map((r) => r.success)).toEqual([true, true, false]);
    expect(stepChecks()).toEqual([
      { action: 'agent.invoke', server: sameOriginAgent },
      { action: 'agent.delegate.crossOrigin', server: crossOriginAgent },
      { action: 'agent.delegate.crossOrigin', server: secondCrossOriginAgent },
    ]);
    expect(prompts).toHaveLength(2);
    expect(delivered.sort()).toEqual([sameOriginAgent, crossOriginAgent].sort());
  });

  it('asks about one target at a time, never stacking prompts', async () => {
    const thirdCrossOriginAgent = target(OTHER, 'remote3');
    await call(handleOrchestrateParallel, 'agents.orchestrate.parallel', {
      config: {
        tasks: [
          { agentId: crossOriginAgent, task: 'a' },
          { agentId: secondCrossOriginAgent, task: 'b' },
          { agentId: thirdCrossOriginAgent, task: 'c' },
        ],
        combineStrategy: 'array',
      },
    });

    expect(prompts).toHaveLength(3);
    expect(mostOpenPrompts).toBe(1);
  });
});

describe('a check that throws refuses only its own step', () => {
  it('keeps the other parallel results when one task\'s check throws', async () => {
    promptAnswer = () => {
      throw new Error('prompt window failed');
    };
    const responses = await call(handleOrchestrateParallel, 'agents.orchestrate.parallel', {
      config: {
        tasks: [
          { agentId: sameOriginAgent, task: 'a' },
          { agentId: crossOriginAgent, task: 'b' },
        ],
        combineStrategy: 'array',
      },
    });

    expect(responses).toHaveLength(1);
    const result = (responses[0] as { ok: boolean; result: { taskResults: Array<{ success: boolean; result?: unknown; error?: string }> } });
    expect(result.ok).toBe(true);
    expect(result.result.taskResults.map((r) => r.success)).toEqual([true, false]);
    expect(result.result.taskResults[0]?.result).toBe('local:a');
    expect(result.result.taskResults[1]?.error).toBe('prompt window failed');
    expect(delivered).toEqual([sameOriginAgent]);
  });

  it('still checks and runs the later tasks after one task\'s check throws', async () => {
    const thirdCrossOriginAgent = target(OTHER, 'remote3');
    promptAnswer = () => {
      if (prompts.length === 1) throw new Error('prompt window failed');
      return true;
    };
    const responses = await call(handleOrchestrateParallel, 'agents.orchestrate.parallel', {
      config: {
        tasks: [
          { agentId: crossOriginAgent, task: 'a' },
          { agentId: secondCrossOriginAgent, task: 'b' },
          { agentId: thirdCrossOriginAgent, task: 'c' },
        ],
        combineStrategy: 'array',
      },
    });

    const result = (responses[0] as { result: { taskResults: Array<{ success: boolean; error?: string }> } }).result;
    expect(result.taskResults.map((r) => r.success)).toEqual([false, true, true]);
    expect(result.taskResults[0]?.error).toBe('prompt window failed');
    expect(prompts).toHaveLength(3);
    expect(delivered.sort()).toEqual([secondCrossOriginAgent, thirdCrossOriginAgent].sort());
  });
});

describe('supervisor checks each worker it assigns', () => {
  it('checks the next worker again when a refused task is reassigned', async () => {
    promptAnswer = () => false;
    const responses = await call(handleOrchestrateSupervisor, 'agents.orchestrate.supervisor', {
      supervisor: {
        id: 's',
        name: 's',
        workers: [crossOriginAgent, sameOriginAgent],
        assignmentStrategy: 'round-robin',
        retry: { maxAttempts: 1, reassignOnFailure: true },
      },
      tasks: [{ id: 't1', task: 'x' }],
    });

    const result = (responses[0] as { result: { success: boolean; results: Array<{ workerId: string; attempts: number }> } }).result;
    expect(result.success).toBe(true);
    expect(result.results[0]).toMatchObject({ workerId: sameOriginAgent, attempts: 2 });
    expect(stepChecks()).toEqual([
      { action: 'agent.delegate.crossOrigin', server: crossOriginAgent },
      { action: 'agent.invoke', server: sameOriginAgent },
    ]);
    expect(delivered).toEqual([sameOriginAgent]);
  });

  it('does not invoke a cross-origin worker the user denies', async () => {
    promptAnswer = () => false;
    const responses = await call(handleOrchestrateSupervisor, 'agents.orchestrate.supervisor', {
      supervisor: { id: 's', name: 's', workers: [crossOriginAgent], assignmentStrategy: 'round-robin' },
      tasks: [{ id: 't1', task: 'x' }],
    });

    expect(responses).toHaveLength(1);
    const result = (responses[0] as { result: { success: boolean } }).result;
    expect(result.success).toBe(false);
    expect(stepChecks()).toEqual([{ action: 'agent.delegate.crossOrigin', server: crossOriginAgent }]);
    expect(delivered).toEqual([]);
  });
});
