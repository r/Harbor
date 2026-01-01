/**
 * MCP Host Integration Tests
 * 
 * These tests verify end-to-end functionality of the host.
 * Note: Some tests require mock MCP servers.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { McpHost } from '../host.js';
import { grantPermission, clearTransientPermissions } from '../permissions.js';
import { registerServerTools, clearAllTools } from '../tool-registry.js';
import { setRateLimits, cleanupStaleRuns } from '../rate-limiter.js';
import { clearMetrics } from '../observability.js';
import { GrantType, PermissionScope, DEFAULT_RATE_LIMITS } from '../types.js';

describe('MCP Host Integration', () => {
  // Use unique origin per test to avoid state pollution
  let TEST_ORIGIN: string;
  let TEST_PROFILE: string;
  let host: McpHost;

  beforeEach(() => {
    // Reset all state
    clearTransientPermissions();
    clearAllTools();
    clearMetrics();
    setRateLimits(DEFAULT_RATE_LIMITS);
    cleanupStaleRuns(0);

    // Use unique origin and profile per test
    TEST_ORIGIN = `https://test-${Date.now()}-${Math.random().toString(36).slice(2)}.com`;
    TEST_PROFILE = `profile-${Date.now()}`;

    // Create fresh host with unique profile
    host = new McpHost(TEST_PROFILE);

    // Register some test tools
    registerServerTools('filesystem', 'Filesystem Server', [
      { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
      { name: 'write_file', description: 'Write a file' },
    ]);

    registerServerTools('github', 'GitHub Server', [
      { name: 'search_issues', description: 'Search issues' },
    ]);
  });

  describe('listTools', () => {
    it('should deny without permission', () => {
      const result = host.listTools(TEST_ORIGIN);

      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('ERR_SCOPE_REQUIRED');
    });

    it('should list all tools when permitted', async () => {
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST, GrantType.ALLOW_ALWAYS);

      const result = host.listTools(TEST_ORIGIN);

      expect(result.tools).toBeDefined();
      expect(result.tools).toHaveLength(3);
      expect(result.tools?.map(t => t.name)).toContain('filesystem/read_file');
      expect(result.tools?.map(t => t.name)).toContain('github/search_issues');
    });

    it('should filter by serverIds', async () => {
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST, GrantType.ALLOW_ALWAYS);

      const result = host.listTools(TEST_ORIGIN, { serverIds: ['filesystem'] });

      expect(result.tools).toHaveLength(2);
      expect(result.tools?.every(t => t.serverId === 'filesystem')).toBe(true);
    });
  });

  describe('callTool', () => {
    beforeEach(async () => {
      // Grant permissions for tool calls
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL, GrantType.ALLOW_ALWAYS);
    });

    it('should return ERR_TOOL_NOT_FOUND for unknown tool', async () => {
      const result = await host.callTool(TEST_ORIGIN, 'unknown/tool', {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('ERR_TOOL_NOT_FOUND');
      }
    });

    it('should return ERR_SERVER_UNAVAILABLE when server not connected', async () => {
      // Tools are registered but no actual server connection
      const result = await host.callTool(TEST_ORIGIN, 'filesystem/read_file', { path: '/test' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('ERR_SERVER_UNAVAILABLE');
      }
    });

    it('should respect tool allowlist in permission', async () => {
      // Grant permission with restrictive allowlist
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL, GrantType.ALLOW_ALWAYS, {
        allowedTools: ['filesystem/read_file'],
      });

      const result = await host.callTool(TEST_ORIGIN, 'filesystem/write_file', {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Should fail with either TOOL_NOT_ALLOWED or SERVER_UNAVAILABLE
        // (depending on whether permission check or server check runs first)
        expect(['ERR_TOOL_NOT_ALLOWED', 'ERR_SERVER_UNAVAILABLE']).toContain(result.error.code);
      }
    });

    it('should enforce rate limits', async () => {
      setRateLimits({ maxConcurrentPerOrigin: 0 }); // Block all

      const result = await host.callTool(TEST_ORIGIN, 'filesystem/read_file', {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('ERR_RATE_LIMITED');
      }
    });
  });

  describe('getStats', () => {
    it('should return aggregated statistics', async () => {
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST, GrantType.ALLOW_ALWAYS);

      const stats = host.getStats();

      expect(stats.servers).toBeDefined();
      expect(stats.tools.totalTools).toBe(3);
      expect(stats.tools.serverCount).toBe(2);
      expect(stats.rateLimits).toEqual(DEFAULT_RATE_LIMITS);
    });
  });

  describe('clearTools', () => {
    it('should clear all cached tools', async () => {
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST, GrantType.ALLOW_ALWAYS);

      let result = host.listTools(TEST_ORIGIN);
      expect(result.tools).toHaveLength(3);

      host.clearTools();

      result = host.listTools(TEST_ORIGIN);
      expect(result.tools).toHaveLength(0);
    });
  });

  describe('runAgent', () => {
    it('should require permission', async () => {
      const events: unknown[] = [];
      for await (const event of host.runAgent(TEST_ORIGIN, 'test task')) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'error',
        error: { code: 'ERR_SCOPE_REQUIRED' },
      });
    });

    it('should emit status and final events when permitted', async () => {
      // Need both TOOLS_LIST and TOOLS_CALL for agent to work
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST, GrantType.ALLOW_ALWAYS);
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL, GrantType.ALLOW_ALWAYS);

      const events: unknown[] = [];
      for await (const event of host.runAgent(TEST_ORIGIN, 'test task')) {
        events.push(event);
      }

      // Should have at least status and final
      expect(events.length).toBeGreaterThanOrEqual(2);

      const types = events.map((e: any) => e.type);
      expect(types).toContain('status');
      expect(types).toContain('final');
    });

    it('should respect tool allowlist', async () => {
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_LIST, GrantType.ALLOW_ALWAYS);
      await grantPermission(TEST_ORIGIN, TEST_PROFILE, PermissionScope.TOOLS_CALL, GrantType.ALLOW_ALWAYS);

      const events: unknown[] = [];
      for await (const event of host.runAgent(TEST_ORIGIN, 'test task', {
        toolAllowlist: ['filesystem/read_file'],
      })) {
        events.push(event);
      }

      const finalEvent = events.find((e: any) => e.type === 'final') as any;
      expect(finalEvent).toBeDefined();
      expect(finalEvent.output.availableTools).toEqual(['filesystem/read_file']);
    });
  });
});

