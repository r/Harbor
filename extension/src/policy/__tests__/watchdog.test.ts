import { describe, it, expect, beforeEach } from 'vitest';

import { Watchdog, attachWatchdogToAudit, DEFAULT_THRESHOLDS } from '../watchdog';
import { Audit } from '../audit';
import { evaluate, setOriginGrantResolver, setWatchdogResolver, type PolicyRequest } from '../engine';
import { Policy } from '../store';
import { LabelSet } from '../labels';

beforeEach(() => {
  Audit.__reset();
  Policy.__reset();
  Watchdog.resetAll();
  Watchdog.setThresholds(DEFAULT_THRESHOLDS);
  setOriginGrantResolver(() => null);
  setWatchdogResolver(() => ({ status: 'normal' }));
});

async function decide(req: PolicyRequest) {
  const decision = await evaluate(req);
  Audit.record(req, decision);
  return decision;
}

describe('Watchdog status transitions', () => {
  it('starts in normal', () => {
    expect(Watchdog.inspect('https://a.com').status).toBe('normal');
  });

  it('flags after toolCallsToFlag tool calls in window', async () => {
    Watchdog.setThresholds({ toolCallsToFlag: 3 });
    const detach = attachWatchdogToAudit();
    for (let i = 0; i < 3; i++) {
      await decide({
        origin: 'https://a.com',
        action: 'tool.call',
        resource: { server: 's', tool: 't' },
      });
    }
    expect(Watchdog.inspect('https://a.com').status).toBe('flagged');
    detach();
  });

  it('restricts after toolCallsToRestrict tool calls in window', async () => {
    Watchdog.setThresholds({ toolCallsToFlag: 2, toolCallsToRestrict: 4 });
    const detach = attachWatchdogToAudit();
    for (let i = 0; i < 4; i++) {
      await decide({ origin: 'https://a.com', action: 'tool.call', resource: { server: 's', tool: 't' } });
    }
    expect(Watchdog.inspect('https://a.com').status).toBe('restricted');
    detach();
  });

  it('quarantines after labelFlowDeniesToQuarantine label-flow blocks', async () => {
    Watchdog.setThresholds({ labelFlowDeniesToQuarantine: 2 });
    const detach = attachWatchdogToAudit();
    for (let i = 0; i < 2; i++) {
      await decide({
        origin: 'https://a.com',
        action: 'model.prompt.remote.thirdParty',
        inputLabels: new LabelSet(['credentials']),
      });
    }
    expect(Watchdog.inspect('https://a.com').status).toBe('quarantined');
    detach();
  });

  it('quarantines after consecutiveDeniesToQuarantine consecutive denies', async () => {
    Watchdog.setThresholds({ consecutiveDeniesToQuarantine: 3 });
    const detach = attachWatchdogToAudit();
    // Force denies via managed deny rule.
    const { compileRule } = await import('../rules');
    Policy.__setForTesting([
      compileRule({
        id: 'r1',
        effect: 'deny',
        principal: { origin: '*' },
        action: 'tool.call',
        source: 'managed',
      }),
    ]);
    for (let i = 0; i < 3; i++) {
      await decide({
        origin: 'https://a.com',
        action: 'tool.call',
        resource: { server: 's', tool: 't' },
      });
    }
    expect(Watchdog.inspect('https://a.com').status).toBe('quarantined');
    detach();
  });

  it('an `allow` resets the consecutive denies counter', async () => {
    Watchdog.setThresholds({ consecutiveDeniesToQuarantine: 3 });
    const detach = attachWatchdogToAudit();
    const { compileRule } = await import('../rules');
    Policy.__setForTesting([
      compileRule({
        id: 'r1',
        effect: 'deny',
        principal: { origin: '*' },
        action: 'tool.call',
        source: 'managed',
      }),
    ]);

    // Two denies, then an allow, then more denies.
    for (let i = 0; i < 2; i++) {
      await decide({
        origin: 'https://a.com',
        action: 'tool.call',
        resource: { server: 's', tool: 't' },
      });
    }
    await decide({ origin: 'https://a.com', action: 'tool.list' });
    for (let i = 0; i < 2; i++) {
      await decide({
        origin: 'https://a.com',
        action: 'tool.call',
        resource: { server: 's', tool: 't' },
      });
    }
    expect(Watchdog.inspect('https://a.com').status).not.toBe('quarantined');
    detach();
  });

  it('restricting is a one-way ratchet within a session', async () => {
    Watchdog.setThresholds({ toolCallsToFlag: 2, toolCallsToRestrict: 3 });
    const detach = attachWatchdogToAudit();
    for (let i = 0; i < 3; i++) {
      await decide({
        origin: 'https://a.com',
        action: 'tool.call',
        resource: { server: 's', tool: 't' },
      });
    }
    expect(Watchdog.inspect('https://a.com').status).toBe('restricted');
    // A subsequent allow doesn't unrestrict.
    await decide({ origin: 'https://a.com', action: 'tool.list' });
    expect(Watchdog.inspect('https://a.com').status).toBe('restricted');
    detach();
  });
});

describe('Engine integration', () => {
  it('engine consults the watchdog at Tier 4', async () => {
    setWatchdogResolver(Watchdog.resolve);
    Watchdog.quarantine('https://a.com', 'manual quarantine');
    const decision = await evaluate({
      origin: 'https://a.com',
      action: 'tool.list',
    });
    expect(decision.effect).toBe('deny');
    expect(decision.tier).toBe(4);
    expect(decision.errorCode).toBe('ERR_QUARANTINED');
  });
});

describe('Manual reset', () => {
  it('reset() clears state for an origin', () => {
    Watchdog.quarantine('https://a.com', 'test');
    expect(Watchdog.inspect('https://a.com').status).toBe('quarantined');
    Watchdog.reset('https://a.com');
    expect(Watchdog.inspect('https://a.com').status).toBe('normal');
  });
});

describe('Sensitive-label distinct-count escalation', () => {
  it('restricts after touching distinctSensitiveLabelsToRestrict labels', async () => {
    Watchdog.setThresholds({ distinctSensitiveLabelsToRestrict: 2 });
    const detach = attachWatchdogToAudit();
    await decide({
      origin: 'https://a.com',
      action: 'browser.read.activeTab',
      resource: { host: 'mail.google.com' },
    });
    await decide({
      origin: 'https://a.com',
      action: 'browser.read.activeTab',
      resource: { host: 'accounts.google.com' },
    });
    expect(Watchdog.inspect('https://a.com').status).toBe('restricted');
    detach();
  });
});

describe('cross-origin egress', () => {
  const egress = (extra = {}) => {
    const req: PolicyRequest = { origin: 'https://a.com', action: 'network.egress.cross_origin', resource: { host: 'b.com' } };
    return evaluate(req).then((d) => Audit.record(req, d, extra));
  };

  it('restricts after crossOriginEgressToRestrict egresses in window', async () => {
    const detach = attachWatchdogToAudit();
    for (let i = 0; i < DEFAULT_THRESHOLDS.crossOriginEgressToRestrict; i++) await egress();
    expect(Watchdog.inspect('https://a.com').status).toBe('restricted');
    detach();
  });

  it("doesn't count a page's own fetch", async () => {
    const detach = attachWatchdogToAudit();
    for (let i = 0; i < DEFAULT_THRESHOLDS.crossOriginEgressToRestrict * 2; i++) await egress({ pageFetch: true });
    expect(Watchdog.inspect('https://a.com').status).toBe('normal');
    detach();
  });
});
