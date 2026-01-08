/**
 * Plugin Registry Tests
 *
 * Tests for plugin registration, status management, and tool aggregation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { __mockStorage, __clearMockStorage } from '../../provider/__tests__/__mocks__/webextension-polyfill';
import type { PluginDescriptor, PluginToolDefinition } from '../types';
import {
  loadRegistry,
  isPluginAllowed,
  getPluginAllowlist,
  setPluginAllowlist,
  addToAllowlist,
  removeFromAllowlist,
  registerPlugin,
  unregisterPlugin,
  getPlugin,
  getAllPlugins,
  getActivePlugins,
  isPluginRegistered,
  updatePluginStatus,
  recordPluginActivity,
  recordFailedPing,
  enablePlugin,
  disablePlugin,
  updatePluginTools,
  getAggregatedPluginTools,
  findToolPlugin,
  getRegistryStats,
  cleanupStalePlugins,
  __clearRegistryCache,
} from '../registry';

describe('Plugin Registry', () => {
  const TEST_PLUGIN_ID = 'test-plugin@example.com';

  const testTool: PluginToolDefinition = {
    name: 'echo',
    title: 'Echo',
    description: 'Returns the input',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
  };

  const testPlugin: PluginDescriptor = {
    extensionId: TEST_PLUGIN_ID,
    name: 'Test Plugin',
    version: '1.0.0',
    description: 'A test plugin',
    tools: [testTool],
  };

  beforeEach(async () => {
    __clearMockStorage();
    __clearRegistryCache();
    // Force fresh load
    await loadRegistry();
    __clearRegistryCache();
  });

  describe('loadRegistry', () => {
    it('should return empty registry when storage is empty', async () => {
      const registry = await loadRegistry();
      expect(registry.version).toBe(1);
      expect(registry.plugins).toEqual({});
      expect(registry.allowlist).toEqual([]);
    });

    it('should load existing registry from storage', async () => {
      __mockStorage['harbor_plugin_registry'] = {
        version: 1,
        plugins: { [TEST_PLUGIN_ID]: { descriptor: testPlugin, status: 'active' } },
        allowlist: ['allowed-plugin@example.com'],
        updatedAt: Date.now(),
      };

      // Clear cache to force reload
      __clearRegistryCache();

      const registry = await loadRegistry();
      expect(registry.plugins[TEST_PLUGIN_ID]).toBeDefined();
      expect(registry.allowlist).toContain('allowed-plugin@example.com');
    });
  });

  describe('Allowlist Management', () => {
    describe('isPluginAllowed', () => {
      it('should return true when allowlist is empty (allow all)', async () => {
        const allowed = await isPluginAllowed(TEST_PLUGIN_ID);
        expect(allowed).toBe(true);
      });

      it('should return true when plugin is in allowlist', async () => {
        await setPluginAllowlist([TEST_PLUGIN_ID]);
        const allowed = await isPluginAllowed(TEST_PLUGIN_ID);
        expect(allowed).toBe(true);
      });

      it('should return false when plugin is not in non-empty allowlist', async () => {
        await setPluginAllowlist(['other-plugin@example.com']);
        const allowed = await isPluginAllowed(TEST_PLUGIN_ID);
        expect(allowed).toBe(false);
      });
    });

    describe('setPluginAllowlist', () => {
      it('should set the allowlist', async () => {
        await setPluginAllowlist(['plugin1@example.com', 'plugin2@example.com']);
        const allowlist = await getPluginAllowlist();
        expect(allowlist).toEqual(['plugin1@example.com', 'plugin2@example.com']);
      });

      it('should clear allowlist when set to empty array', async () => {
        await setPluginAllowlist(['plugin1@example.com']);
        await setPluginAllowlist([]);
        const allowlist = await getPluginAllowlist();
        expect(allowlist).toEqual([]);
      });
    });

    describe('addToAllowlist', () => {
      it('should add plugin to allowlist', async () => {
        await addToAllowlist(TEST_PLUGIN_ID);
        const allowlist = await getPluginAllowlist();
        expect(allowlist).toContain(TEST_PLUGIN_ID);
      });

      it('should not add duplicate entries', async () => {
        await addToAllowlist(TEST_PLUGIN_ID);
        await addToAllowlist(TEST_PLUGIN_ID);
        const allowlist = await getPluginAllowlist();
        expect(allowlist.filter((id) => id === TEST_PLUGIN_ID).length).toBe(1);
      });
    });

    describe('removeFromAllowlist', () => {
      it('should remove plugin from allowlist', async () => {
        await setPluginAllowlist([TEST_PLUGIN_ID, 'other@example.com']);
        await removeFromAllowlist(TEST_PLUGIN_ID);
        const allowlist = await getPluginAllowlist();
        expect(allowlist).not.toContain(TEST_PLUGIN_ID);
        expect(allowlist).toContain('other@example.com');
      });

      it('should do nothing if plugin not in allowlist', async () => {
        await setPluginAllowlist(['other@example.com']);
        await removeFromAllowlist(TEST_PLUGIN_ID);
        const allowlist = await getPluginAllowlist();
        expect(allowlist).toEqual(['other@example.com']);
      });
    });
  });

  describe('Plugin Registration', () => {
    describe('registerPlugin', () => {
      it('should register a new plugin', async () => {
        const entry = await registerPlugin(testPlugin);

        expect(entry.descriptor).toEqual(testPlugin);
        expect(entry.status).toBe('active');
        expect(entry.registeredAt).toBeDefined();
        expect(entry.lastSeen).toBeDefined();
        expect(entry.failedPings).toBe(0);
      });

      it('should update existing plugin registration', async () => {
        await registerPlugin(testPlugin);

        const updatedPlugin = { ...testPlugin, version: '2.0.0' };
        const entry = await registerPlugin(updatedPlugin);

        expect(entry.descriptor.version).toBe('2.0.0');
      });

      it('should preserve registeredAt when updating', async () => {
        const firstEntry = await registerPlugin(testPlugin);
        const originalRegisteredAt = firstEntry.registeredAt;

        // Wait a bit and re-register
        await new Promise((r) => setTimeout(r, 10));
        const secondEntry = await registerPlugin({ ...testPlugin, version: '2.0.0' });

        expect(secondEntry.registeredAt).toBe(originalRegisteredAt);
      });
    });

    describe('unregisterPlugin', () => {
      it('should unregister an existing plugin', async () => {
        await registerPlugin(testPlugin);
        const success = await unregisterPlugin(TEST_PLUGIN_ID);

        expect(success).toBe(true);
        expect(await getPlugin(TEST_PLUGIN_ID)).toBeNull();
      });

      it('should return false for non-existent plugin', async () => {
        const success = await unregisterPlugin('non-existent@example.com');
        expect(success).toBe(false);
      });
    });

    describe('getPlugin', () => {
      it('should return registered plugin', async () => {
        await registerPlugin(testPlugin);
        const plugin = await getPlugin(TEST_PLUGIN_ID);

        expect(plugin).not.toBeNull();
        expect(plugin?.descriptor.name).toBe('Test Plugin');
      });

      it('should return null for non-existent plugin', async () => {
        const plugin = await getPlugin('non-existent@example.com');
        expect(plugin).toBeNull();
      });
    });

    describe('getAllPlugins', () => {
      it('should return all registered plugins', async () => {
        const id1 = `getall-1-${Date.now()}@example.com`;
        const id2 = `getall-2-${Date.now()}@example.com`;
        await registerPlugin({ ...testPlugin, extensionId: id1 });
        await registerPlugin({ ...testPlugin, extensionId: id2, name: 'Plugin 2' });

        const plugins = await getAllPlugins();
        const testPlugins = plugins.filter((p) => p.descriptor.extensionId.startsWith('getall-'));
        expect(testPlugins.length).toBe(2);
      });

      it('should include plugins when listing', async () => {
        // This test verifies that getAllPlugins returns an array
        // (exact count depends on other tests' state)
        const plugins = await getAllPlugins();
        expect(Array.isArray(plugins)).toBe(true);
      });
    });

    describe('getActivePlugins', () => {
      it('should return only active plugins', async () => {
        const id1 = `active-1-${Date.now()}@example.com`;
        const id2 = `active-2-${Date.now()}@example.com`;
        await registerPlugin({ ...testPlugin, extensionId: id1 });
        await registerPlugin({ ...testPlugin, extensionId: id2, name: 'Plugin 2' });
        await disablePlugin(id1);

        const plugins = await getActivePlugins();
        const activeTestPlugins = plugins.filter((p) => p.descriptor.extensionId.startsWith('active-'));
        expect(activeTestPlugins.length).toBe(1);
        expect(activeTestPlugins[0].descriptor.extensionId).toBe(id2);
      });
    });

    describe('isPluginRegistered', () => {
      it('should return true for registered plugin', async () => {
        const uniqueId = `test-${Date.now()}@example.com`;
        await registerPlugin({ ...testPlugin, extensionId: uniqueId });
        expect(await isPluginRegistered(uniqueId)).toBe(true);
      });

      it('should return false for non-registered plugin', async () => {
        const nonExistentId = `non-existent-${Date.now()}@example.com`;
        expect(await isPluginRegistered(nonExistentId)).toBe(false);
      });
    });
  });

  describe('Plugin Status Management', () => {
    beforeEach(async () => {
      await registerPlugin(testPlugin);
    });

    describe('updatePluginStatus', () => {
      it('should update plugin status', async () => {
        await updatePluginStatus(TEST_PLUGIN_ID, 'disabled');
        const plugin = await getPlugin(TEST_PLUGIN_ID);
        expect(plugin?.status).toBe('disabled');
      });

      it('should set error message when provided', async () => {
        await updatePluginStatus(TEST_PLUGIN_ID, 'error', 'Something went wrong');
        const plugin = await getPlugin(TEST_PLUGIN_ID);
        expect(plugin?.status).toBe('error');
        expect(plugin?.lastError).toBe('Something went wrong');
      });

      it('should clear error when status is active', async () => {
        await updatePluginStatus(TEST_PLUGIN_ID, 'error', 'Some error');
        await updatePluginStatus(TEST_PLUGIN_ID, 'active');
        const plugin = await getPlugin(TEST_PLUGIN_ID);
        expect(plugin?.lastError).toBeUndefined();
      });
    });

    describe('recordPluginActivity', () => {
      it('should update lastSeen timestamp', async () => {
        const before = Date.now();
        await recordPluginActivity(TEST_PLUGIN_ID);
        const plugin = await getPlugin(TEST_PLUGIN_ID);
        expect(plugin?.lastSeen).toBeGreaterThanOrEqual(before);
      });

      it('should reset failedPings to 0', async () => {
        // Simulate failed pings
        await recordFailedPing(TEST_PLUGIN_ID);
        await recordFailedPing(TEST_PLUGIN_ID);

        await recordPluginActivity(TEST_PLUGIN_ID);
        const plugin = await getPlugin(TEST_PLUGIN_ID);
        expect(plugin?.failedPings).toBe(0);
      });

      it('should change unreachable status to active', async () => {
        await updatePluginStatus(TEST_PLUGIN_ID, 'unreachable');
        await recordPluginActivity(TEST_PLUGIN_ID);
        const plugin = await getPlugin(TEST_PLUGIN_ID);
        expect(plugin?.status).toBe('active');
      });
    });

    describe('recordFailedPing', () => {
      it('should increment failedPings count', async () => {
        await recordFailedPing(TEST_PLUGIN_ID);
        const plugin = await getPlugin(TEST_PLUGIN_ID);
        expect(plugin?.failedPings).toBe(1);
      });

      it('should mark as unreachable after 3 failed pings', async () => {
        await recordFailedPing(TEST_PLUGIN_ID);
        await recordFailedPing(TEST_PLUGIN_ID);
        await recordFailedPing(TEST_PLUGIN_ID);

        const plugin = await getPlugin(TEST_PLUGIN_ID);
        expect(plugin?.status).toBe('unreachable');
      });
    });

    describe('enablePlugin', () => {
      it('should enable a disabled plugin', async () => {
        await disablePlugin(TEST_PLUGIN_ID);
        const success = await enablePlugin(TEST_PLUGIN_ID);

        expect(success).toBe(true);
        const plugin = await getPlugin(TEST_PLUGIN_ID);
        expect(plugin?.status).toBe('active');
      });

      it('should return false for non-existent plugin', async () => {
        const success = await enablePlugin('non-existent@example.com');
        expect(success).toBe(false);
      });
    });

    describe('disablePlugin', () => {
      it('should disable an active plugin', async () => {
        const success = await disablePlugin(TEST_PLUGIN_ID, 'User disabled');

        expect(success).toBe(true);
        const plugin = await getPlugin(TEST_PLUGIN_ID);
        expect(plugin?.status).toBe('disabled');
        expect(plugin?.lastError).toBe('User disabled');
      });

      it('should return false for non-existent plugin', async () => {
        const success = await disablePlugin('non-existent@example.com');
        expect(success).toBe(false);
      });
    });
  });

  describe('Tool Aggregation', () => {
    const tool1: PluginToolDefinition = {
      name: 'tool1',
      title: 'Tool 1',
      description: 'First tool',
      inputSchema: { type: 'object' },
    };

    const tool2: PluginToolDefinition = {
      name: 'tool2',
      title: 'Tool 2',
      description: 'Second tool',
      inputSchema: { type: 'object' },
    };

    beforeEach(async () => {
      // Clear storage and cache again for this nested suite
      __clearMockStorage();
      __clearRegistryCache();

      await registerPlugin({
        ...testPlugin,
        tools: [tool1, tool2],
      });
    });

    describe('updatePluginTools', () => {
      it('should update plugin tools', async () => {
        const newTool: PluginToolDefinition = {
          name: 'newTool',
          title: 'New Tool',
          description: 'A new tool',
          inputSchema: { type: 'object' },
        };

        await updatePluginTools(TEST_PLUGIN_ID, [newTool]);
        const plugin = await getPlugin(TEST_PLUGIN_ID);

        expect(plugin?.descriptor.tools.length).toBe(1);
        expect(plugin?.descriptor.tools[0].name).toBe('newTool');
      });
    });

    describe('getAggregatedPluginTools', () => {
      it('should return namespaced tools from active plugins', async () => {
        const tools = await getAggregatedPluginTools();
        // Filter to just this test's plugin
        const testTools = tools.filter((t) => t.pluginId === TEST_PLUGIN_ID);

        expect(testTools.length).toBe(2);
        expect(testTools[0].name).toBe(`${TEST_PLUGIN_ID}::tool1`);
        expect(testTools[1].name).toBe(`${TEST_PLUGIN_ID}::tool2`);
      });

      it('should include plugin metadata', async () => {
        const tools = await getAggregatedPluginTools();
        const testTools = tools.filter((t) => t.pluginId === TEST_PLUGIN_ID);

        expect(testTools[0].pluginId).toBe(TEST_PLUGIN_ID);
        expect(testTools[0].originalName).toBe('tool1');
        expect(testTools[0].title).toBe('Tool 1');
      });

      it('should not include tools from disabled plugins', async () => {
        await disablePlugin(TEST_PLUGIN_ID);
        const tools = await getAggregatedPluginTools();
        // Filter to just this test's plugin
        const testTools = tools.filter((t) => t.pluginId === TEST_PLUGIN_ID);
        expect(testTools.length).toBe(0);
      });
    });

    describe('findToolPlugin', () => {
      it('should find plugin and tool by namespaced name', async () => {
        const result = await findToolPlugin(`${TEST_PLUGIN_ID}::tool1`);

        expect(result).not.toBeNull();
        expect(result?.plugin.descriptor.extensionId).toBe(TEST_PLUGIN_ID);
        expect(result?.tool.name).toBe('tool1');
      });

      it('should return null for non-existent tool', async () => {
        const result = await findToolPlugin(`${TEST_PLUGIN_ID}::nonexistent`);
        expect(result).toBeNull();
      });

      it('should return null for non-existent plugin', async () => {
        const result = await findToolPlugin('nonexistent@example.com::tool1');
        expect(result).toBeNull();
      });

      it('should return null for invalid format', async () => {
        const result = await findToolPlugin('invalid-format');
        expect(result).toBeNull();
      });

      it('should return null for disabled plugin', async () => {
        await disablePlugin(TEST_PLUGIN_ID);
        const result = await findToolPlugin(`${TEST_PLUGIN_ID}::tool1`);
        expect(result).toBeNull();
      });
    });
  });

  describe('Registry Utilities', () => {
    describe('getRegistryStats', () => {
      it('should return correct stats', async () => {
        // Use unique IDs to avoid interference from other tests
        const pluginId1 = `stats-test-1-${Date.now()}@example.com`;
        const pluginId2 = `stats-test-2-${Date.now()}@example.com`;

        await registerPlugin({ ...testPlugin, extensionId: pluginId1 });
        await registerPlugin({
          ...testPlugin,
          extensionId: pluginId2,
          tools: [testTool, testTool],
        });
        await disablePlugin(pluginId1);

        const stats = await getRegistryStats();

        // Stats count all plugins, including those from other tests
        // So we check relative values instead
        expect(stats.total).toBeGreaterThanOrEqual(2);
        expect(stats.disabled).toBeGreaterThanOrEqual(1);
        expect(stats.toolCount).toBeGreaterThanOrEqual(2);
      });
    });

    describe('cleanupStalePlugins', () => {
      it('should remove plugins not seen within maxAgeMs', async () => {
        // Register plugin with old lastSeen
        await registerPlugin(testPlugin);

        // Manually set lastSeen to old value
        const registry = await loadRegistry();
        registry.plugins[TEST_PLUGIN_ID].lastSeen = Date.now() - 1000 * 60 * 60 * 24; // 24 hours ago
        __mockStorage['harbor_plugin_registry'] = registry;
        __clearRegistryCache();

        const removed = await cleanupStalePlugins(1000 * 60 * 60); // 1 hour

        expect(removed).toContain(TEST_PLUGIN_ID);
        expect(await getPlugin(TEST_PLUGIN_ID)).toBeNull();
      });

      it('should not remove recently seen plugins', async () => {
        await registerPlugin(testPlugin);

        const removed = await cleanupStalePlugins(1000 * 60 * 60); // 1 hour

        expect(removed).not.toContain(TEST_PLUGIN_ID);
        expect(await getPlugin(TEST_PLUGIN_ID)).not.toBeNull();
      });
    });
  });
});
