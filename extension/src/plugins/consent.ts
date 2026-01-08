/**
 * Harbor Plugin System - Consent Management
 *
 * Extends the existing permission system to support plugin tools.
 * Consent is controlled by the hub (not plugins) on a per-origin basis.
 */

import browser from 'webextension-polyfill';
import type { AggregatedPluginTool } from './types';
import { parseToolNamespace, createToolNamespace } from './types';
import { getAggregatedPluginTools, findToolPlugin } from './registry';

// Storage key for plugin tool permissions
const PLUGIN_PERMISSIONS_STORAGE_KEY = 'harbor_plugin_permissions';

// Temporary grants (in-memory with TTL)
const temporaryPluginGrants = new Map<string, PluginGrantEntry>();

// TTL for "once" grants (10 minutes, matching existing provider permissions)
const ONCE_GRANT_TTL_MS = 10 * 60 * 1000;

// =============================================================================
// Types
// =============================================================================

export type PluginConsentGrant = 'granted-once' | 'granted-always' | 'denied' | 'not-granted';

/**
 * Stored permission entry for an origin's access to plugin tools.
 */
export interface PluginPermissionEntry {
  /** All plugin tools allowed (if true, allowedTools is ignored) */
  allowAll: boolean;
  /** Specific plugin tools allowed (namespaced: pluginId::toolName) */
  allowedTools: string[];
  /** When this permission was last updated */
  updatedAt: number;
}

/**
 * Stored plugin permissions by origin.
 */
export interface StoredPluginPermissions {
  /** Version for migration */
  version: 1;
  /** Map of origin -> permission entry */
  permissions: Record<string, PluginPermissionEntry>;
}

/**
 * Temporary grant entry (for "allow once" grants).
 */
interface PluginGrantEntry {
  origin: string;
  allowAll: boolean;
  allowedTools: string[];
  grantedAt: number;
  expiresAt: number;
  tabId?: number;
}

// =============================================================================
// Storage Operations
// =============================================================================

/**
 * Load plugin permissions from storage.
 */
async function loadPluginPermissions(): Promise<StoredPluginPermissions> {
  try {
    const result = await browser.storage.local.get(PLUGIN_PERMISSIONS_STORAGE_KEY);
    const stored = result[PLUGIN_PERMISSIONS_STORAGE_KEY] as StoredPluginPermissions | undefined;

    if (stored && stored.version === 1) {
      return stored;
    }
  } catch (err) {
    console.error('[PluginConsent] Failed to load permissions:', err);
  }

  return { version: 1, permissions: {} };
}

/**
 * Save plugin permissions to storage.
 */
async function savePluginPermissions(permissions: StoredPluginPermissions): Promise<void> {
  try {
    await browser.storage.local.set({ [PLUGIN_PERMISSIONS_STORAGE_KEY]: permissions });
  } catch (err) {
    console.error('[PluginConsent] Failed to save permissions:', err);
    throw err;
  }
}

// =============================================================================
// Grant Cleanup
// =============================================================================

/**
 * Clean up expired temporary grants.
 */
function cleanupExpiredGrants(): void {
  const now = Date.now();
  for (const [key, grant] of temporaryPluginGrants) {
    if (grant.expiresAt < now) {
      temporaryPluginGrants.delete(key);
    }
  }
}

// Run cleanup periodically
setInterval(cleanupExpiredGrants, 60000);

/**
 * Get temporary grant key for an origin.
 */
function getTempKey(origin: string): string {
  return `plugin-temp:${origin}`;
}

// =============================================================================
// Permission Checking
// =============================================================================

/**
 * Check if an origin has permission to call a specific plugin tool.
 */
export async function hasPluginToolPermission(
  origin: string,
  namespacedToolName: string
): Promise<boolean> {
  // Extension pages always have full access
  if (origin === 'extension') {
    return true;
  }

  cleanupExpiredGrants();

  // Check temporary grants first
  const tempGrant = temporaryPluginGrants.get(getTempKey(origin));
  if (tempGrant && tempGrant.expiresAt > Date.now()) {
    if (tempGrant.allowAll) {
      return true;
    }
    if (tempGrant.allowedTools.includes(namespacedToolName)) {
      return true;
    }
  }

  // Check persistent permissions
  const stored = await loadPluginPermissions();
  const entry = stored.permissions[origin];

  if (!entry) {
    return false;
  }

  if (entry.allowAll) {
    return true;
  }

  return entry.allowedTools.includes(namespacedToolName);
}

