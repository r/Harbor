import { afterEach, describe, expect, it } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';
import { writeAgentBackendSetting } from '../../page-api/agent-backend-setting';
import {
  backendTagForSetting,
  currentBackendTag,
  effectiveGrantForBackend,
  grantMatchesBackend,
  isBackendScopedScope,
  withBackendAllow,
  withUniversalDeny,
} from '../backend-grant';

afterEach(() => {
  resetMockBrowser();
});

describe('backendTagForSetting', () => {
  it('is "builtin" for no setting', () => {
    expect(backendTagForSetting(null)).toBe('builtin');
  });

  it('is "acp:<agentId>" for an ACP setting', () => {
    expect(backendTagForSetting({ type: 'acp', agentId: 'goose' })).toBe('acp:goose');
  });
});

describe('currentBackendTag', () => {
  it('reads the stored harbor_agent_backend setting', async () => {
    await expect(currentBackendTag()).resolves.toBe('builtin');
    await writeAgentBackendSetting({ type: 'acp', agentId: 'codex' });
    await expect(currentBackendTag()).resolves.toBe('acp:codex');
  });
});

describe('isBackendScopedScope', () => {
  it('is true only for model:prompt and model:tools', () => {
    expect(isBackendScopedScope('model:prompt')).toBe(true);
    expect(isBackendScopedScope('model:tools')).toBe(true);
    expect(isBackendScopedScope('mcp:tools.call')).toBe(false);
    expect(isBackendScopedScope('browser:activeTab.read')).toBe(false);
  });
});

describe('grantMatchesBackend', () => {
  it('always matches for a scope this does not apply to', () => {
    expect(grantMatchesBackend('mcp:tools.call', 'acp:goose', 'builtin')).toBe(true);
    expect(grantMatchesBackend('mcp:tools.call', undefined, 'builtin')).toBe(true);
  });

  it('matches when the stored backend equals the current one', () => {
    expect(grantMatchesBackend('model:prompt', 'acp:goose', 'acp:goose')).toBe(true);
    expect(grantMatchesBackend('model:tools', 'builtin', 'builtin')).toBe(true);
  });

  it('does not match when they differ', () => {
    expect(grantMatchesBackend('model:prompt', 'acp:goose', 'acp:codex')).toBe(false);
    expect(grantMatchesBackend('model:prompt', 'builtin', 'acp:goose')).toBe(false);
  });

  it('treats a missing stored backend (a grant made before this existed) as "builtin"', () => {
    expect(grantMatchesBackend('model:prompt', undefined, 'builtin')).toBe(true);
    expect(grantMatchesBackend('model:prompt', undefined, 'acp:goose')).toBe(false);
  });
});

