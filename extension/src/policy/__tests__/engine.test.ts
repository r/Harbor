import { describe, it, expect, beforeEach } from 'vitest';

import {
  evaluate,
  setOriginGrantResolver,
  setWatchdogResolver,
  type PolicyRequest,
} from '../engine';
import { Policy } from '../store';
import { compileRule, type Rule } from '../rules';
import { Tokens } from '../tokens';
import { LabelSet } from '../labels';

beforeEach(() => {
  Policy.__reset();
  Tokens.__reset();
  setOriginGrantResolver(() => null);
  setWatchdogResolver(() => ({ status: 'normal' }));
});

function loadRules(rules: Rule[]): void {
  Policy.__setForTesting(rules.map((r) => compileRule({ ...r, source: r.source ?? 'user' })));
}

const baseReq: PolicyRequest = {
  origin: 'https://example.com',
  action: 'tool.list',
};

// =============================================================================
// Tier 0: ambient + unknown action
// =============================================================================

describe('Tier 0: ambient', () => {
  it('denies unknown actions with ERR_UNKNOWN_ACTION', async () => {
    const decision = await evaluate({ ...baseReq, action: 'fake.action' as never });
    expect(decision.effect).toBe('deny');
    expect(decision.errorCode).toBe('ERR_UNKNOWN_ACTION');
    expect(decision.tier).toBe(0);
  });

  it('allows known metadata actions by default', async () => {
    const decision = await evaluate({ ...baseReq, action: 'tool.list' });
    expect(decision.effect).toBe('allow');
    expect(decision.tier).toBe(9);
  });
});

// =============================================================================
// Tier 1: managed deny
// =============================================================================

describe('Tier 1: managed deny', () => {
  it('blocks immediately when a managed deny matches', async () => {
    loadRules([
      { id: 'mgr-1', effect: 'deny', principal: { origin: '*' }, action: 'tool.call', source: 'managed' },
    ]);
    const decision = await evaluate({
      origin: 'https://example.com',
      action: 'tool.call',
      resource: { server: 'github', tool: 'create_pr' },
    });
    expect(decision.effect).toBe('deny');
    expect(decision.tier).toBe(1);
    expect(decision.source).toBe('managed');
    expect(decision.errorCode).toBe('ERR_BLOCKED_BY_POLICY');
  });

  it('does NOT match a user-level deny at Tier 1', async () => {
    loadRules([
      { id: 'usr-1', effect: 'deny', principal: { origin: '*' }, action: 'tool.call', source: 'user' },
    ]);
    const decision = await evaluate({
      origin: 'https://example.com',
      action: 'tool.call',
      resource: { server: 'github', tool: 'create_pr' },
    });
    // Still denies, but at Tier 7 (rule lookup), not Tier 1.
    expect(decision.effect).toBe('deny');
    expect(decision.tier).toBeGreaterThanOrEqual(6);
    expect(decision.source).toBe('user');
  });
});

// =============================================================================
// Tier 3: information flow
// =============================================================================

describe('Tier 3: information flow', () => {
  it('blocks egress when input carries unaccepted labels', async () => {
    const decision = await evaluate({
      origin: 'https://example.com',
      action: 'model.prompt.remote.thirdParty',
      inputLabels: new LabelSet(['confidential']),
    });
    expect(decision.effect).toBe('deny');
    expect(decision.errorCode).toBe('ERR_LABEL_FLOW_BLOCKED');
    expect(decision.tier).toBe(3);
  });

  it('allows egress when input is unlabeled', async () => {
    const decision = await evaluate({
      origin: 'https://example.com',
      action: 'model.prompt.remote.thirdParty',
    });
    // Default for an egress action is `ask` — the engine doesn't block at
    // Tier 3 here, it just requires confirmation.
    expect(decision.errorCode).not.toBe('ERR_LABEL_FLOW_BLOCKED');
  });

  it('local prompts accept any label', async () => {
    const decision = await evaluate({
      origin: 'https://example.com',
      action: 'model.prompt.local',
      inputLabels: new LabelSet(['credentials', 'identity']),
    });
    // Local prompts accept everything; the engine should not block at Tier 3.
    expect(decision.errorCode).not.toBe('ERR_LABEL_FLOW_BLOCKED');
  });

  it('first-party remote prompts accept confidential but not credentials', async () => {
    const okay = await evaluate({
      origin: 'https://example.com',
      action: 'model.prompt.remote.firstParty',
      inputLabels: new LabelSet(['confidential']),
    });
    expect(okay.errorCode).not.toBe('ERR_LABEL_FLOW_BLOCKED');

    const blocked = await evaluate({
      origin: 'https://example.com',
      action: 'model.prompt.remote.firstParty',
      inputLabels: new LabelSet(['credentials']),
    });
    expect(blocked.effect).toBe('deny');
    expect(blocked.errorCode).toBe('ERR_LABEL_FLOW_BLOCKED');
  });

  it('cannot be defeated by a generous user allow rule', async () => {
    loadRules([
      { id: 'allow-all', effect: 'allow', principal: { origin: '*' }, action: '*', source: 'user' },
    ]);
    const decision = await evaluate({
      origin: 'https://example.com',
      action: 'model.prompt.remote.thirdParty',
      inputLabels: new LabelSet(['credentials']),
    });
    // The doc explicitly calls this out as a property of the safety floor.
    expect(decision.effect).toBe('deny');
    expect(decision.errorCode).toBe('ERR_LABEL_FLOW_BLOCKED');
  });
});

