/**
 * Web Agent API Permission System
 *
 * Handles permission enforcement, grants, and prompt logic.
 */

import type {
  PermissionScope,
  PermissionGrant,
  PermissionGrantResult,
  PermissionStatus,
  StoredOriginPermissions,
  StoredPermission,
  RequestPermissionsOptions,
  MessageType,
  REQUIRED_SCOPES,
} from '../agents/types';

const PERMISSIONS_STORAGE_KEY = 'harbor_origin_permissions';
const ONCE_GRANT_DURATION_MS = 10 * 60 * 1000; // 10 minutes

// =============================================================================
// Storage Operations
// =============================================================================

async function loadOriginPermissions(origin: string): Promise<StoredOriginPermissions | null> {
  const result = await chrome.storage.local.get(PERMISSIONS_STORAGE_KEY);
  const allPermissions = (result[PERMISSIONS_STORAGE_KEY] || {}) as Record<string, StoredOriginPermissions>;
  return allPermissions[origin] || null;
}

async function saveOriginPermissions(permissions: StoredOriginPermissions): Promise<void> {
  const result = await chrome.storage.local.get(PERMISSIONS_STORAGE_KEY);
  const allPermissions = (result[PERMISSIONS_STORAGE_KEY] || {}) as Record<string, StoredOriginPermissions>;
  allPermissions[permissions.origin] = permissions;
  await chrome.storage.local.set({ [PERMISSIONS_STORAGE_KEY]: allPermissions });
}

async function getAllOriginPermissions(): Promise<Record<string, StoredOriginPermissions>> {
  const result = await chrome.storage.local.get(PERMISSIONS_STORAGE_KEY);
  return (result[PERMISSIONS_STORAGE_KEY] || {}) as Record<string, StoredOriginPermissions>;
}

// =============================================================================
// Grant Checking
// =============================================================================

function isGrantValid(stored: StoredPermission, tabId?: number): boolean {
  if (stored.grant === 'denied' || stored.grant === 'not-granted') {
    return true; // These are always "valid" states
  }

  if (stored.grant === 'granted-always') {
    return true;
  }

  if (stored.grant === 'granted-once') {
    // Check expiry
    if (stored.expiresAt && Date.now() > stored.expiresAt) {
      return false; // Expired
    }
    // Check tab (if we're tracking it)
    if (stored.tabId !== undefined && tabId !== undefined && stored.tabId !== tabId) {
      return false; // Different tab
    }
    return true;
  }

  return false;
}

