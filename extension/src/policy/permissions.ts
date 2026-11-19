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

/**
 * The sites whose agents the origin may reach now, and the strongest of
 * those grants, which is what `agents:crossOrigin` shows as. The scope has no
 * site-wide grant; an old site-wide entry in `scopes` is ignored.
 */
function liveAgentOrigins(
  stored: StoredOriginPermissions | null,
  tabId?: number,
): { origins: string[]; grant: PermissionGrant } {
  const origins: string[] = [];
  let grant: PermissionGrant = 'not-granted';
  for (const [target, permission] of Object.entries(stored?.agentOrigins ?? {})) {
    const effective = getEffectiveGrant(permission, tabId);
    if (effective === 'granted-always' || effective === 'granted-once') {
      origins.push(target);
      if (effective === 'granted-always' || grant === 'not-granted') grant = effective;
    }
  }
  return { origins, grant };
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
  const agentOrigins = liveAgentOrigins(stored, tabId);
  scopes['agents:crossOrigin'] = agentOrigins.grant;

  return {
    origin,
    scopes,
    allowedTools: stored?.allowedTools,
    agentOrigins: agentOrigins.origins,
  };
}

/**
 * Whether the origin may reach agents on `targetOrigin` right now. This is
 * the per-site check behind `agents:crossOrigin`.
 */