/**
 * Check if an origin has any plugin tool permissions.
 */
export async function hasAnyPluginPermission(origin: string): Promise<boolean> {
  if (origin === 'extension') {
    return true;
  }

  cleanupExpiredGrants();

  // Check temporary grants
  const tempGrant = temporaryPluginGrants.get(getTempKey(origin));
  if (tempGrant && tempGrant.expiresAt > Date.now()) {
    if (tempGrant.allowAll || tempGrant.allowedTools.length > 0) {
      return true;
    }
  }

  // Check persistent permissions
  const stored = await loadPluginPermissions();
  const entry = stored.permissions[origin];

  if (!entry) {
    return false;
  }

  return entry.allowAll || entry.allowedTools.length > 0;
}

/**
 * Get all allowed plugin tools for an origin.
 */
export async function getAllowedPluginTools(
  origin: string
): Promise<{ allowAll: boolean; tools: string[] }> {
  if (origin === 'extension') {
    return { allowAll: true, tools: [] };
  }

  cleanupExpiredGrants();

  // Combine temporary and persistent grants
  const tempGrant = temporaryPluginGrants.get(getTempKey(origin));
  const stored = await loadPluginPermissions();
  const entry = stored.permissions[origin];

  // If either grants all, return allowAll
  if (tempGrant?.allowAll || entry?.allowAll) {
    return { allowAll: true, tools: [] };
  }

  // Combine allowed tools from both
  const tools = new Set<string>();

  if (tempGrant && tempGrant.expiresAt > Date.now()) {
    for (const tool of tempGrant.allowedTools) {
      tools.add(tool);
    }
  }

  if (entry) {
    for (const tool of entry.allowedTools) {
      tools.add(tool);
    }
  }

  return { allowAll: false, tools: Array.from(tools) };
}

/**
 * Get the consent status for an origin.
 */
export async function getPluginConsentStatus(
  origin: string
): Promise<{
  hasConsent: boolean;
  allowAll: boolean;
  allowedTools: string[];
  grantType: 'once' | 'always' | 'none';
}> {
  cleanupExpiredGrants();

  const tempGrant = temporaryPluginGrants.get(getTempKey(origin));
  const stored = await loadPluginPermissions();
  const entry = stored.permissions[origin];

  // Check temporary first
  if (tempGrant && tempGrant.expiresAt > Date.now()) {
    return {
      hasConsent: tempGrant.allowAll || tempGrant.allowedTools.length > 0,
      allowAll: tempGrant.allowAll,
      allowedTools: tempGrant.allowedTools,
      grantType: 'once',
    };
  }

  // Check persistent
  if (entry) {
    return {
      hasConsent: entry.allowAll || entry.allowedTools.length > 0,
      allowAll: entry.allowAll,
      allowedTools: entry.allowedTools,
      grantType: 'always',
    };
  }

  return {
    hasConsent: false,
    allowAll: false,
    allowedTools: [],
    grantType: 'none',
  };
}

// =============================================================================
// Permission Granting
// =============================================================================

/**
 * Grant plugin tool permission to an origin.
 */
export async function grantPluginPermission(
  origin: string,
  options: {
    mode: 'once' | 'always';
    allowAll?: boolean;
    tools?: string[];
    tabId?: number;
  }
): Promise<void> {
  const { mode, allowAll = false, tools = [], tabId } = options;

  if (mode === 'once') {
    // Store as temporary grant
    const existing = temporaryPluginGrants.get(getTempKey(origin));

    temporaryPluginGrants.set(getTempKey(origin), {
      origin,
      allowAll: allowAll || existing?.allowAll || false,
      allowedTools: [...new Set([...(existing?.allowedTools || []), ...tools])],
      grantedAt: Date.now(),
      expiresAt: Date.now() + ONCE_GRANT_TTL_MS,
      tabId: tabId ?? existing?.tabId,
    });
  } else {
    // Store persistently
    const stored = await loadPluginPermissions();
    const existing = stored.permissions[origin];

    stored.permissions[origin] = {
      allowAll: allowAll || existing?.allowAll || false,
      allowedTools: [...new Set([...(existing?.allowedTools || []), ...tools])],
      updatedAt: Date.now(),
    };

    await savePluginPermissions(stored);
  }

  console.log('[PluginConsent] Permission granted:', origin, mode, { allowAll, tools });
}

