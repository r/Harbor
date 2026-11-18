/**
 * checkPermissions grants a scope only when the origin holds a grant for it.
 * A scope Harbor doesn't know has no grant, so it must not pass.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionScope } from '../../agents/types';
import { resetMockBrowser } from '../../__tests__/test-setup';

type PermissionsModule = typeof import('../permissions');
let checkPermissions: PermissionsModule['checkPermissions'];

describe('checkPermissions', () => {
  beforeEach(async () => {
    resetMockBrowser();
    vi.resetModules();
    ({ checkPermissions } = await import('../permissions'));
  });

  it('treats an unknown scope as missing, not granted', async () => {
    const unknown = 'retired:scope' as PermissionScope;

    const result = await checkPermissions('https://site.example', [unknown]);

    expect(result.granted).toBe(false);
    expect(result.missingScopes).toEqual([unknown]);
    expect(result.deniedScopes).toEqual([]);
  });

  it('passes scopes the origin was granted, once or always', async () => {
    const { grantPermissions } = await import('../permissions');
    await grantPermissions('https://site.example', ['model:prompt'], 'granted-always');
    await grantPermissions('https://site.example', ['model:list'], 'granted-once', 7);

    const result = await checkPermissions('https://site.example', ['model:prompt', 'model:list'], 7);

    expect(result).toEqual({ granted: true, missingScopes: [], deniedScopes: [] });
  });

  it('reports a denied scope as denied, not missing', async () => {
    const { denyPermissions } = await import('../permissions');
    await denyPermissions('https://site.example', ['model:prompt']);

    const result = await checkPermissions('https://site.example', ['model:prompt']);

    expect(result).toEqual({ granted: false, missingScopes: [], deniedScopes: ['model:prompt'] });
  });

  it('treats a known scope with no grant as missing', async () => {
    const result = await checkPermissions('https://site.example', ['model:prompt']);

    expect(result.granted).toBe(false);
    expect(result.missingScopes).toEqual(['model:prompt']);
  });
});
