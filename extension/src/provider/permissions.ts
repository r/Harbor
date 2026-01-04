/**
 * Harbor JS AI Provider - Permission Management
 * 
 * Handles permission storage, checking, and granting for web page API access.
 */

import browser from 'webextension-polyfill';
import type {
  PermissionScope,
  PermissionGrant,
  StoredPermissions,
  TemporaryGrant,
  PermissionStatus,
  PermissionGrantResult,
} from './types';

// Storage key for persistent permissions
const STORAGE_KEY = 'provider_permissions';

// Temporary (once) grants - in memory with TTL
const temporaryGrants: Map<string, TemporaryGrant> = new Map();

// TTL for "once" grants (10 minutes)
const ONCE_GRANT_TTL_MS = 10 * 60 * 1000;

// All valid permission scopes
export const ALL_SCOPES: PermissionScope[] = [
  'model:prompt',
  'model:tools',
  'mcp:tools.list',
  'mcp:tools.call',
  'browser:activeTab.read',
  'web:fetch',
];

// Human-readable scope descriptions
export const SCOPE_DESCRIPTIONS: Record<PermissionScope, string> = {
  'model:prompt': 'Generate text using AI models',
  'model:tools': 'Use AI with tool calling capabilities',
  'mcp:tools.list': 'List available MCP tools',
  'mcp:tools.call': 'Execute MCP tools',
  'browser:activeTab.read': 'Read content from the currently active browser tab',
  'web:fetch': 'Make web requests on your behalf (not implemented)',
};

// Scopes that require user gesture
export const GESTURE_REQUIRED_SCOPES: PermissionScope[] = [
  'browser:activeTab.read',
];

// =============================================================================
// Permission Storage
// =============================================================================

/**
 * Load persistent permissions from storage.
 */
async function loadStoredPermissions(): Promise<StoredPermissions> {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as StoredPermissions) || {};
}

/**
 * Save persistent permissions to storage.
 */
async function saveStoredPermissions(permissions: StoredPermissions): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: permissions });
}

/**
 * Get the temporary grant key for an origin.
 */
function getTempKey(origin: string): string {
  return `temp:${origin}`;
}

/**
 * Clean up expired temporary grants.
 */
function cleanupExpiredGrants(): void {
  const now = Date.now();
  for (const [key, grant] of temporaryGrants) {
    if (grant.expiresAt < now) {
      temporaryGrants.delete(key);
    }
  }
}

// Run cleanup periodically
setInterval(cleanupExpiredGrants, 60000);

// =============================================================================
// Permission Checking
// =============================================================================

/**
 * Get the current permission status for an origin.
 */
export async function getPermissionStatus(origin: string): Promise<PermissionStatus> {
  // Special case: extension pages always have all permissions
  if (origin === 'extension') {
    const scopes: Record<PermissionScope, PermissionGrant> = {} as Record<PermissionScope, PermissionGrant>;
    for (const scope of ALL_SCOPES) {
      scopes[scope] = 'granted-always';
    }
    return { origin, scopes };
  }
  
  cleanupExpiredGrants();
  
  const stored = await loadStoredPermissions();
  const originPerms = stored[origin];
  const tempGrant = temporaryGrants.get(getTempKey(origin));
  
  // Build status for all scopes
  const scopes: Record<PermissionScope, PermissionGrant> = {} as Record<PermissionScope, PermissionGrant>;
  
  for (const scope of ALL_SCOPES) {
    // Check temporary grants first (they take precedence)
    if (tempGrant && tempGrant.scopes.includes(scope) && tempGrant.expiresAt > Date.now()) {
      scopes[scope] = 'granted-once';
      continue;
    }
    
    // Check persistent grants
    if (originPerms?.scopes[scope]) {
      scopes[scope] = originPerms.scopes[scope];
    } else {
      scopes[scope] = 'not-granted';
    }
  }
  
  // Get allowed tools (merge temp and persistent)
  let allowedTools: string[] | undefined;
  if (tempGrant?.allowedTools && tempGrant.allowedTools.length > 0) {
    allowedTools = tempGrant.allowedTools;
  } else if (originPerms?.allowedTools && originPerms.allowedTools.length > 0) {
    allowedTools = originPerms.allowedTools;
  }
  
  return { origin, scopes, allowedTools };
}

/**
 * Check if a specific scope is granted for an origin.
 */
export async function hasPermission(origin: string, scope: PermissionScope): Promise<boolean> {
  const status = await getPermissionStatus(origin);
  const grant = status.scopes[scope];
  return grant === 'granted-once' || grant === 'granted-always';
}

/**
 * Check if all required scopes are granted for an origin.
 */
