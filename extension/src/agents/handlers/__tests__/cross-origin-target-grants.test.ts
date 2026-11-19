import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { RequestContext, ResponseSender } from '../router-types';
import type { TransportResponse } from '../../types';

// Allowing a page to call agents on one other site must not let it call,
// message or discover agents on any other site. These tests run through the
// real grant store and the real PolicyEngine lookup; only the prompt window
// is replaced. The stand-in prompt answers for exactly the target sites it
// was shown, as the real prompt page does.

type PromptCall = { origin: string; scopes: string[]; agentOrigins?: string[] };
const prompts: PromptCall[] = [];
let promptAnswer: (call: PromptCall) => boolean = () => true;
vi.mock('../../../policy/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../policy/permissions')>()),
  showPermissionPrompt: vi.fn(
    async (
      origin: string,
      scopes: string[],
      _reason?: string,
      _tools?: string[],
      _session?: unknown,
      agentOrigins?: string[],
    ) => {
      const call = { origin, scopes, agentOrigins };
      prompts.push(call);
      return promptAnswer(call)
        ? { granted: true, grantType: 'granted-always' as const, agentOrigins }
        : { granted: false, explicitDeny: true };
    },
  ),
}));

import { setOriginGrantResolver, setWatchdogResolver } from '../../../policy/engine';
import { originGrantResolver } from '../../../policy/origin-grants';
import { grantPermissions, getPermissionStatus, handlePermissionPromptResponse } from '../../../policy/permissions';
import { Policy } from '../../../policy/store';
import { resetMockBrowser, getMockStorage } from '../../../__tests__/test-setup';
import { registerAgent } from '../../../multi-agent/registry';
import { registerInvocationHandler, registerMessageHandler } from '../../../multi-agent/messaging';
import { routeExtensionApiMessage } from '../../../extension-api';
import {
  handleAgentsRegister,
  handleAgentsInvoke,
  handleAgentsDiscover,
  handleAgentsGetInfo,
  handleAgentsSend,
  handleOrchestratePipeline,
} from '../multi-agent';

const A = 'https://a.example'; // the calling page
const B = 'https://b.example';
const C = 'https://c.example';

const delivered: string[] = [];

function target(origin: string, name: string): string {
  const agent = registerAgent({ name }, origin, 7);
  registerInvocationHandler(agent.id, async (request) => {
    delivered.push(agent.id);
    return { success: true, result: `${name}:${request.task}`, executionTime: 0 };
  });
  registerMessageHandler(agent.id, () => {
    delivered.push(`message:${agent.id}`);
  });
  return agent.id;
}

async function call(
  handler: (ctx: RequestContext, sender: ResponseSender) => Promise<void>,
  type: string,
  payload: unknown,
): Promise<TransportResponse> {
  const responses: TransportResponse[] = [];
  await handler(
    { id: 'q1', type, origin: A, tabId: 3, payload } as RequestContext,
    { sendResponse: (r: TransportResponse) => responses.push(r), sendStreamEvent: () => {} },
  );
  expect(responses).toHaveLength(1);
  return responses[0]!;
}

function invokeResult(response: TransportResponse): { success: boolean } | undefined {
  return response.ok ? (response as { result: { success: boolean } }).result : undefined;
}

let onB: string;
let onC: string;

beforeEach(async () => {
  resetMockBrowser();
  Policy.__reset();
  setWatchdogResolver(() => ({ status: 'normal' }));
  setOriginGrantResolver(originGrantResolver);
  prompts.length = 0;
  delivered.length = 0;
  promptAnswer = () => true;
  // Close any real prompt a previous test left open, so requests don't merge into it.
  handlePermissionPromptResponse({ granted: false });

  // The calling page may register, discover, invoke and message; it holds
  // no cross-origin grant yet.
  await grantPermissions(A, ['agents:register', 'agents:discover', 'agents:invoke', 'agents:message'], 'granted-always');
  const registered: TransportResponse[] = [];
  await handleAgentsRegister(
    { id: 'r1', type: 'agents.register', origin: A, tabId: 3, payload: { name: 'Caller' } } as RequestContext,
    { sendResponse: (r: TransportResponse) => registered.push(r), sendStreamEvent: () => {} },
  );
  expect(registered[0]?.ok).toBe(true);

  onB = target(B, 'b-agent');
  onC = target(C, 'c-agent');
});

describe('invoke: a grant covers only the site it was asked about', () => {
  it('names the target site in the prompt', async () => {
    await call(handleAgentsInvoke, 'agents.invoke', { agentId: onB, task: 't' });

    expect(prompts).toEqual([{ origin: A, scopes: ['agents:crossOrigin'], agentOrigins: [B] }]);
    expect(delivered).toEqual([onB]);
  });

  it('asks again for a second site after the first was allowed', async () => {
    await call(handleAgentsInvoke, 'agents.invoke', { agentId: onB, task: 't' });
    promptAnswer = () => false;
    const response = await call(handleAgentsInvoke, 'agents.invoke', { agentId: onC, task: 't' });

    expect(prompts.map((p) => p.agentOrigins)).toEqual([[B], [C]]);
    expect(response.ok).toBe(false);
    expect(delivered).toEqual([onB]);
  });

  it('does not ask again for the site already allowed', async () => {
    await call(handleAgentsInvoke, 'agents.invoke', { agentId: onB, task: 't' });
    await call(handleAgentsInvoke, 'agents.invoke', { agentId: onB, task: 'again' });

    expect(prompts).toHaveLength(1);
    expect(delivered).toEqual([onB, onB]);
  });

  it('ignores an old site-wide agents:crossOrigin grant', async () => {
    // The shape older Harbor builds stored: one grant for every other site.
    await grantPermissions(A, ['agents:crossOrigin'], 'granted-always');
    promptAnswer = () => false;
    const response = await call(handleAgentsInvoke, 'agents.invoke', { agentId: onB, task: 't' });

    expect(prompts).toHaveLength(1);
    expect(response.ok).toBe(false);
    expect(delivered).toEqual([]);
  });
});

