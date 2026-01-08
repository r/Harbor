/**
 * Harbor Plugin System - Registry
 *
 * Manages plugin registration, persistence, and status tracking.
 * Plugins are stored in browser.storage.local for persistence across sessions.
 */

import browser from 'webextension-polyfill';
import type {
  PluginDescriptor,
  PluginRegistryEntry,
  StoredPluginRegistry,
  PluginStatus,
  AggregatedPluginTool,
  PluginToolDefinition,
} from './types';
import { createToolNamespace } from './types';

// Storage key for the plugin registry
const REGISTRY_STORAGE_KEY = 'harbor_plugin_registry';

// Default empty registry
const DEFAULT_REGISTRY: StoredPluginRegistry = {
  version: 1,
  plugins: {},
  allowlist: [],
  updatedAt: Date.now(),
};

// In-memory cache of the registry
let registryCache: StoredPluginRegistry | null = null;

// =============================================================================
// Storage Operations
// =============================================================================

/**
 * Load the plugin registry from storage.
 */
export async function loadRegistry(): Promise<StoredPluginRegistry> {
  if (registryCache) {
    return registryCache;
  }

  try {
    const result = await browser.storage.local.get(REGISTRY_STORAGE_KEY);
    const stored = result[REGISTRY_STORAGE_KEY] as StoredPluginRegistry | undefined;

    if (stored && stored.version === 1) {
      registryCache = stored;
      return stored;
    }
  } catch (err) {
    console.error('[PluginRegistry] Failed to load registry:', err);
  }

  // Return default if not found or invalid
  registryCache = { ...DEFAULT_REGISTRY };
  return registryCache;
}

/**
 * Save the plugin registry to storage.
 */
async function saveRegistry(registry: StoredPluginRegistry): Promise<void> {
  registry.updatedAt = Date.now();
  registryCache = registry;

  try {
    await browser.storage.local.set({ [REGISTRY_STORAGE_KEY]: registry });
  } catch (err) {
    console.error('[PluginRegistry] Failed to save registry:', err);
    throw err;
  }
}

/**
 * Clear the registry cache (for testing).
 * @internal
 */
export function __clearRegistryCache(): void {
  registryCache = null;
}

// =============================================================================
// Allowlist Management
// =============================================================================

/**
 * Check if a plugin extension ID is allowed.
 */
export async function isPluginAllowed(extensionId: string): Promise<boolean> {
  const registry = await loadRegistry();

  // If allowlist is empty, all plugins are allowed
  if (registry.allowlist.length === 0) {
    return true;
  }

  return registry.allowlist.includes(extensionId);
}

/**
 * Get the current allowlist.
 */
export async function getPluginAllowlist(): Promise<string[]> {
  const registry = await loadRegistry();
  return registry.allowlist;
}

/**
 * Set the plugin allowlist.
 */
export async function setPluginAllowlist(extensionIds: string[]): Promise<void> {
  const registry = await loadRegistry();
  registry.allowlist = extensionIds;
  await saveRegistry(registry);
}

/**
 * Add an extension ID to the allowlist.
 */
export async function addToAllowlist(extensionId: string): Promise<void> {
  const registry = await loadRegistry();
  if (!registry.allowlist.includes(extensionId)) {
    registry.allowlist.push(extensionId);
    await saveRegistry(registry);
  }
}

/**
 * Remove an extension ID from the allowlist.
 */
export async function removeFromAllowlist(extensionId: string): Promise<void> {
  const registry = await loadRegistry();
  const index = registry.allowlist.indexOf(extensionId);
  if (index !== -1) {
    registry.allowlist.splice(index, 1);
    await saveRegistry(registry);
  }
}

// =============================================================================
// Plugin Registration
// =============================================================================

/**
 * Register a new plugin or update an existing one.
 */
export async function registerPlugin(descriptor: PluginDescriptor): Promise<PluginRegistryEntry> {
  const registry = await loadRegistry();
  const now = Date.now();

  const existing = registry.plugins[descriptor.extensionId];

  const entry: PluginRegistryEntry = {
    descriptor,
    status: 'active',
    lastSeen: now,
    registeredAt: existing?.registeredAt ?? now,
    failedPings: 0,
  };

  registry.plugins[descriptor.extensionId] = entry;
  await saveRegistry(registry);

  console.log('[PluginRegistry] Registered plugin:', descriptor.extensionId, descriptor.name);
  return entry;
}

/**
 * Unregister a plugin.
 */
export async function unregisterPlugin(extensionId: string): Promise<boolean> {
  const registry = await loadRegistry();

  if (!registry.plugins[extensionId]) {
    return false;
  }

  delete registry.plugins[extensionId];
  await saveRegistry(registry);

  console.log('[PluginRegistry] Unregistered plugin:', extensionId);
  return true;
}

/**
 * Get a plugin by extension ID.
 */
export async function getPlugin(extensionId: string): Promise<PluginRegistryEntry | null> {
  const registry = await loadRegistry();
  return registry.plugins[extensionId] ?? null;
}

/**
 * Get all registered plugins.
 */
export async function getAllPlugins(): Promise<PluginRegistryEntry[]> {
  const registry = await loadRegistry();
  return Object.values(registry.plugins);
}

/**
 * Get all active plugins.
 */
export async function getActivePlugins(): Promise<PluginRegistryEntry[]> {
  const registry = await loadRegistry();
  return Object.values(registry.plugins).filter((p) => p.status === 'active');
}

/**
 * Check if a plugin is registered.
 */
export async function isPluginRegistered(extensionId: string): Promise<boolean> {
  const registry = await loadRegistry();
  return extensionId in registry.plugins;
}

// =============================================================================
// Plugin Status Management
// =============================================================================

/**
 * Update a plugin's status.
 */
