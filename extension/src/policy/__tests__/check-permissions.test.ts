/**
 * checkPermissions grants a scope only when the origin holds a grant for it.
 * A scope Harbor doesn't know has no grant, so it must not pass.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionScope } from '../../agents/types';

type PermissionsModule = typeof import('../permissions');
let checkPermissions: PermissionsModule['checkPermissions'];

describe('checkPermissions', () => {
  beforeEach(async () => {
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

  it('treats a known scope with no grant as missing', async () => {
    const result = await checkPermissions('https://site.example', ['model:prompt']);

    expect(result.granted).toBe(false);
    expect(result.missingScopes).toEqual(['model:prompt']);
  });
});
