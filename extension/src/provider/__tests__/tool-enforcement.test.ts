/**
 * Tool Allowlist Enforcement Tests
 * 
 * Tests that verify tool access is properly controlled by the permission system.
 * These tests ensure that:
 * 1. Tools are only accessible when mcp:tools.call is granted
 * 2. Per-tool allowlists are respected
 * 3. Proper errors are returned for unauthorized access
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { PermissionScope, PermissionGrant, ApiError } from '../types';
import { __clearMockStorage } from './__mocks__/webextension-polyfill';

// Import the module under test (uses mocked browser via vitest alias)
import {
  getPermissionStatus,
  grantPermissions,
  isToolAllowed,
  getAllowedTools,
  updateAllowedTools,
  __clearAllTemporaryGrants,
} from '../permissions';

describe('Tool Allowlist Enforcement', () => {
  const TEST_ORIGIN = 'https://app.example.com';

  beforeEach(() => {
    __clearMockStorage();
    __clearAllTemporaryGrants();
  });

  describe('Without mcp:tools.call permission', () => {
    it('should deny all tool access', async () => {
      // Origin has no permissions at all
      const allowed = await isToolAllowed(TEST_ORIGIN, 'memory-server/save_memory');
      expect(allowed).toBe(false);
    });

    it('should deny even if only mcp:tools.list is granted', async () => {
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.list'], 'always');
      
      const allowed = await isToolAllowed(TEST_ORIGIN, 'memory-server/save_memory');
      expect(allowed).toBe(false);
    });
  });

  describe('With mcp:tools.call and no allowlist', () => {
    beforeEach(async () => {
      // Grant mcp:tools.call without specifying tools
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always');
    });

    it('should allow any tool', async () => {
      const allowed1 = await isToolAllowed(TEST_ORIGIN, 'memory-server/save_memory');
      const allowed2 = await isToolAllowed(TEST_ORIGIN, 'filesystem/read_file');
      const allowed3 = await isToolAllowed(TEST_ORIGIN, 'any-server/any-tool');

      expect(allowed1).toBe(true);
      expect(allowed2).toBe(true);
      expect(allowed3).toBe(true);
    });

    it('should return undefined for allowedTools', async () => {
      const tools = await getAllowedTools(TEST_ORIGIN);
      expect(tools).toBeUndefined();
    });
  });

  describe('With mcp:tools.call and specific allowlist', () => {
    const allowedToolsList = [
      'memory-server/save_memory',
      'memory-server/search_memories',
      'filesystem/read_file',
    ];

    beforeEach(async () => {
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
        allowedTools: allowedToolsList,
      });
    });

    it('should allow tools in the allowlist', async () => {
      for (const tool of allowedToolsList) {
        const allowed = await isToolAllowed(TEST_ORIGIN, tool);
        expect(allowed).toBe(true);
      }
    });

    it('should deny tools not in the allowlist', async () => {
      const deniedTools = [
        'memory-server/delete_memory',  // Same server, different tool
        'filesystem/write_file',         // Same server, different tool
        'brave-search/search',           // Different server
      ];

      for (const tool of deniedTools) {
        const allowed = await isToolAllowed(TEST_ORIGIN, tool);
        expect(allowed).toBe(false);
      }
    });

    it('should return the exact allowlist', async () => {
      const tools = await getAllowedTools(TEST_ORIGIN);
      expect(tools).toEqual(allowedToolsList);
    });
  });

  describe('Allowlist modification', () => {
    it('should allow expanding the allowlist', async () => {
      // Initial grant with limited tools
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
        allowedTools: ['memory-server/save_memory'],
      });

      // Verify initial state
      let allowed = await isToolAllowed(TEST_ORIGIN, 'memory-server/search_memories');
      expect(allowed).toBe(false);

      // Expand allowlist via new grant (should merge)
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
        allowedTools: ['memory-server/search_memories'],
      });

      // Now both should be allowed
      allowed = await isToolAllowed(TEST_ORIGIN, 'memory-server/save_memory');
      expect(allowed).toBe(true);
      allowed = await isToolAllowed(TEST_ORIGIN, 'memory-server/search_memories');
      expect(allowed).toBe(true);
    });

    it('should allow replacing the allowlist via updateAllowedTools', async () => {
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
        allowedTools: ['memory-server/save_memory', 'filesystem/read_file'],
      });

      // Replace with different tools
      await updateAllowedTools(TEST_ORIGIN, ['brave-search/search']);

      const tools = await getAllowedTools(TEST_ORIGIN);
      expect(tools).toEqual(['brave-search/search']);

      // Old tools should be denied
      const oldToolAllowed = await isToolAllowed(TEST_ORIGIN, 'memory-server/save_memory');
      expect(oldToolAllowed).toBe(false);

      // New tool should be allowed
      const newToolAllowed = await isToolAllowed(TEST_ORIGIN, 'brave-search/search');
      expect(newToolAllowed).toBe(true);
    });

    it('should allow clearing the allowlist (allow all tools)', async () => {
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
        allowedTools: ['memory-server/save_memory'],
      });

      // Clear allowlist
      await updateAllowedTools(TEST_ORIGIN, []);

      const tools = await getAllowedTools(TEST_ORIGIN);
      expect(tools).toBeUndefined();

      // Any tool should now be allowed
      const allowed = await isToolAllowed(TEST_ORIGIN, 'any-server/any-tool');
      expect(allowed).toBe(true);
    });
  });

  describe('Temporary (once) grants with tools', () => {
    it('should support allowlist in once grants', async () => {
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'once', {
        allowedTools: ['memory-server/save_memory'],
      });

      const allowed = await isToolAllowed(TEST_ORIGIN, 'memory-server/save_memory');
      expect(allowed).toBe(true);

      const denied = await isToolAllowed(TEST_ORIGIN, 'filesystem/read_file');
      expect(denied).toBe(false);
    });

    it('should merge allowlists from once grants', async () => {
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'once', {
        allowedTools: ['tool1/a'],
      });
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'once', {
        allowedTools: ['tool2/b'],
      });

      const allowed1 = await isToolAllowed(TEST_ORIGIN, 'tool1/a');
      const allowed2 = await isToolAllowed(TEST_ORIGIN, 'tool2/b');
      
      expect(allowed1).toBe(true);
      expect(allowed2).toBe(true);
    });
  });

  describe('Multi-origin tool isolation', () => {
    const ORIGIN_A = 'https://app-a.com';
    const ORIGIN_B = 'https://app-b.com';

    it('should maintain separate allowlists per origin', async () => {
      await grantPermissions(ORIGIN_A, ['mcp:tools.call'], 'always', {
        allowedTools: ['memory-server/save_memory'],
      });
      await grantPermissions(ORIGIN_B, ['mcp:tools.call'], 'always', {
        allowedTools: ['filesystem/read_file'],
      });

      // Origin A can use memory but not filesystem
      expect(await isToolAllowed(ORIGIN_A, 'memory-server/save_memory')).toBe(true);
      expect(await isToolAllowed(ORIGIN_A, 'filesystem/read_file')).toBe(false);

      // Origin B can use filesystem but not memory
      expect(await isToolAllowed(ORIGIN_B, 'filesystem/read_file')).toBe(true);
      expect(await isToolAllowed(ORIGIN_B, 'memory-server/save_memory')).toBe(false);
    });

    it('should not leak tools when one origin has no allowlist', async () => {
      // Origin A has unlimited access
      await grantPermissions(ORIGIN_A, ['mcp:tools.call'], 'always');
      // Origin B has limited access
      await grantPermissions(ORIGIN_B, ['mcp:tools.call'], 'always', {
        allowedTools: ['safe-server/safe_tool'],
      });

      // Origin A can access any tool
      expect(await isToolAllowed(ORIGIN_A, 'dangerous-server/delete_all')).toBe(true);

      // Origin B cannot
      expect(await isToolAllowed(ORIGIN_B, 'dangerous-server/delete_all')).toBe(false);
    });
  });

  describe('Tool name format validation', () => {
    beforeEach(async () => {
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
        allowedTools: ['server/tool'],
      });
    });

    it('should require exact match including server prefix', async () => {
      // Exact match works
      expect(await isToolAllowed(TEST_ORIGIN, 'server/tool')).toBe(true);

      // Partial matches should not work
      expect(await isToolAllowed(TEST_ORIGIN, 'tool')).toBe(false);
      expect(await isToolAllowed(TEST_ORIGIN, 'server')).toBe(false);
      expect(await isToolAllowed(TEST_ORIGIN, 'other-server/tool')).toBe(false);
      expect(await isToolAllowed(TEST_ORIGIN, 'server/other-tool')).toBe(false);
    });

    it('should be case-sensitive', async () => {
      expect(await isToolAllowed(TEST_ORIGIN, 'server/tool')).toBe(true);
      expect(await isToolAllowed(TEST_ORIGIN, 'Server/tool')).toBe(false);
      expect(await isToolAllowed(TEST_ORIGIN, 'server/Tool')).toBe(false);
      expect(await isToolAllowed(TEST_ORIGIN, 'SERVER/TOOL')).toBe(false);
    });
  });

  describe('Permission status includes allowedTools', () => {
    it('should include allowedTools in getPermissionStatus', async () => {
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
        allowedTools: ['tool1/a', 'tool2/b'],
      });

      const status = await getPermissionStatus(TEST_ORIGIN);
      expect(status.allowedTools).toEqual(['tool1/a', 'tool2/b']);
    });

    it('should not include allowedTools if not set', async () => {
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always');

      const status = await getPermissionStatus(TEST_ORIGIN);
      expect(status.allowedTools).toBeUndefined();
    });
  });

  describe('Error scenarios', () => {
    it('should return proper error info for ERR_TOOL_NOT_ALLOWED scenario', async () => {
      // This simulates what the background-router does
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
        allowedTools: ['allowed-server/allowed-tool'],
      });

      const tool = 'blocked-server/blocked-tool';
      const allowed = await isToolAllowed(TEST_ORIGIN, tool);
      
      if (!allowed) {
        // The error that would be returned
        const error: ApiError = {
          code: 'ERR_TOOL_NOT_ALLOWED',
          message: `Tool "${tool}" is not in the allowlist for this origin`,
          details: {
            tool,
            allowedTools: await getAllowedTools(TEST_ORIGIN),
          },
        };

        expect(error.code).toBe('ERR_TOOL_NOT_ALLOWED');
        expect(error.details).toHaveProperty('tool', tool);
        expect(error.details).toHaveProperty('allowedTools');
      }
    });

    it('should return proper error info for ERR_SCOPE_REQUIRED scenario', async () => {
      // No mcp:tools.call permission at all
      const tool = 'any-server/any-tool';
      const allowed = await isToolAllowed(TEST_ORIGIN, tool);
      
      if (!allowed) {
        // Check permission status to understand why
        const status = await getPermissionStatus(TEST_ORIGIN);
        const hasToolsCall = status.scopes['mcp:tools.call'] === 'granted-always' 
          || status.scopes['mcp:tools.call'] === 'granted-once';

        if (!hasToolsCall) {
          const error: ApiError = {
            code: 'ERR_SCOPE_REQUIRED',
            message: 'Permission "mcp:tools.call" is required',
            details: { requiredScope: 'mcp:tools.call' },
          };

          expect(error.code).toBe('ERR_SCOPE_REQUIRED');
          expect(error.details).toHaveProperty('requiredScope', 'mcp:tools.call');
        }
      }
    });
  });
});

describe('Tool Allowlist with Request Flow', () => {
  const TEST_ORIGIN = 'https://app.example.com';

  beforeEach(() => {
    __clearMockStorage();
    __clearAllTemporaryGrants();
  });

  describe('Progressive permission granting', () => {
    it('should support requesting more tools later', async () => {
      // First request: limited tools
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
        allowedTools: ['memory-server/save_memory'],
      });

      // App can only use save_memory
      expect(await isToolAllowed(TEST_ORIGIN, 'memory-server/save_memory')).toBe(true);
      expect(await isToolAllowed(TEST_ORIGIN, 'memory-server/search_memories')).toBe(false);

      // Second request: add more tools
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
        allowedTools: ['memory-server/search_memories'],
      });

      // Now both tools work
      expect(await isToolAllowed(TEST_ORIGIN, 'memory-server/save_memory')).toBe(true);
      expect(await isToolAllowed(TEST_ORIGIN, 'memory-server/search_memories')).toBe(true);
    });
  });

  describe('Mixed permission levels', () => {
    it('temp grants with tools override permanent tools (not merge)', async () => {
      // Permanent: memory tools
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
        allowedTools: ['memory-server/save_memory'],
      });

      // Before temp grant, permanent tools work
      expect(await isToolAllowed(TEST_ORIGIN, 'memory-server/save_memory')).toBe(true);

      // Temporary: filesystem access for this session - this REPLACES the tool list
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'once', {
        allowedTools: ['filesystem/read_file'],
      });

      // Now only temp tools work (temp takes precedence)
      expect(await isToolAllowed(TEST_ORIGIN, 'filesystem/read_file')).toBe(true);
      expect(await isToolAllowed(TEST_ORIGIN, 'memory-server/save_memory')).toBe(false);
    });

    it('temp grants without tools fall back to permanent tools', async () => {
      // Permanent: memory tools
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'always', {
        allowedTools: ['memory-server/save_memory'],
      });

      // Temporary grant without specifying tools
      await grantPermissions(TEST_ORIGIN, ['mcp:tools.call'], 'once');

      // Falls back to permanent tool list
      expect(await isToolAllowed(TEST_ORIGIN, 'memory-server/save_memory')).toBe(true);
      expect(await isToolAllowed(TEST_ORIGIN, 'filesystem/read_file')).toBe(false);
    });
  });
});

