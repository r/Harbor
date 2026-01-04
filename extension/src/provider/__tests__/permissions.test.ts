/**
 * Permission Module Tests
 * 
 * Tests for the Harbor JS AI Provider permission system.
 * Verifies that permissions work as documented in the API reference.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { PermissionScope, PermissionGrant, StoredPermissions } from '../types';
import { __mockStorage, __clearMockStorage } from './__mocks__/webextension-polyfill';

// Import the module under test (uses mocked browser via vitest alias)
import {
  getPermissionStatus,
  hasPermission,
  hasAllPermissions,
  getMissingPermissions,
  grantPermissions,
  denyPermissions,
  revokeAllPermissions,
  buildGrantResult,
  getAllowedTools,
  isToolAllowed,
  updateAllowedTools,
  getAllPermissions,
  clearTabGrants,
  ALL_SCOPES,
  SCOPE_DESCRIPTIONS,
  __clearAllTemporaryGrants,
  __getTemporaryGrants,
} from '../permissions';

describe('Permission System', () => {
  const TEST_ORIGIN = 'https://example.com';

  beforeEach(() => {
    // Clear mock storage and temporary grants before each test
    __clearMockStorage();
    __clearAllTemporaryGrants();
  });

  describe('ALL_SCOPES constant', () => {
    it('should contain all documented permission scopes', () => {
      // Per API docs: Permission Scopes table
      const documentedScopes: PermissionScope[] = [
        'model:prompt',
        'model:tools',
        'mcp:tools.list',
        'mcp:tools.call',
        'browser:activeTab.read',
        'web:fetch',
      ];

      for (const scope of documentedScopes) {
        expect(ALL_SCOPES).toContain(scope);
      }
      expect(ALL_SCOPES.length).toBe(documentedScopes.length);
    });

    it('should have descriptions for all scopes', () => {
      for (const scope of ALL_SCOPES) {
        expect(SCOPE_DESCRIPTIONS[scope]).toBeDefined();
        expect(typeof SCOPE_DESCRIPTIONS[scope]).toBe('string');
        expect(SCOPE_DESCRIPTIONS[scope].length).toBeGreaterThan(0);
      }
    });
  });

  describe('getPermissionStatus', () => {
    it('should return all scopes with "not-granted" status for new origin', async () => {
      const status = await getPermissionStatus(TEST_ORIGIN);

      expect(status.origin).toBe(TEST_ORIGIN);
      for (const scope of ALL_SCOPES) {
        expect(status.scopes[scope]).toBe('not-granted');
      }
    });

    it('should return the origin in the response', async () => {
      const status = await getPermissionStatus(TEST_ORIGIN);
      expect(status.origin).toBe(TEST_ORIGIN);
    });

    it('should include allowedTools when present', async () => {
      // First grant with tools
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
        allowedTools: ['server1/tool1', 'server2/tool2'],
      });

      const status = await getPermissionStatus(TEST_ORIGIN);
      expect(status.allowedTools).toEqual(['server1/tool1', 'server2/tool2']);
    });
  });

  describe('hasPermission', () => {
    it('should return false for ungrant scope', async () => {
      const result = await hasPermission(TEST_ORIGIN, 'model:prompt');
      expect(result).toBe(false);
    });

    it('should return true for granted-once scope', async () => {
      await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'once');
      const result = await hasPermission(TEST_ORIGIN, 'model:prompt');
      expect(result).toBe(true);
    });

    it('should return true for granted-always scope', async () => {
      await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'always');
      const result = await hasPermission(TEST_ORIGIN, 'model:prompt');
      expect(result).toBe(true);
    });

    it('should return false for denied scope', async () => {
      await denyPermissions(TEST_ORIGIN, ['model:prompt']);
      const result = await hasPermission(TEST_ORIGIN, 'model:prompt');
      expect(result).toBe(false);
    });
  });

  describe('hasAllPermissions', () => {
    it('should return false if any scope is not granted', async () => {
      await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'always');
      const result = await hasAllPermissions(TEST_ORIGIN, ['model:prompt', 'model:tools']);
      expect(result).toBe(false);
    });

    it('should return true if all scopes are granted', async () => {
      await grantPermissions(TEST_ORIGIN, ['model:prompt', 'model:tools'], 'always');
      const result = await hasAllPermissions(TEST_ORIGIN, ['model:prompt', 'model:tools']);
      expect(result).toBe(true);
    });

    it('should return true for empty scope array', async () => {
      const result = await hasAllPermissions(TEST_ORIGIN, []);
      expect(result).toBe(true);
    });
  });

  describe('getMissingPermissions', () => {
    it('should return all scopes as missing for new origin', async () => {
      const scopes: PermissionScope[] = ['model:prompt', 'model:tools'];
      const missing = await getMissingPermissions(TEST_ORIGIN, scopes);
      expect(missing).toEqual(scopes);
    });

    it('should return only ungranted scopes', async () => {
      await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'always');
      const missing = await getMissingPermissions(TEST_ORIGIN, ['model:prompt', 'model:tools']);
      expect(missing).toEqual(['model:tools']);
    });

    it('should return empty array if all granted', async () => {
      await grantPermissions(TEST_ORIGIN, ['model:prompt', 'model:tools'], 'always');
      const missing = await getMissingPermissions(TEST_ORIGIN, ['model:prompt', 'model:tools']);
      expect(missing).toEqual([]);
    });
  });

  describe('grantPermissions', () => {
    describe('grant type: once', () => {
      it('should grant permissions with "granted-once" status', async () => {
        await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'once');
        const status = await getPermissionStatus(TEST_ORIGIN);
        expect(status.scopes['model:prompt']).toBe('granted-once');
      });

      it('should grant multiple scopes at once', async () => {
        await grantPermissions(TEST_ORIGIN, ['model:prompt', 'model:tools'], 'once');
        const status = await getPermissionStatus(TEST_ORIGIN);
        expect(status.scopes['model:prompt']).toBe('granted-once');
        expect(status.scopes['model:tools']).toBe('granted-once');
      });

      it('should allow specifying allowedTools', async () => {
        await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'once', {
          allowedTools: ['server1/tool1'],
        });
        const tools = await getAllowedTools(TEST_ORIGIN);
        expect(tools).toEqual(['server1/tool1']);
      });

      it('should merge with existing once grants', async () => {
        await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'once');
        await grantPermissions(TEST_ORIGIN, ['model:tools'], 'once');
        
        const status = await getPermissionStatus(TEST_ORIGIN);
        expect(status.scopes['model:prompt']).toBe('granted-once');
        expect(status.scopes['model:tools']).toBe('granted-once');
      });
    });

    describe('grant type: always', () => {
      it('should grant permissions with "granted-always" status', async () => {
        await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'always');
        const status = await getPermissionStatus(TEST_ORIGIN);
        expect(status.scopes['model:prompt']).toBe('granted-always');
      });

      it('should persist to storage', async () => {
        await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'always');
        // Verify the permission persists by checking status
        const status = await getPermissionStatus(TEST_ORIGIN);
        expect(status.scopes['model:prompt']).toBe('granted-always');
      });

      it('should allow specifying allowedTools', async () => {
        await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
          allowedTools: ['server1/tool1', 'server2/tool2'],
        });
        const tools = await getAllowedTools(TEST_ORIGIN);
        expect(tools).toContain('server1/tool1');
        expect(tools).toContain('server2/tool2');
      });

      it('should merge with existing always grants', async () => {
        await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'always');
        await grantPermissions(TEST_ORIGIN, ['model:tools'], 'always');
        
        const status = await getPermissionStatus(TEST_ORIGIN);
        expect(status.scopes['model:prompt']).toBe('granted-always');
        expect(status.scopes['model:tools']).toBe('granted-always');
      });

      it('should merge allowedTools across grants', async () => {
        await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
          allowedTools: ['server1/tool1'],
        });
        await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
          allowedTools: ['server2/tool2'],
        });
        
        const tools = await getAllowedTools(TEST_ORIGIN);
        expect(tools).toContain('server1/tool1');
        expect(tools).toContain('server2/tool2');
      });
    });
  });

  describe('denyPermissions', () => {
    it('should deny permissions with "denied" status', async () => {
      await denyPermissions(TEST_ORIGIN, ['model:prompt']);
      const status = await getPermissionStatus(TEST_ORIGIN);
      expect(status.scopes['model:prompt']).toBe('denied');
    });

    it('should deny multiple scopes at once', async () => {
      await denyPermissions(TEST_ORIGIN, ['model:prompt', 'model:tools']);
      const status = await getPermissionStatus(TEST_ORIGIN);
      expect(status.scopes['model:prompt']).toBe('denied');
      expect(status.scopes['model:tools']).toBe('denied');
    });

    it('should override existing grants', async () => {
      await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'always');
      await denyPermissions(TEST_ORIGIN, ['model:prompt']);
      const status = await getPermissionStatus(TEST_ORIGIN);
      expect(status.scopes['model:prompt']).toBe('denied');
    });

    it('should remove temporary grants for denied scopes', async () => {
      await grantPermissions(TEST_ORIGIN, ['model:prompt', 'model:tools'], 'once');
      await denyPermissions(TEST_ORIGIN, ['model:prompt']);
      
      const status = await getPermissionStatus(TEST_ORIGIN);
      expect(status.scopes['model:prompt']).toBe('denied');
      expect(status.scopes['model:tools']).toBe('granted-once');
    });
  });

  describe('revokeAllPermissions', () => {
    it('should remove all permissions for an origin', async () => {
      await grantPermissions(TEST_ORIGIN, ['model:prompt', 'model:tools'], 'always');
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.list'], 'once');
      
      await revokeAllPermissions(TEST_ORIGIN);
      
      const status = await getPermissionStatus(TEST_ORIGIN);
      for (const scope of ALL_SCOPES) {
        expect(status.scopes[scope]).toBe('not-granted');
      }
    });

    it('should remove allowedTools as well', async () => {
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
        allowedTools: ['server1/tool1'],
      });
      
      await revokeAllPermissions(TEST_ORIGIN);
      
      const tools = await getAllowedTools(TEST_ORIGIN);
      expect(tools).toBeUndefined();
    });

    it('should not affect other origins', async () => {
      const otherOrigin = 'https://other.com';
      await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'always');
      await grantPermissions(otherOrigin, ['model:tools'], 'always');
      
      await revokeAllPermissions(TEST_ORIGIN);
      
      const status = await getPermissionStatus(otherOrigin);
      expect(status.scopes['model:tools']).toBe('granted-always');
    });
  });

  describe('buildGrantResult', () => {
    it('should return granted=true when all requested scopes are granted', async () => {
      await grantPermissions(TEST_ORIGIN, ['model:prompt', 'model:tools'], 'always');
      const result = await buildGrantResult(TEST_ORIGIN, ['model:prompt', 'model:tools']);
      
      expect(result.granted).toBe(true);
      expect(result.scopes['model:prompt']).toBe('granted-always');
      expect(result.scopes['model:tools']).toBe('granted-always');
    });

    it('should return granted=false when any requested scope is not granted', async () => {
      await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'always');
      const result = await buildGrantResult(TEST_ORIGIN, ['model:prompt', 'model:tools']);
      
      expect(result.granted).toBe(false);
    });

    it('should return granted=false when any requested scope is denied', async () => {
      await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'always');
      await denyPermissions(TEST_ORIGIN, ['model:tools']);
      const result = await buildGrantResult(TEST_ORIGIN, ['model:prompt', 'model:tools']);
      
      expect(result.granted).toBe(false);
      expect(result.scopes['model:tools']).toBe('denied');
    });

    it('should include allowedTools when present', async () => {
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
        allowedTools: ['server1/tool1'],
      });
      const result = await buildGrantResult(TEST_ORIGIN, ['mcp:tools.call']);
      
      expect(result.allowedTools).toEqual(['server1/tool1']);
    });
  });

  describe('Tool Allowlist', () => {
    describe('getAllowedTools', () => {
      it('should return undefined when no allowlist is set', async () => {
        await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always');
        const tools = await getAllowedTools(TEST_ORIGIN);
        expect(tools).toBeUndefined();
      });

      it('should return the allowlist when set', async () => {
        await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
          allowedTools: ['server1/tool1', 'server2/tool2'],
        });
        const tools = await getAllowedTools(TEST_ORIGIN);
        expect(tools).toEqual(['server1/tool1', 'server2/tool2']);
      });
    });

    describe('isToolAllowed', () => {
      it('should return false when mcp:tools.call is not granted', async () => {
        const allowed = await isToolAllowed(TEST_ORIGIN, 'server1/tool1');
        expect(allowed).toBe(false);
      });

      it('should return true for any tool when no allowlist is set', async () => {
        await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always');
        
        const allowed1 = await isToolAllowed(TEST_ORIGIN, 'server1/tool1');
        const allowed2 = await isToolAllowed(TEST_ORIGIN, 'any-server/any-tool');
        
        expect(allowed1).toBe(true);
        expect(allowed2).toBe(true);
      });

      it('should return true only for tools in allowlist', async () => {
        await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
          allowedTools: ['server1/tool1'],
        });
        
        const allowed1 = await isToolAllowed(TEST_ORIGIN, 'server1/tool1');
        const allowed2 = await isToolAllowed(TEST_ORIGIN, 'server2/tool2');
        
        expect(allowed1).toBe(true);
        expect(allowed2).toBe(false);
      });
    });

    describe('updateAllowedTools', () => {
      it('should update the allowlist for an origin with existing permissions', async () => {
        await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
          allowedTools: ['server1/tool1'],
        });
        
        await updateAllowedTools(TEST_ORIGIN, ['server2/tool2', 'server3/tool3']);
        
        const tools = await getAllowedTools(TEST_ORIGIN);
        expect(tools).toEqual(['server2/tool2', 'server3/tool3']);
      });

      it('should clear the allowlist when given empty array', async () => {
        await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
          allowedTools: ['server1/tool1'],
        });
        
        await updateAllowedTools(TEST_ORIGIN, []);
        
        const tools = await getAllowedTools(TEST_ORIGIN);
        expect(tools).toBeUndefined();
      });

      it('should not add allowlist if origin has no permissions', async () => {
        await updateAllowedTools(TEST_ORIGIN, ['server1/tool1']);
        
        const tools = await getAllowedTools(TEST_ORIGIN);
        expect(tools).toBeUndefined();
      });
    });
  });

  describe('Permission Grant Types (Per API Docs)', () => {
    // API docs: Permission Grants table
    // granted-always: Persisted permission for this origin
    // granted-once: Temporary permission (expires after ~10 minutes or tab close)
    // denied: User explicitly denied (won't re-prompt)
    // not-granted: Never requested

    it('"not-granted" should be the default for unrequested scopes', async () => {
      const status = await getPermissionStatus(TEST_ORIGIN);
      expect(status.scopes['model:prompt']).toBe('not-granted');
    });

    it('"granted-always" should persist across checks', async () => {
      await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'always');
      
      // Simulate multiple checks
      const status1 = await getPermissionStatus(TEST_ORIGIN);
      const status2 = await getPermissionStatus(TEST_ORIGIN);
      
      expect(status1.scopes['model:prompt']).toBe('granted-always');
      expect(status2.scopes['model:prompt']).toBe('granted-always');
    });

    it('"granted-once" should be distinguishable from "granted-always"', async () => {
      await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'once');
      await grantPermissions(TEST_ORIGIN, ['model:tools'], 'always');
      
      const status = await getPermissionStatus(TEST_ORIGIN);
      expect(status.scopes['model:prompt']).toBe('granted-once');
      expect(status.scopes['model:tools']).toBe('granted-always');
    });

    it('"denied" should override previous grants', async () => {
      await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'always');
      await denyPermissions(TEST_ORIGIN, ['model:prompt']);
      
      const status = await getPermissionStatus(TEST_ORIGIN);
      expect(status.scopes['model:prompt']).toBe('denied');
    });
  });

  describe('Multi-Origin Isolation', () => {
    const ORIGIN_A = 'https://app-a.com';
    const ORIGIN_B = 'https://app-b.com';

    it('should maintain separate permissions per origin', async () => {
      await grantPermissions(ORIGIN_A, ['model:prompt'], 'always');
      await grantPermissions(ORIGIN_B, ['model:tools'], 'always');
      
      const statusA = await getPermissionStatus(ORIGIN_A);
      const statusB = await getPermissionStatus(ORIGIN_B);
      
      expect(statusA.scopes['model:prompt']).toBe('granted-always');
      expect(statusA.scopes['model:tools']).toBe('not-granted');
      
      expect(statusB.scopes['model:prompt']).toBe('not-granted');
      expect(statusB.scopes['model:tools']).toBe('granted-always');
    });

    it('should maintain separate tool allowlists per origin', async () => {
      await grantPermissions(ORIGIN_A, ['mcp:tools.call'], 'always', {
        allowedTools: ['server1/tool1'],
      });
      await grantPermissions(ORIGIN_B, ['mcp:tools.call'], 'always', {
        allowedTools: ['server2/tool2'],
      });
      
      const toolsA = await getAllowedTools(ORIGIN_A);
      const toolsB = await getAllowedTools(ORIGIN_B);
      
      expect(toolsA).toEqual(['server1/tool1']);
      expect(toolsB).toEqual(['server2/tool2']);
    });

    it('should allow denying for one origin without affecting another', async () => {
      await grantPermissions(ORIGIN_A, ['model:prompt'], 'always');
      await grantPermissions(ORIGIN_B, ['model:prompt'], 'always');
      
      await denyPermissions(ORIGIN_A, ['model:prompt']);
      
      const statusA = await getPermissionStatus(ORIGIN_A);
      const statusB = await getPermissionStatus(ORIGIN_B);
      
      expect(statusA.scopes['model:prompt']).toBe('denied');
      expect(statusB.scopes['model:prompt']).toBe('granted-always');
    });
  });

  describe('getAllPermissions (for UI listing)', () => {
    it('should return empty array when no permissions exist', async () => {
      const permissions = await getAllPermissions();
      expect(permissions).toEqual([]);
    });

    it('should return persistent (always) permissions', async () => {
      await grantPermissions(TEST_ORIGIN, ['model:prompt', 'model:tools'], 'always');
      
      const permissions = await getAllPermissions();
      
      expect(permissions.length).toBe(1);
      expect(permissions[0].origin).toBe(TEST_ORIGIN);
      expect(permissions[0].scopes['model:prompt']).toBe('granted-always');
      expect(permissions[0].scopes['model:tools']).toBe('granted-always');
    });

    it('should return temporary (once) permissions', async () => {
      await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'once');
      
      const permissions = await getAllPermissions();
      
      expect(permissions.length).toBe(1);
      expect(permissions[0].origin).toBe(TEST_ORIGIN);
      expect(permissions[0].scopes['model:prompt']).toBe('granted-once');
    });

    it('should merge persistent and temporary permissions for same origin', async () => {
      // Grant some permissions persistently
      await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'always');
      // Grant different permissions temporarily
      await grantPermissions(TEST_ORIGIN, ['model:tools'], 'once');
      
      const permissions = await getAllPermissions();
      
      expect(permissions.length).toBe(1);
      expect(permissions[0].origin).toBe(TEST_ORIGIN);
      expect(permissions[0].scopes['model:prompt']).toBe('granted-always');
      expect(permissions[0].scopes['model:tools']).toBe('granted-once');
    });

    it('should show once grants taking precedence over always for same scope', async () => {
      // Grant persistently first
      await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'always');
      // Then grant temporarily (e.g., user re-prompted and chose "once" again)
      await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'once');
      
      const permissions = await getAllPermissions();
      
      // Temporary should take precedence in display
      expect(permissions[0].scopes['model:prompt']).toBe('granted-once');
    });

    it('should include allowedTools from temporary grants', async () => {
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'once', {
        allowedTools: ['server/tool1', 'server/tool2'],
      });
      
      const permissions = await getAllPermissions();
      
      expect(permissions[0].allowedTools).toEqual(['server/tool1', 'server/tool2']);
    });

    it('should list multiple origins', async () => {
      const ORIGIN_A = 'https://app-a.com';
      const ORIGIN_B = 'https://app-b.com';
      
      await grantPermissions(ORIGIN_A, ['model:prompt'], 'always');
      await grantPermissions(ORIGIN_B, ['model:tools'], 'once');
      
      const permissions = await getAllPermissions();
      
      expect(permissions.length).toBe(2);
      const originNames = permissions.map(p => p.origin).sort();
      expect(originNames).toEqual([ORIGIN_A, ORIGIN_B]);
    });
  });

  describe('Temporary Grant Cleanup', () => {
    describe('clearTabGrants', () => {
      it('should remove temporary grants associated with a tab', async () => {
        const TAB_ID = 12345;
        
        // Grant with a tabId
        await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'once', { tabId: TAB_ID });
        
        // Verify grant exists
        expect(await hasPermission(TEST_ORIGIN, 'model:prompt')).toBe(true);
        
        // Clear grants for this tab
        clearTabGrants(TAB_ID);
        
        // Should no longer have permission
        expect(await hasPermission(TEST_ORIGIN, 'model:prompt')).toBe(false);
      });

      it('should not remove grants from other tabs', async () => {
        const TAB_ID_1 = 111;
        const TAB_ID_2 = 222;
        const ORIGIN_1 = 'https://site1.com';
        const ORIGIN_2 = 'https://site2.com';
        
        await grantPermissions(ORIGIN_1, ['model:prompt'], 'once', { tabId: TAB_ID_1 });
        await grantPermissions(ORIGIN_2, ['model:tools'], 'once', { tabId: TAB_ID_2 });
        
        // Clear only tab 1
        clearTabGrants(TAB_ID_1);
        
        // Tab 1's permissions should be gone
        expect(await hasPermission(ORIGIN_1, 'model:prompt')).toBe(false);
        // Tab 2's permissions should remain
        expect(await hasPermission(ORIGIN_2, 'model:tools')).toBe(true);
      });

      it('should not affect persistent (always) grants', async () => {
        const TAB_ID = 12345;
        
        // Grant persistent permission
        await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'always');
        // Grant temporary permission with tabId
        await grantPermissions(TEST_ORIGIN, ['model:tools'], 'once', { tabId: TAB_ID });
        
        clearTabGrants(TAB_ID);
        
        // Persistent should remain
        expect(await hasPermission(TEST_ORIGIN, 'model:prompt')).toBe(true);
        // Temporary should be gone
        expect(await hasPermission(TEST_ORIGIN, 'model:tools')).toBe(false);
      });

      it('should clear grants from getAllPermissions listing', async () => {
        const TAB_ID = 12345;
        
        // Grant only temporary permission
        await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'once', { tabId: TAB_ID });
        
        // Should appear in listing
        let permissions = await getAllPermissions();
        expect(permissions.length).toBe(1);
        
        // Clear the tab
        clearTabGrants(TAB_ID);
        
        // Should no longer appear
        permissions = await getAllPermissions();
        expect(permissions.length).toBe(0);
      });
    });

    describe('tabId storage', () => {
      it('should store tabId in temporary grants', async () => {
        const TAB_ID = 99999;
        
        await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'once', { tabId: TAB_ID });
        
        const tempGrants = __getTemporaryGrants();
        const grant = tempGrants.get(`temp:${TEST_ORIGIN}`);
        
        expect(grant).toBeDefined();
        expect(grant?.tabId).toBe(TAB_ID);
      });

      it('should preserve tabId when merging grants', async () => {
        const TAB_ID = 99999;
        
        // First grant with tabId
        await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'once', { tabId: TAB_ID });
        // Second grant without tabId (should preserve original)
        await grantPermissions(TEST_ORIGIN, ['model:tools'], 'once');
        
        const tempGrants = __getTemporaryGrants();
        const grant = tempGrants.get(`temp:${TEST_ORIGIN}`);
        
        expect(grant?.tabId).toBe(TAB_ID);
        expect(grant?.scopes).toContain('model:prompt');
        expect(grant?.scopes).toContain('model:tools');
      });
    });

    describe('expiry behavior', () => {
      it('should set expiresAt on temporary grants', async () => {
        const beforeGrant = Date.now();
        await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'once');
        const afterGrant = Date.now();
        
        const tempGrants = __getTemporaryGrants();
        const grant = tempGrants.get(`temp:${TEST_ORIGIN}`);
        
        expect(grant).toBeDefined();
        // Should expire roughly 10 minutes from now (600000ms)
        const TTL_MS = 10 * 60 * 1000;
        expect(grant!.expiresAt).toBeGreaterThanOrEqual(beforeGrant + TTL_MS);
        expect(grant!.expiresAt).toBeLessThanOrEqual(afterGrant + TTL_MS + 100); // small tolerance
      });

      it('should include grantedAt timestamp', async () => {
        const beforeGrant = Date.now();
        await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'once');
        const afterGrant = Date.now();
        
        const tempGrants = __getTemporaryGrants();
        const grant = tempGrants.get(`temp:${TEST_ORIGIN}`);
        
        expect(grant!.grantedAt).toBeGreaterThanOrEqual(beforeGrant);
        expect(grant!.grantedAt).toBeLessThanOrEqual(afterGrant);
      });
    });
  });

  describe('revokeAllPermissions', () => {
    it('should clear both persistent and temporary grants', async () => {
      // Grant both types
      await grantPermissions(TEST_ORIGIN, ['model:prompt'], 'always');
      await grantPermissions(TEST_ORIGIN, ['model:tools'], 'once');
      
      // Verify both exist
      expect(await hasPermission(TEST_ORIGIN, 'model:prompt')).toBe(true);
      expect(await hasPermission(TEST_ORIGIN, 'model:tools')).toBe(true);
      
      // Revoke all
      await revokeAllPermissions(TEST_ORIGIN);
      
      // Both should be gone
      expect(await hasPermission(TEST_ORIGIN, 'model:prompt')).toBe(false);
      expect(await hasPermission(TEST_ORIGIN, 'model:tools')).toBe(false);
      
      // Should not appear in listing
      const permissions = await getAllPermissions();
      expect(permissions.length).toBe(0);
    });
  });
});