function getEffectiveGrant(stored: StoredPermission | undefined, tabId?: number): PermissionGrant {
  if (!stored) {
    return 'not-granted';
  }

  if (!isGrantValid(stored, tabId)) {
    return 'not-granted';
  }

  return stored.grant;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Get the current permission status for an origin.
 */
export async function getPermissionStatus(origin: string, tabId?: number): Promise<PermissionStatus> {
  const stored = await loadOriginPermissions(origin);

  const scopes: Record<PermissionScope, PermissionGrant> = {
    'model:prompt': 'not-granted',
    'model:tools': 'not-granted',
    'model:list': 'not-granted',
    'mcp:tools.list': 'not-granted',
    'mcp:tools.call': 'not-granted',
    'mcp:servers.register': 'not-granted',
    'browser:activeTab.read': 'not-granted',
    'chat:open': 'not-granted',
    'web:fetch': 'not-granted',
    'addressBar:suggest': 'not-granted',
    'addressBar:context': 'not-granted',
    'addressBar:history': 'not-granted',
    'addressBar:execute': 'not-granted',
  };

  if (stored) {
    for (const scope of Object.keys(scopes) as PermissionScope[]) {
      scopes[scope] = getEffectiveGrant(stored.scopes[scope], tabId);
    }
  }

  return {
    origin,
    scopes,
    allowedTools: stored?.allowedTools,
  };
}

/**
 * Check if all required scopes are granted for an origin.
 */
export async function checkPermissions(
  origin: string,
  requiredScopes: PermissionScope[],
  tabId?: number,
): Promise<{ granted: boolean; missingScopes: PermissionScope[]; deniedScopes: PermissionScope[] }> {
  const status = await getPermissionStatus(origin, tabId);

  const missingScopes: PermissionScope[] = [];
  const deniedScopes: PermissionScope[] = [];

  for (const scope of requiredScopes) {
    const grant = status.scopes[scope];
    if (grant === 'denied') {
      deniedScopes.push(scope);
    } else if (grant === 'not-granted') {
      missingScopes.push(scope);
    }
  }

  return {
    granted: missingScopes.length === 0 && deniedScopes.length === 0,
    missingScopes,
    deniedScopes,
  };
}

/**
 * Check if a specific tool is allowed for an origin.
 */
export async function isToolAllowed(origin: string, toolName: string): Promise<boolean> {
  const stored = await loadOriginPermissions(origin);
  if (!stored) return false;

  // Check if mcp:tools.call is granted
  const toolsGrant = getEffectiveGrant(stored.scopes['mcp:tools.call']);
  if (toolsGrant !== 'granted-always' && toolsGrant !== 'granted-once') {
    return false;
  }

  // Check if tool is in allowlist
  return stored.allowedTools.includes(toolName);
}

/**
 * Grant permissions for an origin.
 */
export async function grantPermissions(
  origin: string,
  scopes: PermissionScope[],
  grantType: 'granted-once' | 'granted-always',
  tabId?: number,
  allowedTools?: string[],
): Promise<PermissionGrantResult> {
  console.log('[Permissions] grantPermissions:', { origin, scopes, grantType, tabId, allowedTools });
  
  let stored = await loadOriginPermissions(origin);

  if (!stored) {
    stored = {
      origin,
      scopes: {} as Record<PermissionScope, StoredPermission>,
      allowedTools: [],
    };
  }

  const now = Date.now();

  for (const scope of scopes) {
    stored.scopes[scope] = {
      grant: grantType,
      grantedAt: now,
      expiresAt: grantType === 'granted-once' ? now + ONCE_GRANT_DURATION_MS : undefined,
      tabId: grantType === 'granted-once' ? tabId : undefined,
    };
  }

  // Merge allowed tools
  if (allowedTools && allowedTools.length > 0) {
    const toolSet = new Set([...stored.allowedTools, ...allowedTools]);
    stored.allowedTools = Array.from(toolSet);
  }

  await saveOriginPermissions(stored);
  console.log('[Permissions] Saved permissions for', origin);

  // Notify sidebar to refresh
  chrome.runtime.sendMessage({ type: 'permissions_changed' }).catch(() => {
    // Sidebar may not be open
  });

  // Build result
  const resultScopes: Record<PermissionScope, PermissionGrant> = {} as Record<PermissionScope, PermissionGrant>;
  for (const scope of Object.keys(stored.scopes) as PermissionScope[]) {
    resultScopes[scope] = getEffectiveGrant(stored.scopes[scope], tabId);
  }

  return {
    granted: true,
    scopes: resultScopes,
    allowedTools: stored.allowedTools,
  };
}

/**
 * Deny permissions for an origin.
 */
export async function denyPermissions(
  origin: string,
  scopes: PermissionScope[],
): Promise<PermissionGrantResult> {
  let stored = await loadOriginPermissions(origin);

  if (!stored) {
    stored = {
      origin,
      scopes: {} as Record<PermissionScope, StoredPermission>,
      allowedTools: [],
    };
  }

  const now = Date.now();

  for (const scope of scopes) {
    stored.scopes[scope] = {
      grant: 'denied',
      grantedAt: now,
    };
  }

  await saveOriginPermissions(stored);

  // Build result
  const resultScopes: Record<PermissionScope, PermissionGrant> = {} as Record<PermissionScope, PermissionGrant>;
  for (const scope of Object.keys(stored.scopes) as PermissionScope[]) {
    resultScopes[scope] = stored.scopes[scope]?.grant || 'not-granted';
  }

  return {
    granted: false,
    scopes: resultScopes,
  };
}

/**
 * Revoke all permissions for an origin.
 */
export async function revokePermissions(origin: string): Promise<void> {
  const result = await chrome.storage.local.get(PERMISSIONS_STORAGE_KEY);
  const allPermissions = (result[PERMISSIONS_STORAGE_KEY] || {}) as Record<string, StoredOriginPermissions>;
  delete allPermissions[origin];
  await chrome.storage.local.set({ [PERMISSIONS_STORAGE_KEY]: allPermissions });
}

/**
 * Clean up expired once-grants.
 */
export async function cleanupExpiredGrants(): Promise<void> {
  const allPermissions = await getAllOriginPermissions();
  const now = Date.now();
  let changed = false;

  for (const [origin, stored] of Object.entries(allPermissions)) {
    for (const [scope, permission] of Object.entries(stored.scopes)) {
      if (permission.grant === 'granted-once' && permission.expiresAt && permission.expiresAt < now) {
        (stored.scopes as Record<string, StoredPermission>)[scope] = {
          grant: 'not-granted',
          grantedAt: now,
        };
        changed = true;
      }
    }
  }

  if (changed) {
    await chrome.storage.local.set({ [PERMISSIONS_STORAGE_KEY]: allPermissions });
  }
}

/**
 * Get all permissions for all origins (for sidebar display).
 * Shows both permanent and temporary grants.
 */
export async function listAllPermissions(): Promise<PermissionStatus[]> {
  const allPermissions = await getAllOriginPermissions();
  const result: PermissionStatus[] = [];
  const now = Date.now();

  for (const [origin, stored] of Object.entries(allPermissions)) {
    const scopes: Record<PermissionScope, PermissionGrant> = {
      'model:prompt': 'not-granted',
      'model:tools': 'not-granted',
      'model:list': 'not-granted',
      'mcp:tools.list': 'not-granted',
      'mcp:tools.call': 'not-granted',
      'mcp:servers.register': 'not-granted',
      'browser:activeTab.read': 'not-granted',
      'chat:open': 'not-granted',
      'web:fetch': 'not-granted',
      'addressBar:suggest': 'not-granted',
      'addressBar:context': 'not-granted',
      'addressBar:history': 'not-granted',
      'addressBar:execute': 'not-granted',
    };

    for (const scope of Object.keys(scopes) as PermissionScope[]) {
      const storedPerm = stored.scopes[scope];
      if (storedPerm) {
        // For display purposes, show the stored grant directly
        // But filter out expired temporary grants
        if (storedPerm.grant === 'granted-once') {
          if (storedPerm.expiresAt && storedPerm.expiresAt < now) {
            // Expired, show as not-granted
            scopes[scope] = 'not-granted';
          } else {
            scopes[scope] = 'granted-once';
          }
        } else {
          scopes[scope] = storedPerm.grant;
        }
      }
    }

    // Only include origins with at least one non-default grant
    const hasGrants = Object.values(scopes).some(g => g !== 'not-granted');
    if (hasGrants) {
      result.push({
        origin,
        scopes,
        allowedTools: stored.allowedTools,
      });
    }
  }

  return result;
}

// =============================================================================
// Permission Prompt
// =============================================================================

let promptWindowId: number | null = null;
let pendingPromptResolve: ((result: {
  granted: boolean;
  grantType?: 'granted-once' | 'granted-always';
  allowedTools?: string[];
  explicitDeny?: boolean;
}) => void) | null = null;

/**
 * Show permission prompt to user.
 */
export async function showPermissionPrompt(
  origin: string,
  scopes: PermissionScope[],
  reason?: string,
  requestedTools?: string[],
): Promise<{
  granted: boolean;
  grantType?: 'granted-once' | 'granted-always';
  allowedTools?: string[];
  explicitDeny?: boolean;
}> {
  console.log('[Permissions] showPermissionPrompt called:', { origin, scopes, reason });

  // Close any existing prompt
  if (promptWindowId !== null) {
    try {
      await chrome.windows.remove(promptWindowId);
    } catch {
      // Window may already be closed
    }
    promptWindowId = null;
    if (pendingPromptResolve) {
      pendingPromptResolve({ granted: false });
      pendingPromptResolve = null;
    }
  }

  // Build prompt URL with params
  const params = new URLSearchParams({
    origin,
    scopes: scopes.join(','),
  });
  if (reason) params.set('reason', reason);
  if (requestedTools && requestedTools.length > 0) {
    params.set('tools', requestedTools.join(','));
  }

  const promptUrl = chrome.runtime.getURL(`dist/permission-prompt.html?${params.toString()}`);
  console.log('[Permissions] Opening prompt URL:', promptUrl);

  return new Promise((resolve) => {
    pendingPromptResolve = resolve;

    // Use promise-based API (works in both Chrome and Firefox)
    const createPromise = chrome.windows.create({
      url: promptUrl,
      type: 'popup',
      width: 450,
      height: 500,
      focused: true,
    });

    // Handle both callback and promise patterns
    if (createPromise && typeof createPromise.then === 'function') {
      // Promise-based (Firefox/modern Chrome)
      createPromise.then((window) => {
        console.log('[Permissions] Window created (promise):', window?.id);
        if (window?.id) {
          promptWindowId = window.id;
        } else {
          console.error('[Permissions] Window creation failed - no window returned');
          pendingPromptResolve = null;
          resolve({ granted: false });
        }
      }).catch((err) => {
        console.error('[Permissions] Window creation failed:', err);
        pendingPromptResolve = null;
        resolve({ granted: false });
      });
    }
  });
}

/**
 * Handle permission prompt response (called from prompt page).
 */
export function handlePermissionPromptResponse(response: {
  granted: boolean;
  grantType?: 'granted-once' | 'granted-always';
  allowedTools?: string[];
  explicitDeny?: boolean;
}): void {
  console.log('[Permissions] handlePermissionPromptResponse:', response);
  if (pendingPromptResolve) {
    pendingPromptResolve(response);
    pendingPromptResolve = null;
  }

  if (promptWindowId !== null) {
    chrome.windows.remove(promptWindowId).catch(() => {});
    promptWindowId = null;
  }
}

// Listen for window close to handle user dismissing the prompt
chrome.windows?.onRemoved?.addListener((windowId) => {
  if (windowId === promptWindowId) {
    promptWindowId = null;
    if (pendingPromptResolve) {
      pendingPromptResolve({ granted: false });
      pendingPromptResolve = null;
    }
  }
});

// =============================================================================
// Request Permissions Flow
// =============================================================================

/**
 * Handle a permission request from a web page.
 */
export async function requestPermissions(
  origin: string,
  options: RequestPermissionsOptions,
  tabId?: number,
): Promise<PermissionGrantResult> {
  const { scopes, reason, tools } = options;

  // First check current status
  const check = await checkPermissions(origin, scopes, tabId);

  // If any scope is explicitly denied, return immediately (no re-prompt)
  if (check.deniedScopes.length > 0) {
    const status = await getPermissionStatus(origin, tabId);
    return {
      granted: false,
      scopes: status.scopes,
    };
  }

  // If all scopes granted, return success
  if (check.granted) {
    const status = await getPermissionStatus(origin, tabId);

    // Check tool allowlist if mcp:tools.call is requested
    if (scopes.includes('mcp:tools.call') && tools && tools.length > 0) {
      const missingTools = tools.filter((t) => !status.allowedTools?.includes(t));
      if (missingTools.length > 0) {
        // Need to prompt for additional tools
        const promptResult = await showPermissionPrompt(origin, ['mcp:tools.call'], reason, missingTools);
        if (promptResult.granted && promptResult.grantType) {
          return grantPermissions(origin, [], promptResult.grantType, tabId, promptResult.allowedTools);
        }
      }
    }

    return {
      granted: true,
      scopes: status.scopes,
      allowedTools: status.allowedTools,
    };
  }

  // Need to prompt user
  const promptResult = await showPermissionPrompt(origin, check.missingScopes, reason, tools);

  if (promptResult.granted && promptResult.grantType) {
    return grantPermissions(origin, check.missingScopes, promptResult.grantType, tabId, promptResult.allowedTools);
  } else if (promptResult.explicitDeny) {
    // Only store denial if user explicitly clicked deny (not just dismissed or window failed)
    return denyPermissions(origin, check.missingScopes);
  } else {
    // User dismissed or window failed to open - don't store denial, just return not-granted
    const status = await getPermissionStatus(origin, tabId);
    return {
      granted: false,
      scopes: status.scopes,
    };
  }
}

// =============================================================================
// Scope Descriptions (for UI)
// =============================================================================

export const SCOPE_DESCRIPTIONS: Record<PermissionScope, { title: string; description: string; risk: 'low' | 'medium' | 'high' }> = {
  'model:prompt': {
    title: 'Generate text using AI',
    description: 'Create text generation sessions and receive AI-generated responses.',
    risk: 'low',
  },
  'model:tools': {
    title: 'Use AI with tool calling',
    description: 'Run autonomous agent tasks where AI can decide to call tools.',
    risk: 'medium',
  },
  'model:list': {
    title: 'List AI providers',
    description: 'See which AI providers and models are available.',
    risk: 'low',
  },
  'mcp:tools.list': {
    title: 'List available tools',
    description: 'See the list of tools from connected MCP servers.',
    risk: 'low',
  },
  'mcp:tools.call': {
    title: 'Execute tools',
    description: 'Call specific MCP tools like search, file access, or APIs.',
    risk: 'high',
  },
  'mcp:servers.register': {
    title: 'Register MCP servers',
    description: 'Allow the website to register its own MCP server.',
    risk: 'medium',
  },
  'browser:activeTab.read': {
    title: 'Read current page',
    description: 'Extract readable text content from the currently active tab.',
    risk: 'medium',
  },
  'chat:open': {
    title: 'Open chat UI',
    description: 'Open the browser\'s chat interface.',
    risk: 'low',
  },
  'web:fetch': {
    title: 'Make web requests',
    description: 'Proxy HTTP requests through the extension.',
    risk: 'high',
  },
  'addressBar:suggest': {
    title: 'Provide address bar suggestions',
    description: 'Show AI-powered suggestions in the browser address bar.',
    risk: 'low',
  },
  'addressBar:context': {
    title: 'Access current tab context',
    description: 'Use current page information for smarter suggestions.',
    risk: 'medium',
  },
  'addressBar:history': {
    title: 'Access browsing history',
    description: 'Use recent browsing history for personalized suggestions.',
    risk: 'high',
  },
  'addressBar:execute': {
    title: 'Execute from address bar',
    description: 'Run tools and actions directly from address bar commands.',
    risk: 'medium',
  },
};

// Start cleanup interval
setInterval(cleanupExpiredGrants, 60000); // Every minute