// Maintainer decision, 2026-11-19: a deny for model:prompt/model:tools
// applies under every backend; only allows are per-backend, stored one per
// backend so granting under a second backend never overwrites the first.
describe('withBackendAllow / withUniversalDeny / effectiveGrantForBackend', () => {
  const now = 1_000_000;

  it('a fresh allow for a backend-scoped scope is stored under that backend, not as a flat grant', () => {
    const stored = withBackendAllow(undefined, 'model:prompt', 'builtin', 'granted-always', now);
    expect(stored.grant).toBe('not-granted'); // the flat field no longer carries the allow
    expect(stored.allows).toEqual({ builtin: { grant: 'granted-always', grantedAt: now } });
  });

  it('granting under a second backend keeps the first backend\'s allow', () => {
    const afterBuiltin = withBackendAllow(undefined, 'model:prompt', 'builtin', 'granted-always', now);
    const afterGoose = withBackendAllow(afterBuiltin, 'model:prompt', 'acp:goose', 'granted-always', now + 1);
    expect(afterGoose.allows).toEqual({
      builtin: { grant: 'granted-always', grantedAt: now },
      'acp:goose': { grant: 'granted-always', grantedAt: now + 1 },
    });
  });

  it('effectiveGrantForBackend reads back each backend\'s own allow', () => {
    const stored = withBackendAllow(
      withBackendAllow(undefined, 'model:prompt', 'builtin', 'granted-always', now),
      'model:prompt', 'acp:goose', 'granted-once', now + 1, { expiresAt: now + 60_000 },
    );
    expect(effectiveGrantForBackend(stored, 'model:prompt', 'builtin', now + 2)).toBe('granted-always');
    expect(effectiveGrantForBackend(stored, 'model:prompt', 'acp:goose', now + 2)).toBe('granted-once');
    expect(effectiveGrantForBackend(stored, 'model:prompt', 'acp:codex', now + 2)).toBe('not-granted');
  });

  it('a non-backend-scoped scope is unaffected: one flat allow, no backend', () => {
    const stored = withBackendAllow(undefined, 'mcp:tools.list', 'acp:goose', 'granted-always', now);
    expect(stored).toEqual({ grant: 'granted-always', grantedAt: now, expiresAt: undefined, tabId: undefined });
  });

  it('withUniversalDeny produces a plain deny, with no backend and no allows', () => {
    expect(withUniversalDeny(now)).toEqual({ grant: 'denied', grantedAt: now });
  });

  it('effectiveGrantForBackend reports a universal deny under every backend, even one that never had an allow', () => {
    const stored = withUniversalDeny(now);
    expect(effectiveGrantForBackend(stored, 'model:prompt', 'builtin', now)).toBe('denied');
    expect(effectiveGrantForBackend(stored, 'model:prompt', 'acp:goose', now)).toBe('denied');
  });

  it('a deny overrides allows recorded for other backends, read back under any of them', () => {
    const allowed = withBackendAllow(
      withBackendAllow(undefined, 'model:prompt', 'builtin', 'granted-always', now),
      'model:prompt', 'acp:goose', 'granted-always', now + 1,
    );
    const denied = withUniversalDeny(now + 2);
    expect(effectiveGrantForBackend(denied, 'model:prompt', 'builtin', now + 3)).toBe('denied');
    expect(effectiveGrantForBackend(denied, 'model:prompt', 'acp:goose', now + 3)).toBe('denied');
    expect(effectiveGrantForBackend(denied, 'model:prompt', 'acp:codex', now + 3)).toBe('denied');
    // (contrast: before the deny, codex — which never had an allow — was not-granted, not denied)
    expect(effectiveGrantForBackend(allowed, 'model:prompt', 'acp:codex', now + 3)).toBe('not-granted');
  });

  it('a legacy (round-2) flat allow with no allows map is still read correctly for the backend it names', () => {
    const legacy = { grant: 'granted-always' as const, grantedAt: now, backend: 'acp:goose' };
    expect(effectiveGrantForBackend(legacy, 'model:prompt', 'acp:goose', now)).toBe('granted-always');
    expect(effectiveGrantForBackend(legacy, 'model:prompt', 'builtin', now)).toBe('not-granted');
  });

  it('a legacy flat allow with no backend field at all counts as builtin', () => {
    const legacy = { grant: 'granted-always' as const, grantedAt: now };
    expect(effectiveGrantForBackend(legacy, 'model:prompt', 'builtin', now)).toBe('granted-always');
    expect(effectiveGrantForBackend(legacy, 'model:prompt', 'acp:goose', now)).toBe('not-granted');
  });

  it('the first write into the allows map migrates a still-live legacy flat allow, so switching back to it still restores it', () => {
    // A round-2, pre-map grant made under the built-in model.
    const legacy = { grant: 'granted-always' as const, grantedAt: now };

    // The very first per-backend write — granting under a *different*
    // backend (goose) for the first time. Before this item's fix, this
    // would reset the flat field to 'not-granted' with nothing carried
    // over, silently losing the legacy builtin allow.
    const afterGoose = withBackendAllow(legacy, 'model:prompt', 'acp:goose', 'granted-always', now + 1);

    expect(afterGoose.allows).toEqual({
      builtin: { grant: 'granted-always', grantedAt: now, expiresAt: undefined, tabId: undefined },
      'acp:goose': { grant: 'granted-always', grantedAt: now + 1 },
    });
    expect(effectiveGrantForBackend(afterGoose, 'model:prompt', 'builtin', now + 2)).toBe('granted-always');
    expect(effectiveGrantForBackend(afterGoose, 'model:prompt', 'acp:goose', now + 2)).toBe('granted-always');
  });

  it('migrates a legacy flat allow under the specific backend it names, not always "builtin"', () => {
    const legacy = { grant: 'granted-always' as const, grantedAt: now, backend: 'acp:claude-code' };
    const afterGoose = withBackendAllow(legacy, 'model:prompt', 'acp:goose', 'granted-always', now + 1);
    expect(afterGoose.allows).toEqual({
      'acp:claude-code': { grant: 'granted-always', grantedAt: now, expiresAt: undefined, tabId: undefined },
      'acp:goose': { grant: 'granted-always', grantedAt: now + 1 },
    });
  });

  it('does not migrate an expired legacy granted-once allow — nothing live to carry over', () => {
    const legacy = { grant: 'granted-once' as const, grantedAt: now, expiresAt: now + 10 };
    const afterGoose = withBackendAllow(legacy, 'model:prompt', 'acp:goose', 'granted-always', now + 100);
    expect(afterGoose.allows).toEqual({ 'acp:goose': { grant: 'granted-always', grantedAt: now + 100 } });
  });

  it('does not migrate a flat deny — a deny is already universal, nothing backend-specific to carry', () => {
    const denied = withUniversalDeny(now);
    const afterGoose = withBackendAllow(denied, 'model:prompt', 'acp:goose', 'granted-always', now + 1);
    expect(afterGoose.allows).toEqual({ 'acp:goose': { grant: 'granted-always', grantedAt: now + 1 } });
  });

  it('respects expiry and tab scoping within one backend\'s own allow entry', () => {
    const stored = withBackendAllow(undefined, 'model:prompt', 'builtin', 'granted-once', now, { expiresAt: now + 10, tabId: 9 });
    expect(effectiveGrantForBackend(stored, 'model:prompt', 'builtin', now + 5, 9)).toBe('granted-once');
    expect(effectiveGrantForBackend(stored, 'model:prompt', 'builtin', now + 20, 9)).toBe('not-granted'); // expired
    expect(effectiveGrantForBackend(stored, 'model:prompt', 'builtin', now + 5, 10)).toBe('not-granted'); // different tab
  });
});
