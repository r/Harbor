import { describe, it, expect, beforeEach, vi } from 'vitest';

import { requireAction } from '../helpers';
import { LabelFlow } from '../../../policy/label-flow';
import { Policy } from '../../../policy/store';
import { setOriginGrantResolver, setWatchdogResolver } from '../../../policy/engine';
import { compileRule, type Rule } from '../../../policy/rules';
import type { RequestContext, ResponseSender } from '../router-types';
import { resetMockBrowser } from '../../../__tests__/test-setup';

beforeEach(() => {
  resetMockBrowser();
  Policy.__reset();
  setOriginGrantResolver(() => null);
  setWatchdogResolver(() => ({ status: 'normal' }));
});

function ctx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    id: 'req-1',
    type: 'agent.tools.list',
    origin: 'https://example.com',
    payload: undefined,
    tabId: undefined,
    ...overrides,
  } as RequestContext;
}

function sender() {
  const calls: unknown[] = [];
  const sendResponse = vi.fn((r: unknown) => {
    calls.push(r);
  });
  return {
    sender: { sendResponse } as unknown as ResponseSender,
    calls,
  };
}

describe('requireAction', () => {
  it('returns true when the engine decides allow', async () => {
    const { sender: s, calls } = sender();
    const result = await requireAction(ctx(), s, 'tool.list');
    expect(result).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('sends an error and returns false when the engine denies via a managed rule', async () => {
    Policy.__setForTesting([
      compileRule({
        id: 'mgr-deny',
        effect: 'deny',
        principal: { origin: '*' },
        action: 'tool.call',
        source: 'managed',
      }),
    ]);
    const { sender: s, calls } = sender();
    const result = await requireAction(ctx(), s, 'tool.call', {
      resource: { server: 'github', tool: 'create_pr' },
    });
    expect(result).toBe(false);
    expect(calls.length).toBe(1);
    const response = calls[0] as { error: { code: string; details: { source: string } } };
    expect(response.error.code).toBe('ERR_BLOCKED_BY_POLICY');
    expect(response.error.details.source).toBe('managed');
  });

  it('passes the calling tab to the origin-grant lookup', async () => {
    const seen: Array<number | undefined> = [];
    setOriginGrantResolver((_origin, _action, _resource, tabId) => {
      seen.push(tabId);
      return { effect: 'allow', persistence: 'once' };
    });
    const { sender: s } = sender();
    const result = await requireAction(ctx({ tabId: 9 }), s, 'agent.invoke', { promptAsScope: 'agents:invoke' });
    expect(result).toBe(true);
    expect(seen).toEqual([9]);
  });

  it('passes the input labels through to the engine', async () => {
    const { sender: s, calls } = sender();
    const { LabelSet } = await import('../../../policy/labels');
    const result = await requireAction(ctx(), s, 'model.prompt.remote.thirdParty', {
      inputLabels: new LabelSet(['credentials']),
    });
    expect(result).toBe(false);
    const response = calls[0] as { error: { code: string } };
    expect(response.error.code).toBe('ERR_LABEL_FLOW_BLOCKED');
  });

  it('carries the policy decision’s output labels into the next check in the same flow', async () => {
    const flow = new LabelFlow();
    const { sender: s, calls } = sender();
    const options = { labelFlow: flow, upstreamConsent: 'origin-grant' as const };
    expect(await requireAction(ctx(), s, 'browser.read.activeTab', options)).toBe(true);
    expect(flow.labels.toArray()).toEqual(['confidential']);
    expect(await requireAction(ctx(), s, 'model.prompt.local', options)).toBe(true);
    expect(await requireAction(ctx(), s, 'model.prompt.remote.thirdParty', options)).toBe(false);
    expect(calls).toEqual([expect.objectContaining({ error: expect.objectContaining({ code: 'ERR_LABEL_FLOW_BLOCKED' }) })]);
    expect(await requireAction(ctx(), s, 'model.prompt.remote.thirdParty', { ...options, labelFlow: new LabelFlow() })).toBe(true);
  });

  it('quarantine response uses ERR_QUARANTINED', async () => {
    setWatchdogResolver(() => ({ status: 'quarantined', reason: 'rapid label egress' }));
    const { sender: s, calls } = sender();
    const result = await requireAction(ctx(), s, 'tool.list');
    expect(result).toBe(false);
    const response = calls[0] as { error: { code: string } };
    expect(response.error.code).toBe('ERR_QUARANTINED');
  });

  // model.prompt.agent's own entry in primaryLegacyScope (helpers.ts): if it
  // were missing, an "ask" decision with no caller-supplied promptAsScope
  // would have no legacy scope to prompt with, and requireAction would deny
  // instead of opening the native prompt at all — windows.create would
  // never be called.
  it('prompts with the model:prompt scope for model.prompt.agent, with no promptAsScope override', async () => {
    const create = vi.spyOn(chrome.windows, 'create').mockResolvedValue({ id: 1 } as never);
    const { sender: s } = sender();
    const resultPromise = requireAction(ctx(), s, 'model.prompt.agent');
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    const url = new URL((create.mock.calls[0][0] as { url: string }).url);
    expect(url.searchParams.get('scopes')).toBe('model:prompt');

    const { handlePermissionPromptResponse } = await import('../../../policy/permissions');
    handlePermissionPromptResponse({ granted: true, grantType: 'granted-once' });
    await resultPromise;
  });
});

describe('requireAction when the caller has stopped waiting', () => {
  const aborted = () => {
    const c = new AbortController();
    c.abort();
    return c.signal;
  };
  const expectAbandoned = (result: boolean, calls: unknown[]) => {
    expect(result).toBe(false);
    expect(calls).toEqual([expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'ERR_ABORTED' }) })]);
  };

  it('refuses an allowed call', async () => {
    const { sender: s, calls } = sender();
    expectAbandoned(await requireAction(ctx({ signal: aborted() }), s, 'tool.list'), calls);
  });

  it('refuses a call that would proceed on upstream consent', async () => {
    const { sender: s, calls } = sender();
    const result = await requireAction(ctx({ signal: aborted() }), s, 'tool.call', {
      resource: { server: 'github', tool: 'create_pr' },
      upstreamConsent: 'origin-grant',
    });
    expectAbandoned(result, calls);
  });

  it('still lets a call through when its signal has not aborted', async () => {
    const { sender: s, calls } = sender();
    expect(await requireAction(ctx({ signal: new AbortController().signal }), s, 'tool.list')).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
