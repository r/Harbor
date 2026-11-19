/**
 * `listAllPermissions` (the sidebar's permission list) must see a
 * `model:prompt`/`model:tools` allow that lives only in the per-backend
 * `allows` map (policy/backend-grant.ts) — not just the flat `grant`
 * field, which is `'not-granted'` once that map exists. Without this, a
 * site holding only a per-backend allow vanishes from the list entirely,
 * and the sidebar has no "Revoke" button to show for it (round-4 bounce,
 * repro r3-scratch-list.log).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';
import { grantPermissions, revokePermissions, listAllPermissions } from '../permissions';
import { writeAgentBackendSetting } from '../../page-api/agent-backend-setting';

const ORIGIN = 'https://example.test';

afterEach(() => {
  resetMockBrowser();
});

describe('listAllPermissions sees per-backend allows', () => {
  it('lists an origin whose only grant is a per-backend allow (not visible in the flat scope at all)', async () => {
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');

    const all = await listAllPermissions();
    const entry = all.find((p) => p.origin === ORIGIN);
    expect(entry).toBeDefined();
    // The flat scope reads 'not-granted' — the allow lives only in the
    // per-backend map.
    expect(entry!.scopes['model:prompt']).toBe('not-granted');
    expect(entry!.backendAllows?.['model:prompt']).toEqual({ 'acp:goose': 'granted-always' });
  });

  it('lists allows under every backend they were granted under, labelled by backend tag', async () => {
    await writeAgentBackendSetting(null); // builtin
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');

    const all = await listAllPermissions();
    const entry = all.find((p) => p.origin === ORIGIN)!;
    expect(entry.backendAllows?.['model:prompt']).toEqual({
      builtin: 'granted-always',
      'acp:goose': 'granted-always',
    });
  });

  it('revoking the origin removes it from the list entirely, including every backend allow', async () => {
    await writeAgentBackendSetting(null);
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');

    expect((await listAllPermissions()).some((p) => p.origin === ORIGIN)).toBe(true);

    await revokePermissions(ORIGIN);

    expect((await listAllPermissions()).some((p) => p.origin === ORIGIN)).toBe(false);
  });

  it('omits an expired granted-once backend allow', async () => {
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-once');

    // Directly age the stored allow past expiry, the way
    // is-model-prompt-granted-for-agent.test.ts's siblings do for the flat
    // case elsewhere.
    const { getMockStorage } = await import('../../__tests__/test-setup');
    const stored = (await getMockStorage().local.get('harbor_origin_permissions')).harbor_origin_permissions as Record<string, { scopes: Record<string, { allows?: Record<string, { expiresAt?: number }> }> }>;
    const allow = stored[ORIGIN].scopes['model:prompt'].allows!['acp:goose'];
    allow.expiresAt = Date.now() - 1000;
    await getMockStorage().local.set({ harbor_origin_permissions: stored });

    const all = await listAllPermissions();
    const entry = all.find((p) => p.origin === ORIGIN);
    // No live grant anywhere left for this origin, so it's gone entirely.
    expect(entry).toBeUndefined();
  });
});