/**
 * Revoke all plugin permissions for an origin.
 */
export async function revokePluginPermissions(origin: string): Promise<void> {
  // Remove temporary grant
  temporaryPluginGrants.delete(getTempKey(origin));

  // Remove persistent permissions
  const stored = await loadPluginPermissions();
  delete stored.permissions[origin];
  await savePluginPermissions(stored);

  console.log('[PluginConsent] Permissions revoked for:', origin);
}

/**
 * Clear temporary grants for a tab (when tab closes).
 */
export function clearPluginTabGrants(tabId: number): void {
  for (const [key, grant] of temporaryPluginGrants) {
    if (grant.tabId === tabId) {
      temporaryPluginGrants.delete(key);
    }
  }
}

// =============================================================================
// Consent Flow
// =============================================================================

/**
 * Request consent for plugin tools.
 * Returns true if consent was already granted, false if UI prompt is needed.
 */
export async function checkPluginConsent(
  origin: string,
  requestedTools?: string[]
): Promise<{
  granted: boolean;
  missingTools: string[];
}> {
  // Extension pages don't need consent
  if (origin === 'extension') {
    return { granted: true, missingTools: [] };
  }

  const status = await getPluginConsentStatus(origin);

  // If allowAll is granted, everything is allowed
  if (status.allowAll) {
    return { granted: true, missingTools: [] };
  }

  // If no specific tools requested, check if any consent exists
  if (!requestedTools || requestedTools.length === 0) {
    return {
      granted: status.hasConsent,
      missingTools: [],
    };
  }

  // Check which specific tools are missing
  const missingTools = requestedTools.filter((tool) => !status.allowedTools.includes(tool));

  return {
    granted: missingTools.length === 0,
    missingTools,
  };
}

/**
 * Get plugin tools available for consent prompt.
 */
export async function getPluginToolsForConsent(): Promise<AggregatedPluginTool[]> {
  return getAggregatedPluginTools();
}

// =============================================================================
// Permission Listing (for UI)
// =============================================================================

/**
 * Get all plugin permissions for display in the UI.
 */
export async function getAllPluginPermissions(): Promise<
  Array<{
    origin: string;
    allowAll: boolean;
    allowedTools: string[];
    grantType: 'once' | 'always';
    expiresAt?: number;
  }>
> {
  cleanupExpiredGrants();

  const result: Array<{
    origin: string;
    allowAll: boolean;
    allowedTools: string[];
    grantType: 'once' | 'always';
    expiresAt?: number;
  }> = [];

  // Add persistent permissions
  const stored = await loadPluginPermissions();
  for (const [origin, entry] of Object.entries(stored.permissions)) {
    result.push({
      origin,
      allowAll: entry.allowAll,
      allowedTools: entry.allowedTools,
      grantType: 'always',
    });
  }

  // Add/merge temporary grants
  for (const [, grant] of temporaryPluginGrants) {
    if (grant.expiresAt > Date.now()) {
      const existing = result.find((r) => r.origin === grant.origin);
      if (existing) {
        // Merge with existing
        existing.allowAll = existing.allowAll || grant.allowAll;
        existing.allowedTools = [...new Set([...existing.allowedTools, ...grant.allowedTools])];
        // Keep as 'always' if both exist
      } else {
        result.push({
          origin: grant.origin,
          allowAll: grant.allowAll,
          allowedTools: grant.allowedTools,
          grantType: 'once',
          expiresAt: grant.expiresAt,
        });
      }
    }
  }

  return result;
}

// =============================================================================
// Testing Utilities
// =============================================================================

/**
 * Clear all temporary grants. For testing only.
 * @internal
 */
export function __clearTemporaryGrants(): void {
  temporaryPluginGrants.clear();
}

/**
 * Get temporary grants map. For testing only.
 * @internal
 */
export function __getTemporaryGrants(): Map<string, PluginGrantEntry> {
  return temporaryPluginGrants;
}