describe('orchestration: each step needs a grant for its own site', () => {
  it('asks about a step on a new site even after another site was allowed', async () => {
    await call(handleAgentsInvoke, 'agents.invoke', { agentId: onB, task: 't' });
    delivered.length = 0;
    promptAnswer = () => false;

    const response = await call(handleOrchestratePipeline, 'agents.orchestrate.pipeline', {
      config: { steps: [{ agentId: onB, task: 'one' }, { agentId: onC, task: 'two' }] },
      initialInput: 'x',
    });

    expect(invokeResult(response)?.success).toBe(false);
    expect(prompts.map((p) => p.agentOrigins)).toEqual([[B], [C]]);
    expect(delivered).toEqual([onB]);
  });
});

describe('discovery and getInfo show only sites the page may call', () => {
  it('lists cross-origin agents only on allowed sites', async () => {
    const before = await call(handleAgentsDiscover, 'agents.discover', { includeCrossOrigin: true });
    const originsBefore = new Set((before as { result: Array<{ origin: string }> }).result.map((a) => a.origin));
    expect(originsBefore.has(B)).toBe(false);
    expect(originsBefore.has(C)).toBe(false);

    await call(handleAgentsInvoke, 'agents.invoke', { agentId: onB, task: 't' });

    const after = await call(handleAgentsDiscover, 'agents.discover', { includeCrossOrigin: true });
    const originsAfter = new Set((after as { result: Array<{ origin: string }> }).result.map((a) => a.origin));
    expect(originsAfter.has(B)).toBe(true);
    expect(originsAfter.has(C)).toBe(false);
  });

  it('returns info for an agent only on an allowed site', async () => {
    await call(handleAgentsInvoke, 'agents.invoke', { agentId: onB, task: 't' });

    const infoB = await call(handleAgentsGetInfo, 'agents.getInfo', { agentId: onB });
    const infoC = await call(handleAgentsGetInfo, 'agents.getInfo', { agentId: onC });
    expect((infoB as { result: { id: string } | null }).result?.id).toBe(onB);
    expect((infoC as { result: unknown }).result).toBeNull();
  });
});

describe('messages: the target site needs its own grant', () => {
  it('asks before messaging an agent on another site, naming that site', async () => {
    const response = await call(handleAgentsSend, 'agents.send', { agentId: onB, payload: 'hi' });

    expect(response.ok).toBe(true);
    expect(prompts).toEqual([{ origin: A, scopes: ['agents:crossOrigin'], agentOrigins: [B] }]);
    expect(delivered).toEqual([`message:${onB}`]);
  });

  it('refuses a message to a site that was not allowed', async () => {
    await call(handleAgentsSend, 'agents.send', { agentId: onB, payload: 'hi' });
    promptAnswer = () => false;
    const response = await call(handleAgentsSend, 'agents.send', { agentId: onC, payload: 'hi' });

    expect(response.ok).toBe(false);
    expect(delivered).toEqual([`message:${onB}`]);
  });
});

describe('requestPermissions names the target sites', () => {
  // requestPermissions opens the real prompt window (the stand-in above only
  // covers calls from other modules), so these tests answer that window.
  it('rejects agents:crossOrigin without target sites', async () => {
    const create = vi.spyOn(chrome.windows, 'create');
    const response = await routeExtensionApiMessage(
      { type: 'permissions.request', payload: { origin: A, scopes: ['agents:crossOrigin'] } },
      { id: 'harbor-test' },
    );

    expect(response.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
    create.mockRestore();
  });

  it('shows and grants exactly the named sites', async () => {
    const create = vi.spyOn(chrome.windows, 'create');
    const pending = routeExtensionApiMessage(
      { type: 'permissions.request', payload: { origin: A, scopes: ['agents:crossOrigin'], agentOrigins: [B] } },
      { id: 'harbor-test' },
    );
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    const url = new URL((create.mock.calls[0]![0] as { url: string }).url);
    expect(url.searchParams.get('agentOrigins')).toBe(B);
    handlePermissionPromptResponse({ granted: true, grantType: 'granted-always', agentOrigins: [B] });
    create.mockRestore();

    expect((await pending).ok).toBe(true);
    expect((await getPermissionStatus(A)).agentOrigins).toEqual([B]);

    // Calling B needs no further prompt; calling C still does.
    promptAnswer = () => false;
    await call(handleAgentsInvoke, 'agents.invoke', { agentId: onB, task: 't' });
    await call(handleAgentsInvoke, 'agents.invoke', { agentId: onC, task: 't' });
    expect(prompts.map((p) => p.agentOrigins)).toEqual([[C]]);
    expect(delivered).toEqual([onB]);
  });

  it('stores the grant per target site', async () => {
    await call(handleAgentsInvoke, 'agents.invoke', { agentId: onB, task: 't' });

    const stored = (getMockStorage().local.data['harbor_origin_permissions'] as Record<string, { scopes: Record<string, unknown>; agentOrigins?: Record<string, unknown> }>)[A];
    expect(Object.keys(stored?.agentOrigins ?? {})).toEqual([B]);
    expect(stored?.scopes['agents:crossOrigin']).toBeUndefined();
  });
});
