/**
 * Tool Registry Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerServerTools,
  unregisterServerTools,
  getTool,
  getAllTools,
  listTools,
  resolveTool,
  getToolStats,
  clearAllTools,
  namespaceTool,
  parseNamespacedTool,
} from '../tool-registry.js';
import { grantPermission, clearTransientPermissions } from '../permissions.js';
import { GrantType, PermissionScope } from '../types.js';

describe('Tool Registry', () => {
  const TEST_ORIGIN = 'https://example.com';
  const TEST_PROFILE = 'test-profile';

  beforeEach(() => {
    clearAllTools();
    clearTransientPermissions();
  });

  describe('namespaceTool', () => {
    it('should create namespaced tool name', () => {
      expect(namespaceTool('filesystem', 'read_file')).toBe('filesystem/read_file');
      expect(namespaceTool('github', 'search_issues')).toBe('github/search_issues');
    });
  });

  describe('parseNamespacedTool', () => {
    it('should parse valid namespaced names', () => {
      expect(parseNamespacedTool('filesystem/read_file')).toEqual({
        serverId: 'filesystem',
        toolName: 'read_file',
      });
    });

    it('should return null for invalid names', () => {
      expect(parseNamespacedTool('no-slash')).toBeNull();
    });

    it('should handle multiple slashes', () => {
      expect(parseNamespacedTool('server/tool/with/slashes')).toEqual({
        serverId: 'server',
        toolName: 'tool/with/slashes',
      });
    });
  });

  describe('registerServerTools', () => {
    it('should register tools with namespace', () => {
      const tools = registerServerTools('filesystem', 'Filesystem Server', [
        { name: 'read_file', description: 'Read a file' },
        { name: 'write_file', description: 'Write a file' },
      ]);

      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('filesystem/read_file');
      expect(tools[0].originalName).toBe('read_file');
      expect(tools[0].serverId).toBe('filesystem');
      expect(tools[0].serverLabel).toBe('Filesystem Server');
    });

    it('should replace existing tools from same server', () => {
      registerServerTools('server1', 'Server 1', [
        { name: 'tool1' },
        { name: 'tool2' },
      ]);

      expect(getAllTools()).toHaveLength(2);

      registerServerTools('server1', 'Server 1', [
        { name: 'tool3' },
      ]);

      expect(getAllTools()).toHaveLength(1);
      expect(getAllTools()[0].name).toBe('server1/tool3');
    });
  });

  describe('unregisterServerTools', () => {
    it('should remove all tools from a server', () => {
      registerServerTools('server1', 'Server 1', [{ name: 'tool1' }]);
      registerServerTools('server2', 'Server 2', [{ name: 'tool2' }]);

      expect(getAllTools()).toHaveLength(2);

      const removed = unregisterServerTools('server1');
      expect(removed).toBe(1);
      expect(getAllTools()).toHaveLength(1);
      expect(getAllTools()[0].serverId).toBe('server2');
    });

    it('should return 0 for unknown server', () => {
      const removed = unregisterServerTools('unknown');
      expect(removed).toBe(0);
    });
  });

  describe('getTool', () => {
    it('should get tool by namespaced name', () => {
      registerServerTools('server1', 'Server 1', [
        { name: 'tool1', description: 'Test tool' },
      ]);

      const tool = getTool('server1/tool1');
      expect(tool).toBeDefined();
      expect(tool?.description).toBe('Test tool');
    });

    it('should return undefined for unknown tool', () => {
      const tool = getTool('unknown/tool');
      expect(tool).toBeUndefined();
    });
  });

  describe('getAllTools', () => {
    it('should filter by serverIds', () => {
      registerServerTools('server1', 'Server 1', [{ name: 'tool1' }]);
      registerServerTools('server2', 'Server 2', [{ name: 'tool2' }]);
      registerServerTools('server3', 'Server 3', [{ name: 'tool3' }]);

      const filtered = getAllTools({ serverIds: ['server1', 'server3'] });
      expect(filtered).toHaveLength(2);
      expect(filtered.map(t => t.serverId)).toContain('server1');
      expect(filtered.map(t => t.serverId)).toContain('server3');
    });

    it('should filter by name pattern', () => {
      registerServerTools('server1', 'Server 1', [
        { name: 'read_file' },
        { name: 'write_file' },
        { name: 'list_directory' },
      ]);

      const filtered = getAllTools({ namePattern: /file/ });
      expect(filtered).toHaveLength(2);
      expect(filtered.map(t => t.originalName)).toContain('read_file');
      expect(filtered.map(t => t.originalName)).toContain('write_file');
    });
  });

  describe('listTools', () => {
    it('should require TOOLS_LIST permission', () => {
      registerServerTools('server1', 'Server 1', [{ name: 'tool1' }]);

      const result = listTools(TEST_ORIGIN, TEST_PROFILE);
      expect(result.error?.code).toBe('ERR_SCOPE_REQUIRED');
    });

    it('should list tools when permitted', async () => {
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST, GrantType.ALLOW_ALWAYS);
      registerServerTools('server1', 'Server 1', [{ name: 'tool1' }]);

      const result = listTools(TEST_ORIGIN, TEST_PROFILE);
      expect(result.tools).toHaveLength(1);
      expect(result.tools?.[0].name).toBe('server1/tool1');
    });

    it('should filter by allowlist in grant', async () => {
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST, GrantType.ALLOW_ALWAYS, {
        allowedTools: ['server1/tool1'],
      });
      registerServerTools('server1', 'Server 1', [
        { name: 'tool1' },
        { name: 'tool2' },
      ]);

      const result = listTools(TEST_ORIGIN, TEST_PROFILE);
      expect(result.tools).toHaveLength(1);
      expect(result.tools?.[0].name).toBe('server1/tool1');
    });
  });

  describe('resolveTool', () => {
    beforeEach(async () => {
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL, GrantType.ALLOW_ALWAYS);
    });

    it('should resolve existing tool', () => {
      registerServerTools('server1', 'Server 1', [{ name: 'tool1' }]);

      const result = resolveTool(TEST_ORIGIN, TEST_PROFILE, 'server1/tool1');
      expect(result.tool).toBeDefined();
      expect(result.tool?.name).toBe('server1/tool1');
    });

    it('should return ERR_TOOL_NOT_FOUND for unknown tool', () => {
      const result = resolveTool(TEST_ORIGIN, TEST_PROFILE, 'unknown/tool');
      expect(result.error?.code).toBe('ERR_TOOL_NOT_FOUND');
    });
  });

  describe('getToolStats', () => {
    it('should return accurate statistics', () => {
      registerServerTools('server1', 'Server 1', [{ name: 'tool1' }, { name: 'tool2' }]);
      registerServerTools('server2', 'Server 2', [{ name: 'tool3' }]);

      const stats = getToolStats();
      expect(stats.totalTools).toBe(3);
      expect(stats.serverCount).toBe(2);
      expect(stats.toolsByServer['server1']).toBe(2);
      expect(stats.toolsByServer['server2']).toBe(1);
    });
  });
});

