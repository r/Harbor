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
  ALL_SCOPES,
  SCOPE_DESCRIPTIONS,
  __clearAllTemporaryGrants,
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
});

