import { describe, it, expect, beforeEach, vi } from 'vitest';

import { requireAction } from '../helpers';
import { Policy } from '../../../policy/store';
import { Tokens } from '../../../policy/tokens';
import { setOriginGrantResolver, setWatchdogResolver } from '../../../policy/engine';
import { compileRule, type Rule } from '../../../policy/rules';
import type { RequestContext, ResponseSender } from '../router-types';
import { resetMockBrowser } from '../../../__tests__/test-setup';

beforeEach(() => {
  resetMockBrowser();
  Policy.__reset();
  Tokens.__reset();
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

  it('passes the token id and rejects bad tokens', async () => {
    const t = Tokens.mint({
      sessionId: 's',
      origin: 'https://example.com',
      allowedActions: ['model.prompt.local'],
      acceptedLabels: [],
    });
    const { sender: s, calls } = sender();
    const result = await requireAction(ctx(), s, 'tool.list', { tokenId: t.id });
    expect(result).toBe(false);
    const response = calls[0] as { error: { code: string } };
    expect(response.error.code).toBe('ERR_TOKEN_NOT_FOR_ORIGIN');
  });

  it('quarantine response uses ERR_QUARANTINED', async () => {
    setWatchdogResolver(() => ({ status: 'quarantined', reason: 'rapid label egress' }));
    const { sender: s, calls } = sender();
    const result = await requireAction(ctx(), s, 'tool.list');
    expect(result).toBe(false);
    const response = calls[0] as { error: { code: string } };
    expect(response.error.code).toBe('ERR_QUARANTINED');
  });
});
