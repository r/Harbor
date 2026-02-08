/**
 * Web Agent API Permission System
 *
 * Handles permission enforcement, grants, and prompt logic.
 */

import { browserAPI } from '../browser-compat';
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
  const result = await browserAPI.storage.local.get(PERMISSIONS_STORAGE_KEY);
  const allPermissions = (result[PERMISSIONS_STORAGE_KEY] || {}) as Record<string, StoredOriginPermissions>;
  return allPermissions[origin] || null;
}

async function saveOriginPermissions(permissions: StoredOriginPermissions): Promise<void> {
  const result = await browserAPI.storage.local.get(PERMISSIONS_STORAGE_KEY);
  const allPermissions = (result[PERMISSIONS_STORAGE_KEY] || {}) as Record<string, StoredOriginPermissions>;
  allPermissions[permissions.origin] = permissions;
  await browserAPI.storage.local.set({ [PERMISSIONS_STORAGE_KEY]: allPermissions });
}

async function getAllOriginPermissions(): Promise<Record<string, StoredOriginPermissions>> {
  const result = await browserAPI.storage.local.get(PERMISSIONS_STORAGE_KEY);
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
    // Extension 1: Core AI & MCP
    'model:prompt': 'not-granted',
    'model:tools': 'not-granted',
    'model:list': 'not-granted',
    'mcp:tools.list': 'not-granted',
    'mcp:tools.call': 'not-granted',
    'mcp:servers.register': 'not-granted',
    // Extension 1: Browser (same-tab)
    'browser:activeTab.read': 'not-granted',
    'browser:activeTab.interact': 'not-granted',
    'browser:activeTab.screenshot': 'not-granted',
    // Extension 2: Navigation and Tabs
    'browser:navigate': 'not-granted',
    'browser:tabs.read': 'not-granted',
    'browser:tabs.create': 'not-granted',
    // Extension 2: Web Fetch
    'web:fetch': 'not-granted',
    // Other
    'chat:open': 'not-granted',
    'addressBar:suggest': 'not-granted',
    'addressBar:context': 'not-granted',
    'addressBar:history': 'not-granted',
    'addressBar:execute': 'not-granted',
    // Extension 3: Multi-Agent (reserved)
    'agents:register': 'not-granted',
    'agents:discover': 'not-granted',
    'agents:invoke': 'not-granted',
    'agents:message': 'not-granted',
    'agents:crossOrigin': 'not-granted',
    'agents:remote': 'not-granted',
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
  console.log('[Permissions] checkPermissions called - origin:', origin, 'scopes:', requiredScopes, 'tabId:', tabId);
  const status = await getPermissionStatus(origin, tabId);
  console.log('[Permissions] Status for', origin, ':', JSON.stringify(status.scopes));

  const missingScopes: PermissionScope[] = [];
  const deniedScopes: PermissionScope[] = [];

  for (const scope of requiredScopes) {
    const grant = status.scopes[scope];
    console.log('[Permissions] Scope', scope, '=', grant);
    if (grant === 'denied') {
      deniedScopes.push(scope);
    } else if (grant === 'not-granted') {
      missingScopes.push(scope);
    }
  }

  const result = {
    granted: missingScopes.length === 0 && deniedScopes.length === 0,
    missingScopes,
    deniedScopes,
  };
  console.log('[Permissions] checkPermissions result:', result);
  return result;
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
  browserAPI.runtime.sendMessage({ type: 'permissions_changed' }).catch(() => {
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
  const result = await browserAPI.storage.local.get(PERMISSIONS_STORAGE_KEY);
  const allPermissions = (result[PERMISSIONS_STORAGE_KEY] || {}) as Record<string, StoredOriginPermissions>;
  delete allPermissions[origin];
  await browserAPI.storage.local.set({ [PERMISSIONS_STORAGE_KEY]: allPermissions });
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
    await browserAPI.storage.local.set({ [PERMISSIONS_STORAGE_KEY]: allPermissions });
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
      // Extension 1: Core AI & MCP
      'model:prompt': 'not-granted',
      'model:tools': 'not-granted',
      'model:list': 'not-granted',
      'mcp:tools.list': 'not-granted',
      'mcp:tools.call': 'not-granted',
      'mcp:servers.register': 'not-granted',
      // Extension 1: Browser (same-tab)
      'browser:activeTab.read': 'not-granted',
      'browser:activeTab.interact': 'not-granted',
      'browser:activeTab.screenshot': 'not-granted',
      // Extension 2: Navigation and Tabs
      'browser:navigate': 'not-granted',
      'browser:tabs.read': 'not-granted',
      'browser:tabs.create': 'not-granted',
      // Extension 2: Web Fetch
      'web:fetch': 'not-granted',
      // Other
      'chat:open': 'not-granted',
      'addressBar:suggest': 'not-granted',
      'addressBar:context': 'not-granted',
      'addressBar:history': 'not-granted',
      'addressBar:execute': 'not-granted',
      // Extension 3: Multi-Agent (reserved)
      'agents:register': 'not-granted',
      'agents:discover': 'not-granted',
      'agents:invoke': 'not-granted',
      'agents:message': 'not-granted',
      'agents:crossOrigin': 'not-granted',
      'agents:remote': 'not-granted',
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
// Permission Prompt (at most one popup per origin; reuse for same site)
// =============================================================================

type PromptResolve = (result: {
  granted: boolean;
  grantType?: 'granted-once' | 'granted-always';
  allowedTools?: string[];
  explicitDeny?: boolean;
}) => void;

let promptWindowId: number | null = null;
/** Which origin the current prompt is for; we never show more than one popup per site. */
let promptOrigin: string | null = null;
/** Merged state for the current prompt (updated when same origin requests again). */
let promptScopes: PermissionScope[] = [];
let promptTools: string[] = [];
let promptReason: string | undefined;
let promptSessionContext: SessionPromptContext | undefined;
let pendingPromptResolvers: PromptResolve[] = [];

/**
 * Session context for permission prompts.
 */
export interface SessionPromptContext {
  name?: string;
  type?: 'implicit' | 'explicit';
  requestedLLM?: boolean;
  requestedToolsCount?: number;
  requestedBrowser?: ('read' | 'interact' | 'screenshot')[];
}

function buildPromptUrl(opts: {
  origin: string;
  scopes: PermissionScope[];
  reason?: string;
  tools?: string[];
  sessionContext?: SessionPromptContext;
}): string {
  const params = new URLSearchParams({
    origin: opts.origin,
    scopes: opts.scopes.join(','),
  });
  if (opts.reason) params.set('reason', opts.reason);
  if (opts.tools && opts.tools.length > 0) {
    params.set('tools', opts.tools.join(','));
  }
  if (opts.sessionContext) {
    if (opts.sessionContext.name) params.set('sessionName', opts.sessionContext.name);
    if (opts.sessionContext.type) params.set('sessionType', opts.sessionContext.type);
    if (opts.sessionContext.requestedLLM) params.set('llm', 'true');
    if (opts.sessionContext.requestedToolsCount !== undefined) {
      params.set('toolsCount', String(opts.sessionContext.requestedToolsCount));
    }
    if (opts.sessionContext.requestedBrowser && opts.sessionContext.requestedBrowser.length > 0) {
      params.set('browser', opts.sessionContext.requestedBrowser.join(','));
    }
  }
  return browserAPI.runtime.getURL(`dist/permission-prompt.html?${params.toString()}`);
}

function clearPromptState(): void {
  promptWindowId = null;
  promptOrigin = null;
  promptScopes = [];
  promptTools = [];
  promptReason = undefined;
  promptSessionContext = undefined;
  const resolvers = pendingPromptResolvers;
  pendingPromptResolvers = [];
  for (const r of resolvers) {
    r({ granted: false });
  }
}

/**
 * Show permission prompt to user. At most one popup per origin; same-site requests reuse/update the existing popup.
 */
export async function showPermissionPrompt(
  origin: string,
  scopes: PermissionScope[],
  reason?: string,
  requestedTools?: string[],
  sessionContext?: SessionPromptContext,
): Promise<{
  granted: boolean;
  grantType?: 'granted-once' | 'granted-always';
  allowedTools?: string[];
  explicitDeny?: boolean;
}> {
  console.log('[Permissions] showPermissionPrompt called:', { origin, scopes, reason, sessionContext });

  // Same site already has a prompt: merge and reuse so we never show a second popup for this origin
  if (promptOrigin === origin) {
    promptScopes = [...new Set([...promptScopes, ...scopes])];
    promptTools = [...new Set([...promptTools, ...(requestedTools || [])])];
    if (reason) promptReason = reason;
    if (sessionContext) promptSessionContext = sessionContext;

    const promptUrl = buildPromptUrl({
      origin,
      scopes: promptScopes,
      reason: promptReason,
      tools: promptTools,
      sessionContext: promptSessionContext,
    });

    if (promptWindowId !== null) {
      try {
        const win = await browserAPI.windows.get(promptWindowId, { populate: true });
        const tab = (win as chrome.windows.Window).tabs?.[0];
        if (tab?.id) {
          await browserAPI.tabs.update(tab.id, { url: promptUrl });
        }
      } catch {
        // Window may have been closed
        clearPromptState();
        // Fall through to open new window below (we'll set promptOrigin and create)
      }
    }

    if (promptOrigin === origin) {
      return new Promise<{ granted: boolean; grantType?: 'granted-once' | 'granted-always'; allowedTools?: string[]; explicitDeny?: boolean }>((resolve) => {
        pendingPromptResolvers.push(resolve);
      });
    }
  }

  // Different origin or no prompt: close any existing prompt first so we never have more than one
  if (promptWindowId !== null) {
    try {
      await browserAPI.windows.remove(promptWindowId);
    } catch {
      // Window may already be closed
    }
    clearPromptState();
  }

  promptOrigin = origin;
  promptScopes = [...scopes];
  promptTools = requestedTools ? [...requestedTools] : [];
  promptReason = reason;
  promptSessionContext = sessionContext;

  const promptUrl = buildPromptUrl({
    origin,
    scopes: promptScopes,
    reason: promptReason,
    tools: promptTools,
    sessionContext: promptSessionContext,
  });
  console.log('[Permissions] Opening prompt URL:', promptUrl);

  return new Promise((resolve) => {
    pendingPromptResolvers.push(resolve);

    const createPromise = browserAPI.windows.create({
      url: promptUrl,
      type: 'popup',
      width: 450,
      height: 550,
      focused: true,
    });

    if (createPromise && typeof createPromise.then === 'function') {
      createPromise.then((window) => {
        console.log('[Permissions] Window created (promise):', window?.id);
        if (window?.id) {
          promptWindowId = window.id;
        } else {
          console.error('[Permissions] Window creation failed - no window returned');
          clearPromptState();
          resolve({ granted: false });
        }
      }).catch((err) => {
        console.error('[Permissions] Window creation failed:', err);
        clearPromptState();
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
  const resolvers = pendingPromptResolvers;
  pendingPromptResolvers = [];
  for (const r of resolvers) {
    r(response);
  }
  if (promptWindowId !== null) {
    browserAPI.windows.remove(promptWindowId).catch(() => {});
    promptWindowId = null;
  }
  promptOrigin = null;
  promptScopes = [];
  promptTools = [];
  promptReason = undefined;
  promptSessionContext = undefined;
}

// Listen for window close to handle user dismissing the prompt
browserAPI.windows?.onRemoved?.addListener((windowId) => {
  if (windowId === promptWindowId) {
    clearPromptState();
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
  // Extension 1: Core AI & MCP
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
  // Extension 1: Browser (same-tab)
  'browser:activeTab.read': {
    title: 'Read current page',
    description: 'Extract readable text content from this page.',
    risk: 'medium',
  },
  'browser:activeTab.interact': {
    title: 'Interact with this page',
    description: 'Click buttons, fill forms, and scroll on this page only.',
    risk: 'high',
  },
  'browser:activeTab.screenshot': {
    title: 'Take screenshots',
    description: 'Capture screenshots of this page.',
    risk: 'medium',
  },
  // Extension 2: Navigation and Tabs
  'browser:navigate': {
    title: 'Navigate this tab',
    description: 'Navigate the current tab to a different URL.',
    risk: 'high',
  },
  'browser:tabs.read': {
    title: 'See your open tabs',
    description: 'See the URLs and titles of all your open tabs (metadata only, not content).',
    risk: 'medium',
  },
  'browser:tabs.create': {
    title: 'Open and control new tabs',
    description: 'Create new browser tabs and have full control over tabs it creates (read, interact, navigate, close).',
    risk: 'medium',
  },
  // Extension 2: Web Fetch
  'web:fetch': {
    title: 'Make web requests',
    description: 'Proxy HTTP requests through the extension (bypasses CORS for allowed domains).',
    risk: 'high',
  },
  // Other
  'chat:open': {
    title: 'Open chat UI',
    description: 'Open the browser\'s chat interface.',
    risk: 'low',
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
  // Extension 3: Multi-Agent
  'agents:register': {
    title: 'Register as an agent',
    description: 'Register this page as an agent that can be discovered and invoked by other agents.',
    risk: 'low',
  },
  'agents:discover': {
    title: 'Discover other agents',
    description: 'List and find other registered agents.',
    risk: 'medium',
  },
  'agents:invoke': {
    title: 'Invoke other agents',
    description: 'Delegate tasks to other registered agents.',
    risk: 'medium',
  },
  'agents:message': {
    title: 'Message other agents',
    description: 'Send and receive messages to/from other agents.',
    risk: 'medium',
  },
  'agents:crossOrigin': {
    title: 'Cross-origin agent access',
    description: 'Communicate with agents from different websites.',
    risk: 'high',
  },
  'agents:remote': {
    title: 'Connect to remote agents',
    description: 'Connect to agents running on remote servers via A2A protocol.',
    risk: 'high',
  },
};

// Start cleanup interval
setInterval(cleanupExpiredGrants, 60000); // Every minute

// =============================================================================
// Session Capability Checking
// =============================================================================

import type {
  SessionCapabilities,
  AgentSession,
} from '../sessions/types';
import { SessionRegistry } from '../sessions/registry';

/**
 * Check if a session has the required capability, validating against origin permissions.
 * This bridges session-level capabilities with origin-level permissions.
 */
export async function checkSessionCapability(
  session: AgentSession,
  capability: 'llm' | 'tools' | 'browser.read' | 'browser.interact' | 'browser.screenshot',
  tabId?: number,
): Promise<{ allowed: boolean; reason?: string }> {
  const origin = session.origin;

  // Map capability to required origin scope
  const scopeMap: Record<string, PermissionScope> = {
    'llm': 'model:prompt',
    'tools': 'mcp:tools.call',
    'browser.read': 'browser:activeTab.read',
    'browser.interact': 'browser:activeTab.interact',
    'browser.screenshot': 'browser:activeTab.screenshot',
  };

  const requiredScope = scopeMap[capability];
  if (!requiredScope) {
    return { allowed: false, reason: 'Unknown capability' };
  }

  // Check if session has the capability
  let sessionHasCapability = false;
  switch (capability) {
    case 'llm':
      sessionHasCapability = session.capabilities.llm.allowed;
      break;
    case 'tools':
      sessionHasCapability = session.capabilities.tools.allowed;
      break;
    case 'browser.read':
      sessionHasCapability = session.capabilities.browser.readActiveTab;
      break;
    case 'browser.interact':
      sessionHasCapability = session.capabilities.browser.interact;
      break;
    case 'browser.screenshot':
      sessionHasCapability = session.capabilities.browser.screenshot;
      break;
  }

  if (!sessionHasCapability) {
    return { allowed: false, reason: `Session does not have ${capability} capability` };
  }

  // Check if origin has permission for this scope
  const check = await checkPermissions(origin, [requiredScope], tabId);
  if (!check.granted) {
    if (check.deniedScopes.length > 0) {
      return { allowed: false, reason: `Origin permission denied for ${requiredScope}` };
    }
    return { allowed: false, reason: `Origin permission not granted for ${requiredScope}` };
  }

  return { allowed: true };
}

/**
 * Check if a session can call a specific tool, validating against both
 * session capabilities and origin permissions.
 */
export async function checkSessionToolAccess(
  session: AgentSession,
  toolName: string,
  tabId?: number,
): Promise<{ allowed: boolean; reason?: string }> {
  // First check session capability
  if (!session.capabilities.tools.allowed) {
    return { allowed: false, reason: 'Session does not have tool access' };
  }

  // Check if tool is in session's allowed list
  if (!session.capabilities.tools.allowedTools.includes(toolName)) {
    return { allowed: false, reason: `Tool "${toolName}" not in session's allowed tools` };
  }

  // Check origin permission
  const originAllowed = await isToolAllowed(session.origin, toolName);
  if (!originAllowed) {
    return { allowed: false, reason: `Origin does not have permission for tool "${toolName}"` };
  }

  // Check if session has exceeded tool budget
  const budget = SessionRegistry.getRemainingToolBudget(session.sessionId);
  if (budget !== undefined && budget <= 0) {
    return { allowed: false, reason: 'Session tool budget exceeded' };
  }

  return { allowed: true };
}

/**
 * Request permissions for a session's capabilities.
 * Shows permission prompt if needed, bounded by what the session requests.
 */
export async function requestSessionPermissions(
  session: AgentSession,
  tabId?: number,
): Promise<PermissionGrantResult> {
  const requiredScopes: PermissionScope[] = [];

  // Determine required scopes from session capabilities
  if (session.capabilities.llm.allowed) {
    requiredScopes.push('model:prompt');
  }
  if (session.capabilities.tools.allowed) {
    requiredScopes.push('mcp:tools.call');
    if (session.capabilities.tools.allowedTools.length > 0) {
      requiredScopes.push('mcp:tools.list');
    }
  }
  if (session.capabilities.browser.readActiveTab) {
    requiredScopes.push('browser:activeTab.read');
  }
  if (session.capabilities.browser.interact) {
    requiredScopes.push('browser:activeTab.interact');
  }
  if (session.capabilities.browser.screenshot) {
    requiredScopes.push('browser:activeTab.screenshot');
  }

  if (requiredScopes.length === 0) {
    // No permissions needed
    return {
      granted: true,
      scopes: {} as Record<PermissionScope, PermissionGrant>,
    };
  }

  // Build reason string
  const reason = session.reason ||
    (session.name ? `Session "${session.name}" requests access` : undefined);

  // Request permissions through the standard flow
  return requestPermissions(
    session.origin,
    {
      scopes: requiredScopes,
      reason,
      tools: session.capabilities.tools.allowedTools.length > 0
        ? session.capabilities.tools.allowedTools
        : undefined,
    },
    tabId,
  );
}

/**
 * Validate that a session's capabilities are still permitted by origin permissions.
 * Useful after permissions may have been revoked.
 */
export async function validateSessionCapabilities(
  session: AgentSession,
  tabId?: number,
): Promise<{ valid: boolean; invalidCapabilities: string[] }> {
  const invalid: string[] = [];

  // Check LLM
  if (session.capabilities.llm.allowed) {
    const result = await checkSessionCapability(session, 'llm', tabId);
    if (!result.allowed) {
      invalid.push('llm');
    }
  }

  // Check tools
  if (session.capabilities.tools.allowed) {
    const check = await checkPermissions(session.origin, ['mcp:tools.call'], tabId);
    if (!check.granted) {
      invalid.push('tools');
    }
  }

  // Check browser capabilities
  if (session.capabilities.browser.readActiveTab) {
    const result = await checkSessionCapability(session, 'browser.read', tabId);
    if (!result.allowed) {
      invalid.push('browser.read');
    }
  }
  if (session.capabilities.browser.interact) {
    const result = await checkSessionCapability(session, 'browser.interact', tabId);
    if (!result.allowed) {
      invalid.push('browser.interact');
    }
  }
  if (session.capabilities.browser.screenshot) {
    const result = await checkSessionCapability(session, 'browser.screenshot', tabId);
    if (!result.allowed) {
      invalid.push('browser.screenshot');
    }
  }

  return {
    valid: invalid.length === 0,
    invalidCapabilities: invalid,
  };
}
