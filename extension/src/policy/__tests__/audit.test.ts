import { describe, it, expect, beforeEach } from 'vitest';

import { Audit } from '../audit';
import { evaluate, setOriginGrantResolver, setWatchdogResolver, type PolicyRequest } from '../engine';
import { Policy } from '../store';
import { LabelSet } from '../labels';

beforeEach(() => {
  Audit.__reset();
  Policy.__reset();
  setOriginGrantResolver(() => null);
  setWatchdogResolver(() => ({ status: 'normal' }));
});

async function record(req: PolicyRequest) {
  const decision = await evaluate(req);
  return Audit.record(req, decision);
}

describe('Audit.record', () => {
  it('captures origin, action, effect, source, tier, and trace', async () => {
    const r = await record({
      origin: 'https://example.com',
      action: 'tool.list',
    });
    expect(r.origin).toBe('https://example.com');
    expect(r.action).toBe('tool.list');
    expect(r.effect).toBe('allow');
    expect(r.tier).toBe(9);
    expect(r.source).toBe('default');
    expect(r.trace.length).toBeGreaterThan(0);
  });

  it('records labelsIn and labelsOut', async () => {
    const r = await record({
      origin: 'https://example.com',
      action: 'browser.read.activeTab',
      resource: { host: 'mail.google.com' },
      inputLabels: new LabelSet([]),
    });
    // The active-tab read attaches "confidential" via defaultDataLabels and
    // the gmail domain classifier — both should appear in labelsOut.
    expect(r.labelsOut).toContain('confidential');
  });

  it('captures error code on a denial', async () => {
    const r = await record({
      origin: 'https://example.com',
      action: 'model.prompt.remote.thirdParty',
      inputLabels: new LabelSet(['credentials']),
    });
    expect(r.errorCode).toBe('ERR_LABEL_FLOW_BLOCKED');
  });

  it('assigns a unique id to each record', async () => {
    const a = await record({ origin: 'https://example.com', action: 'tool.list' });
    const b = await record({ origin: 'https://example.com', action: 'tool.list' });
    expect(a.id).not.toBe(b.id);
  });
});

describe('Audit.query', () => {
  it('filters by origin', async () => {
    await record({ origin: 'https://a.com', action: 'tool.list' });
    await record({ origin: 'https://b.com', action: 'tool.list' });
    const r = Audit.query({ origin: 'https://a.com' });
    expect(r.length).toBe(1);
    expect(r[0].origin).toBe('https://a.com');
  });

  it('filters by effect', async () => {
    await record({ origin: 'https://a.com', action: 'tool.list' });
    await record({
      origin: 'https://a.com',
      action: 'model.prompt.remote.thirdParty',
      inputLabels: new LabelSet(['credentials']),
    });
    const denies = Audit.query({ effect: 'deny' });
    expect(denies.length).toBe(1);
    expect(denies[0].action).toBe('model.prompt.remote.thirdParty');
  });

  it('filters by label', async () => {
    await record({
      origin: 'https://a.com',
      action: 'browser.read.activeTab',
      resource: { host: 'mail.google.com' },
    });
    const r = Audit.query({ label: 'confidential' });
    expect(r.length).toBeGreaterThan(0);
  });

  it('limits results to N most recent', async () => {
    for (let i = 0; i < 10; i++) {
      await record({ origin: 'https://a.com', action: 'tool.list' });
    }
    const r = Audit.query({ limit: 3 });
    expect(r.length).toBe(3);
  });

  it('respects sinceMs window', async () => {
    await record({ origin: 'https://a.com', action: 'tool.list' });
    const r = Audit.query({ sinceMs: 60_000 });
    expect(r.length).toBe(1);
    const old = Audit.query({ sinceMs: -1 });
    expect(old.length).toBe(0);
  });
});

describe('Audit.summarize', () => {
  it('counts decisions by effect and source', async () => {
    await record({ origin: 'https://a.com', action: 'tool.list' });
    await record({ origin: 'https://a.com', action: 'tool.list' });
    await record({
      origin: 'https://a.com',
      action: 'model.prompt.remote.thirdParty',
      inputLabels: new LabelSet(['credentials']),
    });
    const s = Audit.summarize();
    expect(s.totalDecisions).toBe(3);
    expect(s.byEffect.allow).toBe(2);
    expect(s.byEffect.deny).toBe(1);
    expect(s.labelEgressDenials).toBe(1);
  });

  it('counts quarantines from the engine\'s ERR_QUARANTINED', async () => {
    setWatchdogResolver(() => ({ status: 'quarantined', reason: 'test' }));
    await record({ origin: 'https://a.com', action: 'tool.list' });
    const s = Audit.summarize();
    expect(s.quarantines).toBe(1);
  });
});

describe('Capacity', () => {
  it('rolls oldest entries off when full', async () => {
    Audit.setCapacity(3);
    for (let i = 0; i < 5; i++) {
      await record({ origin: `https://${i}.com`, action: 'tool.list' });
    }
    const all = Audit.list();
    expect(all.length).toBe(3);
    expect(all[0].origin).toBe('https://2.com');
    expect(all[2].origin).toBe('https://4.com');
  });
});

describe('Subscriptions', () => {
  it('fires listeners on each new record', async () => {
    let count = 0;
    Audit.subscribe(() => count++);
    await record({ origin: 'https://a.com', action: 'tool.list' });
    await record({ origin: 'https://a.com', action: 'tool.list' });
    expect(count).toBe(2);
  });
});
