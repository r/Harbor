/**
 * Permission Manager
 * 
 * Implements capability-based permissioning for the MCP Host.
 * Permissions are keyed by origin (scheme+host+port) and profile ID.
 */

import { log } from '../native-messaging.js';
import {
  GrantType,
  PermissionScope,
  PermissionGrant,
  PermissionKey,
  Origin,
  ProfileId,
  ApiError,
  ErrorCode,
  createError,
} from './types.js';

/**
 * Default TTL for ALLOW_ONCE grants (1 hour).
 */
const DEFAULT_ALLOW_ONCE_TTL_MS = 60 * 60 * 1000;

/**
 * In-memory permission storage.
 * Structure: origin -> profileId -> scope -> grant
 */
const permissions: Map<Origin, Map<ProfileId, Map<PermissionScope, PermissionGrant>>> = new Map();

/**
 * Persisted permissions (loaded from storage).
 */
let persistedPermissions: Map<string, PermissionGrant> = new Map();

/**
 * Generate a storage key for a permission.
 */
function makeStorageKey(origin: Origin, profileId: ProfileId, scope: PermissionScope): string {
  return `${origin}|${profileId}|${scope}`;
}

/**
 * Parse a storage key.
 */
function parseStorageKey(key: string): PermissionKey | null {
  const parts = key.split('|');
  if (parts.length !== 3) return null;
  return {
    origin: parts[0],
    profileId: parts[1],
    scope: parts[2] as PermissionScope,
  };
}

/**
 * Get the permission map for an origin/profile combo.
 */
function getPermissionMap(origin: Origin, profileId: ProfileId): Map<PermissionScope, PermissionGrant> {
  let originMap = permissions.get(origin);
  if (!originMap) {
    originMap = new Map();
    permissions.set(origin, originMap);
  }
  
  let profileMap = originMap.get(profileId);
  if (!profileMap) {
    profileMap = new Map();
    originMap.set(profileId, profileMap);
  }
  
  return profileMap;
}

/**
 * Check if a grant is expired.
 */
function isGrantExpired(grant: PermissionGrant): boolean {
  if (!grant.expiresAt) return false;
  return Date.now() > grant.expiresAt;
}

/**
 * Load persisted permissions from storage.
 * Called once at startup.
 */
export async function loadPermissions(storage: {
  get(keys: string[]): Promise<Record<string, unknown>>;
}): Promise<void> {
  try {
    const data = await storage.get(['mcp_permissions']);
    const stored = data.mcp_permissions as Record<string, PermissionGrant> | undefined;
    
    if (stored) {
      persistedPermissions = new Map(Object.entries(stored));
      
      // Load into in-memory structure
      for (const [key, grant] of persistedPermissions) {
        // Only load ALLOW_ALWAYS grants
        if (grant.grantType !== GrantType.ALLOW_ALWAYS) continue;
        
        const parsed = parseStorageKey(key);
        if (!parsed) continue;
        
        const map = getPermissionMap(parsed.origin, parsed.profileId);
        map.set(parsed.scope, grant);
      }
      
      log(`[Permissions] Loaded ${persistedPermissions.size} persisted permissions`);
    }
  } catch (err) {
    log(`[Permissions] Failed to load permissions: ${err}`);
  }
}

/**
 * Save persisted permissions to storage.
 */
async function savePermissions(storage: {
  set(items: Record<string, unknown>): Promise<void>;
}): Promise<void> {
  try {
    const obj: Record<string, PermissionGrant> = {};
    for (const [key, grant] of persistedPermissions) {
      obj[key] = grant;
    }
    await storage.set({ mcp_permissions: obj });
  } catch (err) {
    log(`[Permissions] Failed to save permissions: ${err}`);
  }
}

/**
 * Grant a permission to an origin.
 */
export async function grantPermission(
  origin: Origin,
  profileId: ProfileId,
  scope: PermissionScope,
  grantType: GrantType,
  options: {
    expiresAt?: number;
    tabId?: number;
    allowedTools?: string[];
    storage?: { set(items: Record<string, unknown>): Promise<void> };
  } = {}
): Promise<void> {
  const grant: PermissionGrant = {
    scope,
    grantType,
    createdAt: Date.now(),
    expiresAt: options.expiresAt,
    tabId: options.tabId,
    allowedTools: options.allowedTools,
  };

  // For ALLOW_ONCE without explicit expiry, set default TTL
  if (grantType === GrantType.ALLOW_ONCE && !options.expiresAt && !options.tabId) {
    grant.expiresAt = Date.now() + DEFAULT_ALLOW_ONCE_TTL_MS;
  }

  const map = getPermissionMap(origin, profileId);
  map.set(scope, grant);

  log(`[Permissions] Granted ${grantType} for ${scope} to ${origin} (profile: ${profileId})`);

  // Persist ALLOW_ALWAYS grants
  if (grantType === GrantType.ALLOW_ALWAYS && options.storage) {
    const key = makeStorageKey(origin, profileId, scope);
    persistedPermissions.set(key, grant);
    await savePermissions(options.storage);
  }
}

