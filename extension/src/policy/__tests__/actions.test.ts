import { describe, it, expect } from 'vitest';

import {
  TYPED_ACTIONS,
  type TypedAction,
  type ActionEffect,
  getActionMeta,
  isTypedAction,
  listTypedActions,
  actionsByEffect,
  isOnDeviceLocality,
  effectCanEgress,
} from '../actions';

describe('Typed action registry', () => {
  it('has at least one action per effect tier we expect to enforce', () => {
    const seen = new Set<ActionEffect>();
    for (const action of listTypedActions()) {
      seen.add(TYPED_ACTIONS[action].effect);
    }
    // Every tier the engine reasons about should have a representative action.
    for (const tier of ['metadata', 'read', 'egress', 'write'] as const) {
      expect(seen.has(tier)).toBe(true);
    }
  });

  it('includes the locality split for model.prompt', () => {
    expect(isTypedAction('model.prompt.local')).toBe(true);
    expect(isTypedAction('model.prompt.remote.firstParty')).toBe(true);
    expect(isTypedAction('model.prompt.remote.thirdParty')).toBe(true);
  });

  it('local prompts stay local; remote prompts egress', () => {
    expect(TYPED_ACTIONS['model.prompt.local'].effect).toBe('read');
    expect(TYPED_ACTIONS['model.prompt.local'].locality).toBe('local');
    expect(TYPED_ACTIONS['model.prompt.remote.firstParty'].effect).toBe('egress');
    expect(TYPED_ACTIONS['model.prompt.remote.thirdParty'].effect).toBe('egress');
  });

  it('local prompts accept every label; third-party remote prompts accept none', () => {
    const local = TYPED_ACTIONS['model.prompt.local'];
    expect(local.acceptsLabels).toContain('credentials');
    expect(local.acceptsLabels).toContain('confidential');

    const thirdParty = TYPED_ACTIONS['model.prompt.remote.thirdParty'];
    expect(thirdParty.acceptsLabels).toEqual([]);
  });

  it('cross-origin egress accepts no labels by default', () => {
    expect(TYPED_ACTIONS['network.egress.cross_origin'].acceptsLabels).toEqual([]);
    expect(TYPED_ACTIONS['network.egress.cross_origin'].effect).toBe('egress');
  });

  it('reads of the active tab default to attaching the confidential label', () => {
    expect(TYPED_ACTIONS['browser.read.activeTab'].defaultDataLabels).toContain('confidential');
  });

  it('reversibility is null for actions with no side effect', () => {
    for (const action of listTypedActions()) {
      const meta = getActionMeta(action)!;
      if (meta.effect === 'metadata' || meta.effect === 'read') {
        expect(meta.reversible).toBeNull();
      }
    }
  });

  it('write/destructive actions declare reversibility explicitly (not null)', () => {
    for (const action of listTypedActions()) {
      const meta = getActionMeta(action)!;
      if (meta.effect === 'write' || meta.effect === 'destructive' || meta.effect === 'identity') {
        expect(meta.reversible).not.toBeNull();
      }
    }
  });

  it('every action declares a defaultTTL', () => {
    for (const action of listTypedActions()) {
      const meta = getActionMeta(action)!;
      expect(meta.defaultTTL).toBeDefined();
    }
  });

  it('reads of personal context default to session TTL, not "until_user_revokes"', () => {
    // The doc explicitly calls out: reads no longer default to persistent grants.
    const reads: TypedAction[] = [
      'browser.read.activeTab',
      'browser.read.element',
      'browser.read.screenshot',
      'browser.read.tabs',
    ];
    for (const action of reads) {
      const ttl = TYPED_ACTIONS[action].defaultTTL;
      expect(ttl).not.toBe('until_user_revokes');
    }
  });
});

describe('Helpers', () => {
  it('isTypedAction recognizes valid actions and rejects invalid ones', () => {
    expect(isTypedAction('model.prompt.local')).toBe(true);
    expect(isTypedAction('not.a.real.action')).toBe(false);
    // The legacy colon form is intentionally not a typed action.
    expect(isTypedAction('model:prompt')).toBe(false);
  });

  it('getActionMeta returns metadata for known actions and undefined otherwise', () => {
    expect(getActionMeta('tool.list')?.effect).toBe('metadata');
    expect(getActionMeta('not.an.action')).toBeUndefined();
  });

  it('actionsByEffect partitions the registry', () => {
    const reads = actionsByEffect('read');
    const writes = actionsByEffect('write');
    expect(reads.length).toBeGreaterThan(0);
    expect(writes.length).toBeGreaterThan(0);
    expect(reads.every((a) => TYPED_ACTIONS[a].effect === 'read')).toBe(true);
    expect(writes.every((a) => TYPED_ACTIONS[a].effect === 'write')).toBe(true);
  });

  it('isOnDeviceLocality is true exactly for local and same_origin', () => {
    expect(isOnDeviceLocality('local')).toBe(true);
    expect(isOnDeviceLocality('same_origin')).toBe(true);
    expect(isOnDeviceLocality('cross_origin')).toBe(false);
    expect(isOnDeviceLocality('network_first_party')).toBe(false);
    expect(isOnDeviceLocality('network_third_party')).toBe(false);
  });

  it('effectCanEgress flags the tiers that can leave the device', () => {
    expect(effectCanEgress('metadata')).toBe(false);
    expect(effectCanEgress('read')).toBe(false);
    expect(effectCanEgress('write')).toBe(false);
    expect(effectCanEgress('egress')).toBe(true);
    expect(effectCanEgress('destructive')).toBe(true);
    expect(effectCanEgress('identity')).toBe(true);
  });
});
