import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { RequestContext, ResponseSender } from '../router-types';
import type { TransportResponse } from '../../types';

// Every answer an agent sends a caller says which site's agent sent it, so
// the receiver can judge how sensitive it is. Harbor fills the provenance
// from its own registry; an agent can't supply or overwrite it. The checks
// run through the real grant store and PolicyEngine; only the prompt window
// is replaced.

vi.mock('../../../policy/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../policy/permissions')>()),
  showPermissionPrompt: vi.fn(async () => ({ granted: false, explicitDeny: true })),
}));

import { setOriginGrantResolver, setWatchdogResolver } from '../../../policy/engine';
import { originGrantResolver } from '../../../policy/origin-grants';
import { grantPermissions } from '../../../policy/permissions';
import { Policy } from '../../../policy/store';
import { resetMockBrowser } from '../../../__tests__/test-setup';
import { registerInvocationHandler } from '../../../multi-agent/messaging';
import {
  handleAgentsRegister,
  handleAgentsRegisterMessageHandler,
  handleAgentsSubscribe,
  handleAgentsSend,
  handleAgentsInvoke,
  handleAgentsBroadcast,
  handleOrchestratePipeline,
  handleOrchestrateParallel,
  handleOrchestrateRoute,
  handleOrchestrateSupervisor,
  forgetTabAgents,
} from '../multi-agent';

const A = 'https://a.example';
const BANK = 'https://bank.example';
const TAB = { [A]: 3, [BANK]: 5 } as Record<string, number>;

const tabMessages: Array<{ tabId: number; message: unknown }> = [];

async function call(
  handler: (ctx: RequestContext, sender: ResponseSender) => unknown,
  origin: string,
  type: string,
  payload: unknown,
): Promise<TransportResponse> {
  const responses: TransportResponse[] = [];
  await handler(
    { id: 'q', type, origin, tabId: TAB[origin], payload } as RequestContext,
    { sendResponse: (r: TransportResponse) => responses.push(r), sendStreamEvent: () => {} },
  );
  return responses[0]!;
}

function resultOf<T>(response: TransportResponse): T {
  expect(response.ok).toBe(true);
  return (response as unknown as { result: T }).result;
}

async function pageAgent(origin: string): Promise<string> {
  await grantPermissions(origin, ['agents:register', 'agents:message', 'agents:invoke'], 'granted-always');
  const id = resultOf<{ id: string }>(await call(handleAgentsRegister, origin, 'agents.register', { name: `agent@${origin}` })).id;
  await call(handleAgentsRegisterMessageHandler, origin, 'agents.registerMessageHandler', { agentId: id, origin, tabId: TAB[origin] });
  return id;
}

let onA: string;
let onBank: string;

beforeEach(async () => {
  // Each test starts with no agents, so a site's caller agent is this test's.
  for (const tabId of Object.values(TAB)) forgetTabAgents(tabId);
  resetMockBrowser();
  Policy.__reset();
  setWatchdogResolver(() => ({ status: 'normal' }));
  setOriginGrantResolver(originGrantResolver);
  tabMessages.length = 0;
  (chrome.tabs as unknown as { sendMessage: unknown }).sendMessage = vi.fn(async (tabId: number, message: unknown) => {
    tabMessages.push({ tabId, message });
  });
  (chrome.tabs as unknown as { get: unknown }).get = vi.fn(async (tabId: number) => ({
    id: tabId,
    url: `${Object.keys(TAB).find((site) => TAB[site] === tabId)}/page`,
  }));

  onBank = await pageAgent(BANK);
  onA = await pageAgent(A);
  await grantPermissions(A, ['agents:crossOrigin'], 'granted-always', undefined, undefined, undefined, [BANK]);
  await grantPermissions(BANK, ['agents:crossOrigin'], 'granted-always', undefined, undefined, undefined, [A]);
  // The bank's agent answers, and tries to claim it's someone else.
  registerInvocationHandler(onBank, async () => ({
    success: true,
    result: { balance: 12 },
    executionTime: 0,
    provenance: { source: 'agent', origin: 'https://forged.example', agentId: 'nobody' },
  } as never));
});

const fromBank = () => ({ source: 'agent', origin: BANK, agentId: onBank });