export async function updatePluginStatus(
  extensionId: string,
  status: PluginStatus,
  error?: string
): Promise<void> {
  const registry = await loadRegistry();
  const plugin = registry.plugins[extensionId];

  if (!plugin) {
    console.warn('[PluginRegistry] Cannot update status for unknown plugin:', extensionId);
    return;
  }

  plugin.status = status;
  plugin.lastSeen = Date.now();

  if (error) {
    plugin.lastError = error;
  } else if (status === 'active') {
    delete plugin.lastError;
    plugin.failedPings = 0;
  }

  await saveRegistry(registry);
}

/**
 * Record a successful interaction with a plugin.
 */
export async function recordPluginActivity(extensionId: string): Promise<void> {
  const registry = await loadRegistry();
  const plugin = registry.plugins[extensionId];

  if (plugin) {
    plugin.lastSeen = Date.now();
    plugin.failedPings = 0;

    if (plugin.status === 'unreachable') {
      plugin.status = 'active';
    }

    await saveRegistry(registry);
  }
}

/**
 * Record a failed ping attempt.
 */
export async function recordFailedPing(extensionId: string): Promise<void> {
  const registry = await loadRegistry();
  const plugin = registry.plugins[extensionId];

  if (plugin) {
    plugin.failedPings++;

    // Mark as unreachable after 3 failed pings
    if (plugin.failedPings >= 3 && plugin.status === 'active') {
      plugin.status = 'unreachable';
      console.warn('[PluginRegistry] Plugin marked as unreachable:', extensionId);
    }

    await saveRegistry(registry);
  }
}

/**
 * Enable a disabled plugin.
 */
export async function enablePlugin(extensionId: string): Promise<boolean> {
  const registry = await loadRegistry();
  const plugin = registry.plugins[extensionId];

  if (!plugin) {
    return false;
  }

  plugin.status = 'active';
  plugin.failedPings = 0;
  delete plugin.lastError;

  await saveRegistry(registry);
  return true;
}

/**
 * Disable a plugin.
 */
export async function disablePlugin(extensionId: string, reason?: string): Promise<boolean> {
  const registry = await loadRegistry();
  const plugin = registry.plugins[extensionId];

  if (!plugin) {
    return false;
  }

  plugin.status = 'disabled';
  if (reason) {
    plugin.lastError = reason;
  }

  await saveRegistry(registry);
  return true;
}

// =============================================================================
// Tool Aggregation
// =============================================================================

/**
 * Update a plugin's tool list.
 */
export async function updatePluginTools(
  extensionId: string,
  tools: PluginToolDefinition[]
): Promise<void> {
  const registry = await loadRegistry();
  const plugin = registry.plugins[extensionId];

  if (!plugin) {
    console.warn('[PluginRegistry] Cannot update tools for unknown plugin:', extensionId);
    return;
  }

  plugin.descriptor.tools = tools;
  plugin.lastSeen = Date.now();
  await saveRegistry(registry);
}

/**
 * Get all tools from all active plugins.
 */
export async function getAggregatedPluginTools(): Promise<AggregatedPluginTool[]> {
  const plugins = await getActivePlugins();
  const tools: AggregatedPluginTool[] = [];

  for (const plugin of plugins) {
    for (const tool of plugin.descriptor.tools) {
      tools.push({
        name: createToolNamespace(plugin.descriptor.extensionId, tool.name),
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        pluginId: plugin.descriptor.extensionId,
        originalName: tool.name,
      });
    }
  }

  return tools;
}

/**
 * Find which plugin owns a namespaced tool.
 */
export async function findToolPlugin(
  namespacedToolName: string
): Promise<{ plugin: PluginRegistryEntry; tool: PluginToolDefinition } | null> {
  // Parse namespace
  const separatorIndex = namespacedToolName.indexOf('::');
  if (separatorIndex === -1) {
    return null;
  }

  const pluginId = namespacedToolName.slice(0, separatorIndex);
  const toolName = namespacedToolName.slice(separatorIndex + 2);

  const plugin = await getPlugin(pluginId);
  if (!plugin || plugin.status !== 'active') {
    return null;
  }

  const tool = plugin.descriptor.tools.find((t) => t.name === toolName);
  if (!tool) {
    return null;
  }

  return { plugin, tool };
}

// =============================================================================
// Registry Utilities
// =============================================================================

/**
 * Get registry statistics.
 */
export async function getRegistryStats(): Promise<{
  total: number;
  active: number;
  disabled: number;
  unreachable: number;
  error: number;
  toolCount: number;
}> {
  const plugins = await getAllPlugins();

  let active = 0;
  let disabled = 0;
  let unreachable = 0;
  let error = 0;
  let toolCount = 0;

  for (const plugin of plugins) {
    switch (plugin.status) {
      case 'active':
        active++;
        toolCount += plugin.descriptor.tools.length;
        break;
      case 'disabled':
        disabled++;
        break;
      case 'unreachable':
        unreachable++;
        break;
      case 'error':
        error++;
        break;
    }
  }

  return {
    total: plugins.length,
    active,
    disabled,
    unreachable,
    error,
    toolCount,
  };
}

/**
 * Clean up stale plugins (not seen in a long time).
 */
export async function cleanupStalePlugins(maxAgeMs: number): Promise<string[]> {
  const registry = await loadRegistry();
  const now = Date.now();
  const removed: string[] = [];

  for (const [extensionId, plugin] of Object.entries(registry.plugins)) {
    if (now - plugin.lastSeen > maxAgeMs) {
      delete registry.plugins[extensionId];
      removed.push(extensionId);
    }
  }

  if (removed.length > 0) {
    await saveRegistry(registry);
    console.log('[PluginRegistry] Cleaned up stale plugins:', removed);
  }

  return removed;
}
