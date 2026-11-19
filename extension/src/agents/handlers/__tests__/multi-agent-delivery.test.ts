import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { RequestContext, ResponseSender } from '../router-types';
import type { TransportResponse } from '../../types';

// Messages and broadcasts reach page agents through their tab, and a
// broadcast reaches only sites the sender may reach. The checks run through
// the real grant store and PolicyEngine; only the prompt window is replaced.

type PromptCall = { origin: string; scopes: string[]; agentOrigins?: string[] };
const prompts: PromptCall[] = [];
let promptSites: (call: PromptCall) => string[] | undefined = (call) => call.agentOrigins;
vi.mock('../../../policy/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../policy/permissions')>()),
  showPermissionPrompt: vi.fn(
    async (origin: string, scopes: string[], _r?: string, _t?: string[], _s?: unknown, agentOrigins?: string[]) => {
      const call = { origin, scopes, agentOrigins };
      prompts.push(call);
      return { granted: true, grantType: 'granted-once' as const, agentOrigins: promptSites(call) };
    },
  ),
}));

import { setOriginGrantResolver, setWatchdogResolver } from '../../../policy/engine';
import { originGrantResolver } from '../../../policy/origin-grants';
import { grantPermissions, isAgentOriginAllowed } from '../../../policy/permissions';
import { Policy } from '../../../policy/store';
import { resetMockBrowser } from '../../../__tests__/test-setup';
import { registerAgent } from '../../../multi-agent/registry';
import { registerInvocationHandler } from '../../../multi-agent/messaging';
import {
  handleAgentsRegister,
  handleAgentsRegisterMessageHandler,
  handleAgentsSubscribe,
  handleAgentsSend,
  handleAgentsInvoke,
  handleAgentsBroadcast,
} from '../multi-agent';

const A = 'https://a.example';
const B = 'https://b.example';
const C = 'https://c.example';
const TAB = { [A]: 3, [B]: 5, [C]: 6 } as Record<string, number>;

const tabMessages: Array<{ tabId: number; message: unknown }> = [];

async function call(
  handler: (ctx: RequestContext, sender: ResponseSender) => unknown,
  origin: string,
  type: string,
  payload: unknown,
  tabId = TAB[origin],
): Promise<TransportResponse> {
  const responses: TransportResponse[] = [];
  await handler(
    { id: 'q', type, origin, tabId, payload } as RequestContext,
    { sendResponse: (r: TransportResponse) => responses.push(r), sendStreamEvent: () => {} },
  );
  return responses[0]!;
}

/** Register a page agent the way the page API does, with a message proxy to its tab. */
async function pageAgent(origin: string): Promise<string> {
  await grantPermissions(origin, ['agents:register', 'agents:message', 'agents:invoke'], 'granted-always');
  const registered = await call(handleAgentsRegister, origin, 'agents.register', { name: `agent@${origin}` });
  const id = (registered as { result: { id: string } }).result.id;
  await call(handleAgentsRegisterMessageHandler, origin, 'agents.registerMessageHandler', { agentId: id, origin, tabId: TAB[origin] });
  return id;
}

beforeEach(async () => {
  resetMockBrowser();
  Policy.__reset();
  setWatchdogResolver(() => ({ status: 'normal' }));
  setOriginGrantResolver(originGrantResolver);
  prompts.length = 0;
  tabMessages.length = 0;
  promptSites = (c) => c.agentOrigins;
  (chrome.tabs as unknown as { sendMessage: unknown }).sendMessage = vi.fn(async (tabId: number, message: unknown) => {
    tabMessages.push({ tabId, message });
  });
});

describe('messages reach a page agent', () => {
  it('forwards a message to the recipient\'s tab as an agent event', async () => {
    const onB = await pageAgent(B);
    await pageAgent(A);

    const response = await call(handleAgentsSend, A, 'agents.send', { agentId: onB, payload: 'hi' });

    expect((response as { result: { delivered: boolean } }).result.delivered).toBe(true);
    expect(tabMessages).toEqual([
      { tabId: 5, message: { type: 'agentEvent', event: { type: 'message', message: expect.objectContaining({ to: onB, payload: 'hi' }) } } },
    ]);
  });

  it('does not let a page take over another site\'s agent messages', async () => {
    const onB = await pageAgent(B);
    // C asks for B's messages to go to C's tab.
    await call(handleAgentsRegisterMessageHandler, C, 'agents.registerMessageHandler', { agentId: onB, origin: C, tabId: 6 });
    await pageAgent(A);
    tabMessages.length = 0;

    await call(handleAgentsSend, A, 'agents.send', { agentId: onB, payload: 'hi' });

    expect(tabMessages.map((m) => m.tabId)).toEqual([5]);
  });
});

describe('broadcasts reach only sites the sender may reach', () => {
  it('delivers to subscribers on granted sites and not others', async () => {
    const onB = await pageAgent(B);
    await pageAgent(C);
    await call(handleAgentsSubscribe, B, 'agents.subscribe', { eventType: 'news' });
    await call(handleAgentsSubscribe, C, 'agents.subscribe', { eventType: 'news' });
    await pageAgent(A);
    await grantPermissions(A, ['agents:crossOrigin'], 'granted-always', undefined, undefined, [B]);
    tabMessages.length = 0;

    const response = await call(handleAgentsBroadcast, A, 'agents.broadcast', { eventType: 'news', data: { n: 1 } });

    expect((response as { result: { delivered: number } }).result.delivered).toBe(1);
    expect(prompts).toEqual([]);
    expect(tabMessages).toEqual([
      { tabId: 5, message: { type: 'agentEvent', event: { type: 'broadcast', broadcast: { type: 'news', data: { n: 1 }, source: expect.any(String) } } } },
    ]);
    expect(onB).toBeTruthy();
  });
});

describe('a shared "Allow once" answer', () => {
  it('grants each caller only the site it asked about', async () => {
    await pageAgent(A);
    const onB = registerAgent({ name: 'b' }, B, 5).id;
    registerInvocationHandler(onB, async () => ({ success: true, result: 1, executionTime: 0 }));
    // A merged prompt showed B and C; this call asked only about B.
    promptSites = () => [B, C];

    await call(handleAgentsInvoke, A, 'agents.invoke', { agentId: onB, task: 't' });

    expect(await isAgentOriginAllowed(A, B, 3)).toBe(true);
    expect(await isAgentOriginAllowed(A, C, 3)).toBe(false);
  });
});

describe('agent ids', () => {
  it('are random, not a timestamp and counter', () => {
    const one = registerAgent({ name: 'x' }, A, 3).id;
    const two = registerAgent({ name: 'y' }, A, 3).id;
    expect(one).toMatch(/^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(two).not.toBe(one);
  });
});