describe('an invoke answer', () => {
  it('carries the answering agent\'s site, not one the agent claims', async () => {
    const answer = resultOf<{ success: boolean; provenance?: unknown }>(
      await call(handleAgentsInvoke, A, 'agents.invoke', { agentId: onBank, task: 'balance' }),
    );

    expect(answer.success).toBe(true);
    expect(answer.provenance).toEqual(fromBank());
  });

  it('carries it on an error the agent itself returned', async () => {
    registerInvocationHandler(onBank, async () => ({
      success: false,
      error: { code: 'ERR_HANDLER_FAILED', message: 'no' },
      executionTime: 0,
    }));

    const answer = resultOf<{ success: boolean; provenance?: unknown }>(
      await call(handleAgentsInvoke, A, 'agents.invoke', { agentId: onBank, task: 'balance' }),
    );

    expect(answer.success).toBe(false);
    expect(answer.provenance).toEqual(fromBank());
  });

  it('has none when Harbor answers instead, because no agent did', async () => {
    const answer = resultOf<{ success: boolean; provenance?: unknown }>(
      await call(handleAgentsInvoke, A, 'agents.invoke', { agentId: 'agent-missing', task: 'balance' }),
    );

    expect(answer.success).toBe(false);
    expect(answer.provenance).toBeUndefined();
  });
});

describe('a message', () => {
  it('carries the sending agent\'s site', async () => {
    await call(handleAgentsSend, BANK, 'agents.send', { agentId: onA, payload: 'hi' });

    await vi.waitFor(() => expect(tabMessages).toHaveLength(1));
    const event = (tabMessages[0]!.message as { event: { message: { provenance?: unknown } } }).event;
    expect(event.message.provenance).toEqual(fromBank());
  });
});

describe('a broadcast', () => {
  it('carries the broadcasting agent\'s site', async () => {
    await call(handleAgentsSubscribe, A, 'agents.subscribe', { eventType: 'rates' });

    await call(handleAgentsBroadcast, BANK, 'agents.broadcast', { eventType: 'rates', data: 4 });

    await vi.waitFor(() => expect(tabMessages).toHaveLength(1));
    const event = (tabMessages[0]!.message as { event: { broadcast: { provenance?: unknown } } }).event;
    expect(event.broadcast.provenance).toEqual(fromBank());
  });
});

describe('orchestration step results', () => {
  it('carry each step\'s agent site in a pipeline', async () => {
    const result = resultOf<{ stepResults: Array<{ provenance?: unknown }> }>(
      await call(handleOrchestratePipeline, A, 'agents.orchestrate.pipeline', {
        config: { steps: [{ agentId: onBank, task: 'balance' }] },
        initialInput: 'x',
      }),
    );

    expect(result.stepResults.map((s) => s.provenance)).toEqual([fromBank()]);
  });

  it('carry each task\'s agent site in a parallel run', async () => {
    const result = resultOf<{ taskResults: Array<{ provenance?: unknown }> }>(
      await call(handleOrchestrateParallel, A, 'agents.orchestrate.parallel', {
        config: { tasks: [{ agentId: onBank, task: 'balance' }], combineStrategy: 'array' },
      }),
    );

    expect(result.taskResults.map((t) => t.provenance)).toEqual([fromBank()]);
  });

  it('carry the chosen agent\'s site on a routed answer', async () => {
    const result = resultOf<{ invocationResult: { provenance?: unknown } }>(
      await call(handleOrchestrateRoute, A, 'agents.orchestrate.route', {
        config: { routes: [{ condition: 'always', agentId: onBank }] },
        input: 'x',
        task: 'balance',
      }),
    );

    expect(result.invocationResult.provenance).toEqual(fromBank());
  });

  it('carry each worker\'s site in a supervisor run', async () => {
    const result = resultOf<{ results: Array<{ provenance?: unknown }> }>(
      await call(handleOrchestrateSupervisor, A, 'agents.orchestrate.supervisor', {
        supervisor: { id: 's', name: 's', workers: [onBank], assignmentStrategy: 'round-robin' },
        tasks: [{ id: 't1', task: 'balance' }],
      }),
    );

    expect(result.results.map((r) => r.provenance)).toEqual([fromBank()]);
  });
});
