import { describe, it, expect, beforeEach } from 'vitest';

import { simulate, replay, recordCurrentResolvers } from '../simulator';
import { Policy } from '../store';
import { Audit } from '../audit';
import { evaluate, setOriginGrantResolver, setWatchdogResolver } from '../engine';

beforeEach(() => {
  Policy.__reset();
  Audit.__reset();
  setOriginGrantResolver(() => null);
  setWatchdogResolver(() => ({ status: 'normal' }));
  recordCurrentResolvers(
    () => null,
    () => ({ status: 'normal' }),
  );
});

describe('simulate', () => {
  it('runs a hypothetical request through the engine without side effects', async () => {
    const result = await simulate({
      origin: 'https://example.com',
      action: 'tool.list',
    });
    expect(result.decision.effect).toBe('allow');
    expect(result.decision.tier).toBe(9);
    // The simulator must not have written to the audit log.
    expect(Audit.list().length).toBe(0);
  });

  it('honors a rulesOverride argument', async () => {
    const result = await simulate({
      origin: 'https://example.com',
      action: 'tool.call',
      resource: { server: 'github', tool: 'create_pr' },
      rulesOverride: [
        {
          id: 'block-prs',
          effect: 'deny',
          principal: { origin: '*' },
          action: 'tool.call',
          resource: { server: 'github', tool: 'create_pr' },
          source: 'user',
        },
      ],
    });
    expect(result.decision.effect).toBe('deny');
    expect(result.decision.rule?.id).toBe('block-prs');
  });

  it('honors an inputLabels override', async () => {
    const result = await simulate({
      origin: 'https://example.com',
      action: 'model.prompt.remote.thirdParty',
      inputLabels: ['credentials'],
    });
    expect(result.decision.effect).toBe('deny');
    expect(result.decision.errorCode).toBe('ERR_LABEL_FLOW_BLOCKED');
  });

  it('honors a watchdogOverride', async () => {
    const result = await simulate({
      origin: 'https://example.com',
      action: 'tool.list',
      watchdogOverride: () => ({ status: 'quarantined', reason: 'test' }),
    });
    expect(result.decision.effect).toBe('deny');
    expect(result.decision.tier).toBe(4);
  });

  it('honors an originGrantOverride', async () => {
    const result = await simulate({
      origin: 'https://example.com',
      action: 'browser.read.activeTab',
      resource: { host: 'example.com' },
      originGrantOverride: () => ({ effect: 'allow', persistence: 'always' }),
    });
    expect(result.decision.effect).toBe('allow');
    expect(result.decision.source).toBe('originGrant');
  });

  it('throws when origin or action is missing', async () => {
    await expect(simulate({ action: 'tool.list' })).rejects.toThrow(/origin/);
    await expect(simulate({ origin: 'https://x' })).rejects.toThrow(/action/);
  });
});

describe('replay', () => {
  async function recordOne() {
    const req = {
      origin: 'https://example.com',
      action: 'tool.list' as const,
    };
    const d = await evaluate(req);
    return Audit.record(req, d);
  }

  it('replays an audit record and returns the matching decision', async () => {
    const r = await recordOne();
    const result = await replay(r.id);
    expect(result.decision.effect).toBe(r.effect);
    expect(result.decision.tier).toBe(r.tier);
  });

  it('reports the diff when modifications change the outcome', async () => {
    const r = await recordOne();
    const result = await replay(r.id, {
      rulesOverride: [
        {
          id: 'block-list',
          effect: 'deny',
          principal: { origin: '*' },
          action: 'tool.list',
          source: 'user',
        },
      ],
    });
    expect(result.decision.effect).toBe('deny');
    expect(result.diff?.effectChanged).toEqual({ from: 'allow', to: 'deny' });
    expect(result.diff?.tierChanged).toBeDefined();
  });

  it('throws when the record does not exist', async () => {
    await expect(replay('aud_doesnotexist')).rejects.toThrow(/no audit record/);
  });
});

describe('replay of a call whose host was not classified', () => {
  it('leaves the host unclassified, as the live decision did', async () => {
    // A page's browser call records its host without classifying it, so a
    // sensitive host (a bank) doesn't label the call or refuse it.
    const req = {
      origin: 'https://page.example',
      action: 'network.egress.cross_origin' as const,
      resource: { host: 'chase.com' },
      classifyHost: false,
    };
    const live = await evaluate(req);
    const record = Audit.record(req, live, { pageFetch: true });
    const result = await replay(record.id);
    expect(result.decision.effect).toBe(live.effect);
    expect(result.decision.outputLabels.toArray()).toEqual(live.outputLabels.toArray());
    expect(result.diff?.effectChanged).toBeUndefined();
    expect(result.diff?.labelsAdded).toEqual([]);
  });
});