export async function isAgentOriginAllowed(
  origin: string,
  targetOrigin: string,
  tabId?: number,
): Promise<boolean> {
  const stored = await loadOriginPermissions(origin);
  return liveAgentOrigins(stored, tabId).origins.includes(targetOrigin);
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
    } else if (grant !== 'granted-once' && grant !== 'granted-always') {
      // Fail closed: a scope with no grant, including one the status map
      // doesn't know, is missing rather than granted.
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
  agentOrigins?: string[],
): Promise<PermissionGrantResult> {
  console.log('[Permissions] grantPermissions:', { origin, scopes, grantType, tabId, allowedTools, agentOrigins });
  
  let stored = await loadOriginPermissions(origin);

  if (!stored) {
    stored = {
      origin,
      scopes: {} as Record<PermissionScope, StoredPermission>,
      allowedTools: [],
    };
  }

  const now = Date.now();
  const grant = (): StoredPermission => ({
    grant: grantType,
    grantedAt: now,
    expiresAt: grantType === 'granted-once' ? now + ONCE_GRANT_DURATION_MS : undefined,
    tabId: grantType === 'granted-once' ? tabId : undefined,
  });

  for (const scope of scopes) {
    // agents:crossOrigin is granted per target site below, never site-wide.
    if (scope === 'agents:crossOrigin') continue;
    stored.scopes[scope] = grant();
  }

  if (scopes.includes('agents:crossOrigin') && agentOrigins && agentOrigins.length > 0) {
    stored.agentOrigins = { ...stored.agentOrigins };
    for (const target of agentOrigins) {
      stored.agentOrigins[target] = grant();
    }
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
  const reachable = liveAgentOrigins(stored, tabId);
  resultScopes['agents:crossOrigin'] = reachable.grant;

  return {
    granted: true,
    scopes: resultScopes,
    allowedTools: stored.allowedTools,
    agentOrigins: reachable.origins,
  };
}

/**
 * Deny permissions for an origin.
 */
export async function denyPermissions(
  origin: string,
  scopes: PermissionScope[],
  agentOrigins?: string[],
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
    // Like grants, an agents:crossOrigin refusal is kept per target site.
    if (scope === 'agents:crossOrigin') continue;
    stored.scopes[scope] = {
      grant: 'denied',
      grantedAt: now,
    };
  }
  if (scopes.includes('agents:crossOrigin') && agentOrigins && agentOrigins.length > 0) {
    stored.agentOrigins = { ...stored.agentOrigins };
    for (const target of agentOrigins) {
      stored.agentOrigins[target] = { grant: 'denied', grantedAt: now };
    }
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

  for (const stored of Object.values(allPermissions)) {
    for (const [target, permission] of Object.entries(stored.agentOrigins ?? {})) {
      if (permission.grant === 'granted-once' && permission.expiresAt && permission.expiresAt < now) {
        delete stored.agentOrigins![target];
        changed = true;
      }
    }
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

    // Shown across tabs, like the scopes above.
    const reachable = liveAgentOrigins(stored);
    scopes['agents:crossOrigin'] = reachable.grant;

    // Only include origins with at least one non-default grant
    const hasGrants = Object.values(scopes).some(g => g !== 'not-granted');
    if (hasGrants) {
      result.push({
        origin,
        scopes,
        allowedTools: stored.allowedTools,
        agentOrigins: reachable.origins,
      });
    }
  }

  return result;
}

// =============================================================================
// Permission Prompt (at most one popup per origin; reuse for same site)
// =============================================================================

export interface PermissionPromptResult {
  granted: boolean;
  grantType?: 'granted-once' | 'granted-always';
  allowedTools?: string[];
  /** The target sites granted for `agents:crossOrigin`: only sites the prompt showed. */
  agentOrigins?: string[];
  explicitDeny?: boolean;
}

type PromptResolve = (result: PermissionPromptResult) => void;

let promptWindowId: number | null = null;
/** Which origin the current prompt is for; we never show more than one popup per site. */
let promptOrigin: string | null = null;
/** Merged state for the current prompt (updated when same origin requests again). */
let promptScopes: PermissionScope[] = [];
let promptTools: string[] = [];
/** Target sites the current prompt asks about for agents:crossOrigin. */
let promptAgentOrigins: string[] = [];
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
  agentOrigins?: string[];
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
  if (opts.agentOrigins && opts.agentOrigins.length > 0) {
    params.set('agentOrigins', opts.agentOrigins.join(','));
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
  return browserAPI.runtime.getURL(`permission-prompt.html?${params.toString()}`);
}

function clearPromptState(): void {
  promptWindowId = null;
  promptOrigin = null;
  promptScopes = [];
  promptTools = [];
  promptAgentOrigins = [];
  promptReason = undefined;
  promptSessionContext = undefined;
  const resolvers = pendingPromptResolvers;
  pendingPromptResolvers = [];
  for (const r of resolvers) {
    r({ granted: false });
  }
}

/**
 * Show permission prompt to user. At most one popup per origin; same-site
 * requests reuse/update the existing popup.
 *
 * `agentOrigins` names the target sites an `agents:crossOrigin` request is
 * for. A merged prompt lists every site its requests asked about, and the
 * answer grants only sites the prompt showed.
 */
export async function showPermissionPrompt(
  origin: string,
  scopes: PermissionScope[],
  reason?: string,
  requestedTools?: string[],
  sessionContext?: SessionPromptContext,
  agentOrigins?: string[],
): Promise<PermissionPromptResult> {
  console.log('[Permissions] showPermissionPrompt called:', { origin, scopes, hasSessionContext: !!sessionContext });

  // Same site already has a prompt: merge and reuse so we never show a second popup for this origin
  if (promptOrigin === origin) {
    promptScopes = [...new Set([...promptScopes, ...scopes])];
    promptTools = [...new Set([...promptTools, ...(requestedTools || [])])];
    promptAgentOrigins = [...new Set([...promptAgentOrigins, ...(agentOrigins || [])])];
    if (reason) promptReason = reason;
    if (sessionContext) promptSessionContext = sessionContext;

    const promptUrl = buildPromptUrl({
      origin,
      scopes: promptScopes,
      reason: promptReason,
      tools: promptTools,
      agentOrigins: promptAgentOrigins,
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
      return new Promise<PermissionPromptResult>((resolve) => {
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
  promptAgentOrigins = agentOrigins ? [...new Set(agentOrigins)] : [];
  promptReason = reason;
  promptSessionContext = sessionContext;

  const promptUrl = buildPromptUrl({
    origin,
    scopes: promptScopes,
    reason: promptReason,
    tools: promptTools,
    agentOrigins: promptAgentOrigins,
    sessionContext: promptSessionContext,
  });
  console.log('[Permissions] Opening permission prompt for', origin);

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
export function handlePermissionPromptResponse(response: PermissionPromptResult): void {
  console.log('[Permissions] handlePermissionPromptResponse:', response);
  // Grant only target sites this prompt asked about: the page echoes the
  // sites it displayed, and a site merged in after it rendered isn't granted.
  const shown = new Set(promptAgentOrigins);
  const answer: PermissionPromptResult = {
    ...response,
    agentOrigins: (response.agentOrigins ?? []).filter((site) => shown.has(site)),
  };
  if (!answer.granted || answer.agentOrigins?.length === 0) delete answer.agentOrigins;
  const resolvers = pendingPromptResolvers;
  pendingPromptResolvers = [];
  for (const r of resolvers) {
    r(answer);
  }
  if (promptWindowId !== null) {
    browserAPI.windows.remove(promptWindowId).catch(() => {});
    promptWindowId = null;
  }
  promptOrigin = null;
  promptScopes = [];
  promptTools = [];
  promptAgentOrigins = [];
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

  // agents:crossOrigin is granted per target site, so a request for it has
  // to say which sites. The other scopes are checked as before.
  const wantsAgentOrigins = scopes.includes('agents:crossOrigin');
  const agentOrigins = [...new Set(options.agentOrigins ?? [])];
  if (wantsAgentOrigins && agentOrigins.length === 0) {
    throw new Error('agents:crossOrigin needs the target sites in agentOrigins');
  }
  const otherScopes = scopes.filter((scope) => scope !== 'agents:crossOrigin');

  // First check current status
  const check = await checkPermissions(origin, otherScopes, tabId);
  const stored = await loadOriginPermissions(origin);
  const deniedTargets = wantsAgentOrigins
    ? agentOrigins.filter((site) => stored?.agentOrigins?.[site]?.grant === 'denied')
    : [];
  const reachable = liveAgentOrigins(stored, tabId).origins;
  const missingTargets = wantsAgentOrigins ? agentOrigins.filter((site) => !reachable.includes(site)) : [];

  // If any scope or site is explicitly denied, return immediately (no re-prompt)
  if (check.deniedScopes.length > 0 || deniedTargets.length > 0) {
    const status = await getPermissionStatus(origin, tabId);
    return {
      granted: false,
      scopes: status.scopes,
      agentOrigins: status.agentOrigins,
    };
  }

  // If all scopes granted, return success
  if (check.granted && missingTargets.length === 0) {
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
      agentOrigins: status.agentOrigins,
    };
  }

  // Need to prompt user
  const askScopes: PermissionScope[] = [
    ...check.missingScopes,
    ...(missingTargets.length > 0 ? ['agents:crossOrigin' as const] : []),
  ];
  const promptResult = await showPermissionPrompt(
    origin,
    askScopes,
    reason,
    tools,
    undefined,
    missingTargets.length > 0 ? missingTargets : undefined,
  );

  if (promptResult.granted && promptResult.grantType) {
    const result = await grantPermissions(
      origin,
      askScopes,
      promptResult.grantType,
      tabId,
      promptResult.allowedTools,
      promptResult.agentOrigins,
    );
    // Granted only if every site asked for is now reachable.
    const now = new Set(result.agentOrigins ?? []);
    const sitesAskedFor = wantsAgentOrigins ? agentOrigins : [];
    return { ...result, granted: sitesAskedFor.every((site) => now.has(site)) };
  } else if (promptResult.explicitDeny) {
    // Only store denial if user explicitly clicked deny (not just dismissed or window failed)
    return denyPermissions(origin, askScopes, missingTargets);
  } else {
    // User dismissed or window failed to open - don't store denial, just return not-granted
    const status = await getPermissionStatus(origin, tabId);
    return {
      granted: false,
      scopes: status.scopes,
      agentOrigins: status.agentOrigins,
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
    title: 'Use agents on other sites',
    description: 'Call, message and see the agents registered by the sites listed below, and no others. Those agents act with their own site\'s data and tools.',
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
