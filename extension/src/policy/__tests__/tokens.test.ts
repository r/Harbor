import { describe, it, expect, beforeEach } from 'vitest';

import { Tokens, TokenError } from '../tokens';

describe('Tokens.mint', () => {
  beforeEach(() => Tokens.__reset());

  it('produces a token bound to the requested origin and session', () => {
    const t = Tokens.mint({
      sessionId: 'sess1',
      origin: 'https://example.com',
      allowedActions: ['model.prompt.local', 'browser.read.activeTab'],
      acceptedLabels: ['confidential'],
    });
    expect(t.sessionId).toBe('sess1');
    expect(t.origin).toBe('https://example.com');
    expect(t.attenuationDepth).toBe(0);
    expect(t.parentId).toBeUndefined();
    expect(t.allowedActions.has('model.prompt.local')).toBe(true);
    expect(t.acceptedLabels.has('confidential')).toBe(true);
    expect(t.id).toMatch(/^tok_/);
    expect(t.revoked).toBe(false);
  });

  it('drops unknown actions and labels silently', () => {
    const t = Tokens.mint({
      sessionId: 's',
      origin: 'https://example.com',
      // Cast through unknown to bypass the literal-type check for test purposes.
      allowedActions: ['fake.action' as unknown as 'tool.call', 'model.prompt.local'],
      acceptedLabels: ['ghosts' as unknown as 'confidential', 'confidential'],
    });
    expect(t.allowedActions.has('model.prompt.local')).toBe(true);
    expect(t.allowedActions.has('fake.action' as 'tool.call')).toBe(false);
    expect(t.acceptedLabels.has('confidential')).toBe(true);
  });

  it('uses the default 30-minute TTL when none is given', () => {
    const before = Date.now();
    const t = Tokens.mint({
      sessionId: 's',
      origin: 'https://example.com',
      allowedActions: [],
      acceptedLabels: [],
    });
    const after = Date.now();
    expect(t.expiresAt).toBeGreaterThanOrEqual(before + 30 * 60 * 1000 - 100);
    expect(t.expiresAt).toBeLessThanOrEqual(after + 30 * 60 * 1000 + 100);
  });

  it('honors Infinity as a no-expiration TTL', () => {
    const t = Tokens.mint({
      sessionId: 's',
      origin: 'https://example.com',
      allowedActions: [],
      acceptedLabels: [],
      ttlMs: Infinity,
    });
    expect(t.expiresAt).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('Tokens.validate', () => {
  beforeEach(() => Tokens.__reset());

  it('returns the token on a successful match', () => {
    const t = Tokens.mint({
      sessionId: 's',
      origin: 'https://example.com',
      allowedActions: ['tool.list'],
      acceptedLabels: [],
    });
    const validated = Tokens.validate(t.id, 'https://example.com', 'tool.list');
    expect(validated.id).toBe(t.id);
  });

  it('rejects a token used at the wrong origin', () => {
    const t = Tokens.mint({
      sessionId: 's',
      origin: 'https://example.com',
      allowedActions: ['tool.list'],
      acceptedLabels: [],
    });
    expect(() => Tokens.validate(t.id, 'https://other.com', 'tool.list')).toThrow(TokenError);
  });

  it('rejects a token for an action it does not authorize', () => {
    const t = Tokens.mint({
      sessionId: 's',
      origin: 'https://example.com',
      allowedActions: ['tool.list'],
      acceptedLabels: [],
    });
    expect(() => Tokens.validate(t.id, 'https://example.com', 'tool.call')).toThrow(TokenError);
  });

  it('rejects a revoked token', () => {
    const t = Tokens.mint({
      sessionId: 's',
      origin: 'https://example.com',
      allowedActions: ['tool.list'],
      acceptedLabels: [],
    });
    Tokens.revoke(t.id);
    expect(() => Tokens.validate(t.id, 'https://example.com', 'tool.list')).toThrow(/ERR_TOKEN_REVOKED|revoked/);
  });

  it('rejects an unknown token id', () => {
    expect(() => Tokens.validate('tok_nope', 'https://example.com', 'tool.list')).toThrow(/ERR_TOKEN_NOT_FOUND/);
  });
});

describe('Tokens.attenuate', () => {
  beforeEach(() => Tokens.__reset());

  function parent() {
    return Tokens.mint({
      sessionId: 'parent',
      origin: 'https://example.com',
      allowedActions: ['tool.list', 'tool.call', 'browser.read.activeTab'],
      acceptedLabels: ['confidential'],
      budgets: { toolCalls: 10, navigations: 5, wallClockMs: 60_000 },
    });
  }

  it('produces a child with attenuationDepth+1 and the parentId set', () => {
    const p = parent();
    const c = Tokens.attenuate(p.id, {
      sessionId: 'child',
      allowedActions: ['tool.list'],
    });
    expect(c.parentId).toBe(p.id);
    expect(c.attenuationDepth).toBe(1);
    expect(c.allowedActions.has('tool.list')).toBe(true);
    expect(c.allowedActions.has('tool.call')).toBe(false);
  });

  it('refuses to widen actions', () => {
    const p = Tokens.mint({
      sessionId: 's',
      origin: 'https://example.com',
      allowedActions: ['tool.list'],
      acceptedLabels: [],
    });
    expect(() =>
      Tokens.attenuate(p.id, {
        sessionId: 'child',
        allowedActions: ['tool.list', 'tool.call'],
      }),
    ).toThrow(/ERR_ATTENUATION_NOT_SUBSET/);
  });

  it('refuses to widen labels', () => {
    const p = parent();
    expect(() =>
      Tokens.attenuate(p.id, {
        sessionId: 'child',
        acceptedLabels: ['confidential', 'credentials'],
      }),
    ).toThrow(/ERR_ATTENUATION_NOT_SUBSET/);
  });

  it('intersects budgets to the lower of parent and child', () => {
    const p = parent();
    const c = Tokens.attenuate(p.id, {
      sessionId: 'child',
      budgets: { toolCalls: 100, navigations: 1 },
    });
    expect(c.budgets.toolCalls).toBe(10);
    expect(c.budgets.navigations).toBe(1);
    expect(c.budgets.wallClockMs).toBe(60_000);
  });

  it('caps TTL at parent remaining', () => {
    const p = Tokens.mint({
      sessionId: 's',
      origin: 'https://example.com',
      allowedActions: ['tool.list'],
      acceptedLabels: [],
      ttlMs: 1_000,
    });
    const c = Tokens.attenuate(p.id, {
      sessionId: 'child',
      ttlMs: 1_000_000,
    });
    expect(c.expiresAt - c.issuedAt).toBeLessThanOrEqual(1_000 + 50);
  });

  it('inherits unspecified fields from the parent', () => {
    const p = parent();
    const c = Tokens.attenuate(p.id, { sessionId: 'child' });
    expect([...c.allowedActions].sort()).toEqual([...p.allowedActions].sort());
    expect([...c.acceptedLabels].sort()).toEqual([...p.acceptedLabels].sort());
  });
});

describe('Tokens.revoke', () => {
  beforeEach(() => Tokens.__reset());

  it('revokes a single token', () => {
    const t = Tokens.mint({
      sessionId: 's',
      origin: 'https://example.com',
      allowedActions: [],
      acceptedLabels: [],
    });
    expect(Tokens.revoke(t.id)).toBe(true);
    const got = Tokens.get(t.id);
    expect(got?.revoked).toBe(true);
  });

  it('revokeWithDescendants takes out the whole chain', () => {
    const root = Tokens.mint({
      sessionId: 'r',
      origin: 'https://example.com',
      allowedActions: ['tool.list'],
      acceptedLabels: [],
    });
    const c1 = Tokens.attenuate(root.id, { sessionId: 'c1' });
    const c2 = Tokens.attenuate(c1.id, { sessionId: 'c2' });
    const removed = Tokens.revokeWithDescendants(root.id);
    expect(removed).toBe(3);
    expect(Tokens.get(root.id)?.revoked).toBe(true);
    expect(Tokens.get(c1.id)?.revoked).toBe(true);
    expect(Tokens.get(c2.id)?.revoked).toBe(true);
  });
});

describe('Tokens.cleanup', () => {
  beforeEach(() => Tokens.__reset());

  it('removes expired tokens', () => {
    const t = Tokens.mint({
      sessionId: 's',
      origin: 'https://example.com',
      allowedActions: [],
      acceptedLabels: [],
      ttlMs: 1,
    });
    expect(Tokens.size()).toBe(1);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const removed = Tokens.cleanup();
        expect(removed).toBe(1);
        expect(Tokens.get(t.id)).toBeUndefined();
        resolve();
      }, 10);
    });
  });

  it('removes revoked tokens', () => {
    const t = Tokens.mint({
      sessionId: 's',
      origin: 'https://example.com',
      allowedActions: [],
      acceptedLabels: [],
    });
    Tokens.revoke(t.id);
    Tokens.cleanup();
    expect(Tokens.get(t.id)).toBeUndefined();
  });
});

describe('Tokens.toView', () => {
  beforeEach(() => Tokens.__reset());

  it('returns a serializable, sorted view', () => {
    const t = Tokens.mint({
      sessionId: 's',
      origin: 'https://example.com',
      allowedActions: ['tool.list', 'browser.read.activeTab'],
      acceptedLabels: ['confidential'],
    });
    const view = Tokens.toView(t);
    expect(view.allowedActions).toEqual(['browser.read.activeTab', 'tool.list']);
    expect(view.acceptedLabels).toEqual(['confidential']);
    // Round-trips through JSON.
    const json = JSON.stringify(view);
    expect(JSON.parse(json).id).toBe(t.id);
  });
});