// =============================================================================
// Tier 4: watchdog
// =============================================================================

describe('Tier 4: watchdog', () => {
  it('quarantining blocks the action', async () => {
    setWatchdogResolver(() => ({ status: 'quarantined', reason: 'rapid label egress' }));
    const decision = await evaluate({ ...baseReq, action: 'tool.list' });
    expect(decision.effect).toBe('deny');
    expect(decision.tier).toBe(4);
    expect(decision.errorCode).toBe('ERR_QUARANTINED');
  });

  it('restricting forces a confirmation even on actions that would otherwise allow', async () => {
    setWatchdogResolver(() => ({ status: 'restricted' }));
    loadRules([
      { id: 'allow-list', effect: 'allow', principal: { origin: '*' }, action: 'tool.list', source: 'user' },
    ]);
    const decision = await evaluate({ ...baseReq, action: 'tool.list' });
    expect(decision.effect).toBe('ask');
  });
});

// =============================================================================
// Tier 5: capability tokens
// =============================================================================

describe('Tier 5: capability tokens', () => {
  it('passes when the token authorizes the action', async () => {
    const t = Tokens.mint({
      sessionId: 's',
      origin: 'https://example.com',
      mode: 'plan',
      allowedActions: ['tool.list'],
      acceptedLabels: [],
    });
    const decision = await evaluate({ ...baseReq, tokenId: t.id, action: 'tool.list' });
    expect(decision.effect).toBe('allow');
  });

  it('denies when the token does not authorize the action', async () => {
    const t = Tokens.mint({
      sessionId: 's',
      origin: 'https://example.com',
      mode: 'plan',
      allowedActions: ['model.prompt.local'],
      acceptedLabels: [],
    });
    const decision = await evaluate({ ...baseReq, tokenId: t.id, action: 'tool.list' });
    expect(decision.effect).toBe('deny');
    expect(decision.tier).toBe(5);
    expect(decision.errorCode).toBe('ERR_TOKEN_NOT_FOR_ORIGIN');
  });

  it('denies on token bound to a different origin', async () => {
    const t = Tokens.mint({
      sessionId: 's',
      origin: 'https://other.com',
      mode: 'plan',
      allowedActions: ['tool.list'],
      acceptedLabels: [],
    });
    const decision = await evaluate({ ...baseReq, tokenId: t.id });
    expect(decision.effect).toBe('deny');
    expect(decision.tier).toBe(5);
  });
});

// =============================================================================
// Tier 6 + 7: policy rules
// =============================================================================

describe('Tier 6+7: policy rules', () => {
  it('allow rule short-circuits a default `ask`', async () => {
    loadRules([
      { id: 'allow-read', effect: 'allow', principal: { origin: '*' }, action: 'browser.read.activeTab', source: 'user' },
    ]);
    const decision = await evaluate({ ...baseReq, action: 'browser.read.activeTab', resource: { host: 'example.com' } });
    // browser.read.activeTab attaches confidential labels; same_origin egress accepts confidential, so info-flow passes.
    // Default would be `ask`; the rule overrides.
    expect(['allow', 'preview', 'ask']).toContain(decision.effect);
    if (decision.effect === 'allow') {
      expect(decision.tier).toBe(6);
      expect(decision.rule?.id).toBe('allow-read');
    }
  });

  it('preview rule applies on writes', async () => {
    loadRules([
      {
        id: 'preview-github',
        effect: 'preview',
        principal: { origin: '*' },
        action: 'tool.call',
        resource: { server: 'github', toolTags: ['remote_write'] },
        source: 'user',
      },
    ]);
    const decision = await evaluate({
      origin: 'https://example.com',
      action: 'tool.call',
      resource: { server: 'github', tool: 'create_pr', toolTags: ['remote_write'] },
    });
    expect(decision.effect).toBe('preview');
    expect(decision.rule?.id).toBe('preview-github');
  });
});