export async function hasAllPermissions(origin: string, scopes: PermissionScope[]): Promise<boolean> {
  for (const scope of scopes) {
    if (!(await hasPermission(origin, scope))) {
      return false;
    }
  }
  return true;
}

/**
 * Get missing permissions for a set of scopes.
 */
export async function getMissingPermissions(origin: string, scopes: PermissionScope[]): Promise<PermissionScope[]> {
  const missing: PermissionScope[] = [];
  for (const scope of scopes) {
    if (!(await hasPermission(origin, scope))) {
      missing.push(scope);
    }
  }
  return missing;
}

// =============================================================================
// Permission Granting
// =============================================================================

/**
 * Grant permissions to an origin.
 */
export async function grantPermissions(
  origin: string,
  scopes: PermissionScope[],
  mode: 'once' | 'always',
  options?: { allowedTools?: string[]; tabId?: number }
): Promise<void> {
  if (mode === 'once') {
    // Store as temporary grant
    const existing = temporaryGrants.get(getTempKey(origin));
    const existingScopes = existing?.scopes || [];
    const mergedScopes = [...new Set([...existingScopes, ...scopes])];
    
    // Merge allowed tools
    const existingTools = existing?.allowedTools || [];
    const newTools = options?.allowedTools || [];
    const mergedTools = [...new Set([...existingTools, ...newTools])];
    
    temporaryGrants.set(getTempKey(origin), {
      origin,
      scopes: mergedScopes,
      allowedTools: mergedTools.length > 0 ? mergedTools : undefined,
      grantedAt: Date.now(),
      expiresAt: Date.now() + ONCE_GRANT_TTL_MS,
      tabId: options?.tabId ?? existing?.tabId,
    });
  } else {
    // Store persistently
    const stored = await loadStoredPermissions();
    const existing = stored[origin]?.scopes || {};
    const existingTools = stored[origin]?.allowedTools || [];
    
    const newScopes: Record<PermissionScope, PermissionGrant> = { ...existing };
    for (const scope of scopes) {
      newScopes[scope] = 'granted-always';
    }
    
    // Merge allowed tools
    const newTools = options?.allowedTools || [];
    const mergedTools = [...new Set([...existingTools, ...newTools])];
    
    stored[origin] = {
      scopes: newScopes,
      allowedTools: mergedTools.length > 0 ? mergedTools : undefined,
      updatedAt: Date.now(),
    };
    
    await saveStoredPermissions(stored);
  }
}

/**
 * Deny permissions for an origin.
 */
export async function denyPermissions(origin: string, scopes: PermissionScope[]): Promise<void> {
  const stored = await loadStoredPermissions();
  const existing = stored[origin]?.scopes || {};
  
  const newScopes: Record<PermissionScope, PermissionGrant> = { ...existing };
  for (const scope of scopes) {
    newScopes[scope] = 'denied';
  }
  
  stored[origin] = {
    scopes: newScopes,
    updatedAt: Date.now(),
  };
  
  await saveStoredPermissions(stored);
  
  // Also remove any temporary grants for these scopes
  const tempGrant = temporaryGrants.get(getTempKey(origin));
  if (tempGrant) {
    tempGrant.scopes = tempGrant.scopes.filter(s => !scopes.includes(s));
    if (tempGrant.scopes.length === 0) {
      temporaryGrants.delete(getTempKey(origin));
    }
  }
}

/**
 * Revoke all permissions for an origin.
 */
export async function revokeAllPermissions(origin: string): Promise<void> {
  const stored = await loadStoredPermissions();
  delete stored[origin];
  await saveStoredPermissions(stored);
  
  temporaryGrants.delete(getTempKey(origin));
}

/**
 * Clear temporary grants for a tab (when tab closes).
 */
export function clearTabGrants(tabId: number): void {
  for (const [key, grant] of temporaryGrants) {
    if (grant.tabId === tabId) {
      temporaryGrants.delete(key);
    }
  }
}

// =============================================================================
// Permission Request Handling
// =============================================================================

/**
 * Process a permission request and show UI if needed.
 * Returns the result of the permission check/grant.
 */
export async function processPermissionRequest(
  origin: string,
  requestedScopes: PermissionScope[],
  reason?: string
): Promise<PermissionGrantResult> {
  // Filter to valid scopes only
  const validScopes = requestedScopes.filter(s => ALL_SCOPES.includes(s));
  
  if (validScopes.length === 0) {
    return {
      granted: false,
      scopes: {} as Record<PermissionScope, PermissionGrant>,
    };
  }
  
  // Check which scopes are already granted
  const missing = await getMissingPermissions(origin, validScopes);
  
  // Check for explicitly denied scopes
  const status = await getPermissionStatus(origin);
  const denied = missing.filter(s => status.scopes[s] === 'denied');
  
  // If all requested scopes are already granted, return success immediately
  if (missing.length === 0) {
    return {
      granted: true,
      scopes: status.scopes,
    };
  }
  
  // If any scopes are denied, don't re-prompt (user must clear manually)
  if (denied.length > 0) {
    return {
      granted: false,
      scopes: status.scopes,
    };
  }
  
  // Need to prompt user for missing scopes
  // This will be handled by the background router which opens the permission UI
  return {
    granted: false,
    scopes: status.scopes,
  };
}

