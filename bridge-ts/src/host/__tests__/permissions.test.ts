/**
 * Permission System Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  grantPermission,
  revokePermission,
  checkPermission,
  isToolAllowed,
  getPermissions,
  expireTabGrants,
  clearTransientPermissions,
} from '../permissions.js';
import { GrantType, PermissionScope } from '../types.js';

describe('Permission System', () => {
  const TEST_ORIGIN = 'https://example.com';
  const TEST_PROFILE = 'test-profile';

  beforeEach(() => {
    // Clear all permissions before each test
    clearTransientPermissions();
  });

  describe('grantPermission', () => {
    it('should grant ALLOW_ONCE permission', async () => {
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST, GrantType.ALLOW_ONCE);

      const result = checkPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST);
      expect(result.granted).toBe(true);
      expect(result.grant?.grantType).toBe(GrantType.ALLOW_ONCE);
    });

    it('should grant ALLOW_ALWAYS permission', async () => {
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL, GrantType.ALLOW_ALWAYS);

      const result = checkPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL);
      expect(result.granted).toBe(true);
      expect(result.grant?.grantType).toBe(GrantType.ALLOW_ALWAYS);
    });

    it('should grant DENY permission', async () => {
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL, GrantType.DENY);

      const result = checkPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL);
      expect(result.granted).toBe(false);
      expect(result.error?.code).toBe('ERR_PERMISSION_DENIED');
    });

    it('should grant permission with tool allowlist', async () => {
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL, GrantType.ALLOW_ALWAYS, {
        allowedTools: ['server1/tool1', 'server1/tool2'],
      });

      const result = checkPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL);
      expect(result.granted).toBe(true);
      expect(result.grant?.allowedTools).toEqual(['server1/tool1', 'server1/tool2']);
    });
  });

  describe('checkPermission', () => {
    it('should return error for missing permission', () => {
      const result = checkPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST);
      expect(result.granted).toBe(false);
      expect(result.error?.code).toBe('ERR_SCOPE_REQUIRED');
    });

    it('should expire ALLOW_ONCE after TTL', async () => {
      const shortTtl = 50; // 50ms
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST, GrantType.ALLOW_ONCE, {
        expiresAt: Date.now() + shortTtl,
      });

      // Should be granted immediately
      let result = checkPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST);
      expect(result.granted).toBe(true);

      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, shortTtl + 10));

      // Should be expired now
      result = checkPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST);
      expect(result.granted).toBe(false);
      expect(result.error?.code).toBe('ERR_SCOPE_REQUIRED');
    });
  });

  describe('revokePermission', () => {
    it('should revoke an existing permission', async () => {
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST, GrantType.ALLOW_ALWAYS);

      let result = checkPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST);
      expect(result.granted).toBe(true);

      await revokePermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST);

      result = checkPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST);
      expect(result.granted).toBe(false);
    });
  });

  describe('isToolAllowed', () => {
    it('should deny if TOOLS_CALL not granted', () => {
      // Use unique origin to avoid state pollution
      const uniqueOrigin = 'https://unique-test-' + Date.now() + '.com';
      const result = isToolAllowed(uniqueOrigin, TEST_PROFILE, 'server1/tool1');
      expect(result.allowed).toBe(false);
      expect(result.error?.code).toBe('ERR_SCOPE_REQUIRED');
    });

    it('should allow any tool if no allowlist', async () => {
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL, GrantType.ALLOW_ALWAYS);

      const result = isToolAllowed(TEST_ORIGIN, TEST_PROFILE, 'any-server/any-tool');
      expect(result.allowed).toBe(true);
    });

    it('should only allow tools in allowlist', async () => {
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL, GrantType.ALLOW_ALWAYS, {
        allowedTools: ['server1/tool1'],
      });

      let result = isToolAllowed(TEST_ORIGIN, TEST_PROFILE, 'server1/tool1');
      expect(result.allowed).toBe(true);

      result = isToolAllowed(TEST_ORIGIN, TEST_PROFILE, 'server1/tool2');
      expect(result.allowed).toBe(false);
      expect(result.error?.code).toBe('ERR_TOOL_NOT_ALLOWED');
    });
  });

  describe('expireTabGrants', () => {
    it('should expire all grants for a closed tab', async () => {
      const tabId = 123;

      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST, GrantType.ALLOW_ONCE, {
        tabId,
      });
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL, GrantType.ALLOW_ONCE, {
        tabId,
      });

      // Both should be granted
      expect(checkPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST).granted).toBe(true);
      expect(checkPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL).granted).toBe(true);

      // Expire tab grants
      const expired = expireTabGrants(tabId);
      expect(expired).toBe(2);

      // Both should be revoked
      expect(checkPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST).granted).toBe(false);
      expect(checkPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL).granted).toBe(false);
    });

    it('should not expire ALLOW_ALWAYS grants', async () => {
      const tabId = 123;

      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST, GrantType.ALLOW_ALWAYS);
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL, GrantType.ALLOW_ONCE, {
        tabId,
      });

      expireTabGrants(tabId);

      // ALLOW_ALWAYS should remain
      expect(checkPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST).granted).toBe(true);
      // ALLOW_ONCE with tab should be expired
      expect(checkPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL).granted).toBe(false);
    });
  });

  describe('getPermissions', () => {
    it('should return all permissions for origin/profile', async () => {
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST, GrantType.ALLOW_ALWAYS);
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL, GrantType.ALLOW_ONCE);

      const grants = getPermissions(TEST_ORIGIN, TEST_PROFILE);
      expect(grants).toHaveLength(2);
      expect(grants.map(g => g.scope)).toContain(PermissionScope.TOOLS_LIST);
      expect(grants.map(g => g.scope)).toContain(PermissionScope.TOOLS_CALL);
    });
  });
});