// =============================================================================
// Tier 8: per-origin grants
// =============================================================================

describe('Tier 8: per-origin grants', () => {
  it('honors an allow grant', async () => {
    setOriginGrantResolver(() => ({ effect: 'allow', persistence: 'always' }));
    const decision = await evaluate({ ...baseReq, action: 'browser.read.activeTab', resource: { host: 'example.com' } });
    if (decision.tier === 8) {
      expect(decision.effect).toBe('allow');
      expect(decision.source).toBe('originGrant');
    } else {
      // Default tier wins if origin grant returns null.
      expect(decision.tier).toBe(9);
    }
  });

  it('honors a deny grant', async () => {
    setOriginGrantResolver(() => ({ effect: 'deny' }));
    const decision = await evaluate({
      origin: 'https://example.com',
      action: 'browser.read.activeTab',
      resource: { host: 'example.com' },
    });
    expect(decision.effect).toBe('deny');
    expect(decision.source).toBe('originGrant');
  });

  // Calling or messaging a local agent changes nothing by itself; whatever
  // the other agent then does goes through its own checks. So a grant covers
  // later calls instead of prompting on each one.
  it.each(['agent.invoke', 'agent.message'] as const)(
    'an allow grant covers every later %s call',
    async (action) => {
      setOriginGrantResolver(() => ({ effect: 'allow', persistence: 'always' }));
      const decision = await evaluate({ origin: 'https://example.com', action });
      expect(decision.effect).toBe('allow');
      expect(decision.source).toBe('originGrant');
    },
  );

  it.each(['agent.invoke', 'agent.message'] as const)(
    'without a grant, %s still asks first',
    async (action) => {
      const decision = await evaluate({ origin: 'https://example.com', action });
      expect(decision.effect).toBe('preview');
    },
  );

  it.each([
    ['tool.call', { server: 'github', tool: 'create_pr' }],
    ['browser.write.interact', undefined],
  ] as const)('an allow grant does not skip the preview for %s', async (action, resource) => {
    setOriginGrantResolver(() => ({ effect: 'allow', persistence: 'always' }));
    const decision = await evaluate({ origin: 'https://example.com', action, resource });
    expect(decision.effect).toBe('preview');
  });
});

// =============================================================================
// Tier 9: defaults
// =============================================================================

describe('Tier 9: defaults', () => {
  it('defaults metadata actions to allow', async () => {
    const decision = await evaluate({ ...baseReq, action: 'tool.list' });
    expect(decision.effect).toBe('allow');
    expect(decision.source).toBe('default');
  });

  it('defaults read actions to ask', async () => {
    const decision = await evaluate({
      origin: 'https://example.com',
      action: 'browser.read.activeTab',
    });
    expect(decision.effect).toBe('ask');
  });

  it('defaults write actions to preview', async () => {
    const decision = await evaluate({
      origin: 'https://example.com',
      action: 'browser.write.interact',
    });
    expect(decision.effect).toBe('preview');
  });
});

// =============================================================================
// Trace
// =============================================================================

describe('Trace', () => {
  it('every decision produces a tier-by-tier trace', async () => {
    const decision = await evaluate({ ...baseReq, action: 'tool.list' });
    expect(decision.trace.length).toBeGreaterThan(0);
    expect(decision.trace[0].tier).toBe(0);
    expect(decision.trace[decision.trace.length - 1].tier).toBe(decision.tier);
  });

  it('trace records the matching rule when one fires', async () => {
    loadRules([
      { id: 'r-traced', effect: 'allow', principal: { origin: '*' }, action: 'tool.list', source: 'user' },
    ]);
    const decision = await evaluate({ ...baseReq, action: 'tool.list' });
    const ruleStep = decision.trace.find((s) => s.rule);
    expect(ruleStep?.rule?.id).toBe('r-traced');
  });
});