/**
 * Build a PermissionGrantResult from current status.
 */
export async function buildGrantResult(
  origin: string,
  requestedScopes: PermissionScope[]
): Promise<PermissionGrantResult> {
  const status = await getPermissionStatus(origin);
  const granted = requestedScopes.every(s => 
    status.scopes[s] === 'granted-once' || status.scopes[s] === 'granted-always'
  );
  
  return {
    granted,
    scopes: status.scopes,
    allowedTools: status.allowedTools,
  };
}

/**
 * Get allowed tools for an origin.
 * Returns undefined if all tools are allowed.
 */
export async function getAllowedTools(origin: string): Promise<string[] | undefined> {
  const status = await getPermissionStatus(origin);
  return status.allowedTools;
}

/**
 * Check if a specific tool is allowed for an origin.
 */
export async function isToolAllowed(origin: string, toolName: string): Promise<boolean> {
  const status = await getPermissionStatus(origin);
  
  // First check if mcp:tools.call is granted
  const callGrant = status.scopes['mcp:tools.call'];
  if (callGrant !== 'granted-once' && callGrant !== 'granted-always') {
    return false;
  }
  
  // If no allowlist, all tools are allowed
  if (!status.allowedTools || status.allowedTools.length === 0) {
    return true;
  }
  
  // Check against allowlist
  return status.allowedTools.includes(toolName);
}

/**
 * Update allowed tools for an origin (used by management UI).
 */
export async function updateAllowedTools(
  origin: string,
  allowedTools: string[]
): Promise<void> {
  const stored = await loadStoredPermissions();
  
  if (!stored[origin]) {
    // No permissions stored for this origin yet
    return;
  }
  
  stored[origin].allowedTools = allowedTools.length > 0 ? allowedTools : undefined;
  stored[origin].updatedAt = Date.now();
  
  await saveStoredPermissions(stored);
  
  // Also update temporary grants if present
  const tempGrant = temporaryGrants.get(getTempKey(origin));
  if (tempGrant) {
    tempGrant.allowedTools = allowedTools.length > 0 ? allowedTools : undefined;
  }
}

// =============================================================================
// Permission Listing (for UI)
// =============================================================================

/**
 * Get all permissions (both persistent and temporary) for display in the UI.
 * This merges temporary grants with persistent ones.
 */
export async function getAllPermissions(): Promise<PermissionStatus[]> {
  cleanupExpiredGrants();
  
  const stored = await loadStoredPermissions();
  const result: Map<string, PermissionStatus> = new Map();
  
  // First, add all persistent permissions
  for (const [origin, data] of Object.entries(stored)) {
    result.set(origin, {
      origin,
      scopes: data.scopes as Record<PermissionScope, PermissionGrant>,
      allowedTools: data.allowedTools,
    });
  }
  
  // Then, merge in temporary grants (they take precedence for granted-once scopes)
  for (const [, tempGrant] of temporaryGrants) {
    const { origin, scopes: tempScopes, allowedTools: tempTools } = tempGrant;
    
    const existing = result.get(origin);
    if (existing) {
      // Merge: temp scopes override persistent ones
      const mergedScopes = { ...existing.scopes };
      for (const scope of tempScopes) {
        mergedScopes[scope] = 'granted-once';
      }
      // Temp tools take precedence if present
      result.set(origin, {
        origin,
        scopes: mergedScopes,
        allowedTools: tempTools ?? existing.allowedTools,
      });
    } else {
      // New origin from temp grants only
      const scopes: Record<PermissionScope, PermissionGrant> = {} as Record<PermissionScope, PermissionGrant>;
      for (const scope of ALL_SCOPES) {
        scopes[scope] = tempScopes.includes(scope) ? 'granted-once' : 'not-granted';
      }
      result.set(origin, {
        origin,
        scopes,
        allowedTools: tempTools,
      });
    }
  }
  
  return Array.from(result.values());
}

// =============================================================================
// Testing Utilities
// =============================================================================

/**
 * Clear all temporary grants. For testing only.
 * @internal
 */
export function __clearAllTemporaryGrants(): void {
  temporaryGrants.clear();
}

/**
 * Get temporary grants map. For testing only.
 * @internal
 */
export function __getTemporaryGrants(): Map<string, TemporaryGrant> {
  return temporaryGrants;
}