/**
 * Revoke a permission from an origin.
 */
export async function revokePermission(
  origin: Origin,
  profileId: ProfileId,
  scope: PermissionScope,
  storage?: { set(items: Record<string, unknown>): Promise<void> }
): Promise<void> {
  const map = getPermissionMap(origin, profileId);
  map.delete(scope);

  log(`[Permissions] Revoked ${scope} from ${origin} (profile: ${profileId})`);

  // Remove from persistence
  const key = makeStorageKey(origin, profileId, scope);
  if (persistedPermissions.has(key)) {
    persistedPermissions.delete(key);
    if (storage) {
      await savePermissions(storage);
    }
  }
}

/**
 * Check if an origin has a specific permission.
 */
export function checkPermission(
  origin: Origin,
  profileId: ProfileId,
  scope: PermissionScope
): { granted: boolean; grant?: PermissionGrant; error?: ApiError } {
  const map = getPermissionMap(origin, profileId);
  const grant = map.get(scope);

  if (!grant) {
    return {
      granted: false,
      error: createError(
        ErrorCode.SCOPE_REQUIRED,
        `Permission scope "${scope}" is required but not granted`,
        { origin, scope }
      ),
    };
  }

  // Check for explicit DENY
  if (grant.grantType === GrantType.DENY) {
    return {
      granted: false,
      grant,
      error: createError(
        ErrorCode.PERMISSION_DENIED,
        `Permission "${scope}" was denied for this origin`,
        { origin, scope }
      ),
    };
  }

  // Check for expiration
  if (isGrantExpired(grant)) {
    // Clean up expired grant
    map.delete(scope);
    return {
      granted: false,
      error: createError(
        ErrorCode.SCOPE_REQUIRED,
        `Permission "${scope}" has expired`,
        { origin, scope }
      ),
    };
  }

  return { granted: true, grant };
}

/**
 * Check if a tool is allowed for an origin.
 */
export function isToolAllowed(
  origin: Origin,
  profileId: ProfileId,
  toolName: string
): { allowed: boolean; error?: ApiError } {
  // First check if tools.call is granted
  const callCheck = checkPermission(origin, profileId, PermissionScope.TOOLS_CALL);
  if (!callCheck.granted) {
    return { allowed: false, error: callCheck.error };
  }

  // If grant has an allowlist, check against it
  if (callCheck.grant?.allowedTools && callCheck.grant.allowedTools.length > 0) {
    if (!callCheck.grant.allowedTools.includes(toolName)) {
      return {
        allowed: false,
        error: createError(
          ErrorCode.TOOL_NOT_ALLOWED,
          `Tool "${toolName}" is not in the allowlist for this origin`,
          { toolName, allowedTools: callCheck.grant.allowedTools }
        ),
      };
    }
  }

  return { allowed: true };
}

/**
 * Get all permissions for an origin/profile.
 */
export function getPermissions(
  origin: Origin,
  profileId: ProfileId
): PermissionGrant[] {
  const map = getPermissionMap(origin, profileId);
  const grants: PermissionGrant[] = [];

  for (const [scope, grant] of map) {
    // Filter out expired grants
    if (isGrantExpired(grant)) {
      map.delete(scope);
      continue;
    }
    grants.push(grant);
  }

  return grants;
}

/**
 * Expire all ALLOW_ONCE grants for a tab.
 * Called when a tab is closed.
 */
export function expireTabGrants(tabId: number): number {
  let expired = 0;

  for (const [_origin, originMap] of permissions) {
    for (const [_profileId, profileMap] of originMap) {
      for (const [scope, grant] of profileMap) {
        if (grant.grantType === GrantType.ALLOW_ONCE && grant.tabId === tabId) {
          profileMap.delete(scope);
          expired++;
        }
      }
    }
  }

  if (expired > 0) {
    log(`[Permissions] Expired ${expired} grants for closed tab ${tabId}`);
  }

  return expired;
}

/**
 * Clear all non-persisted permissions.
 * Called on extension restart.
 */
export function clearTransientPermissions(): void {
  for (const [origin, originMap] of permissions) {
    for (const [profileId, profileMap] of originMap) {
      for (const [scope, grant] of profileMap) {
        if (grant.grantType !== GrantType.ALLOW_ALWAYS) {
          profileMap.delete(scope);
        }
      }
      if (profileMap.size === 0) {
        originMap.delete(profileId);
      }
    }
    if (originMap.size === 0) {
      permissions.delete(origin);
    }
  }
  log('[Permissions] Cleared transient permissions');
}

/**
 * List all origins with any permissions.
 */
export function listOriginsWithPermissions(profileId: ProfileId): Origin[] {
  const origins: Origin[] = [];

  for (const [origin, originMap] of permissions) {
    const profileMap = originMap.get(profileId);
    if (profileMap && profileMap.size > 0) {
      origins.push(origin);
    }
  }

  return origins;
}

