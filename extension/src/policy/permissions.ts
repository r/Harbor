/**
 * Web Agent API Permission System
 *
 * Handles permission enforcement, grants, and prompt logic.
 */

import { browserAPI } from '../browser-compat';
import { resolveConsentAgentName } from './agent-consent';
import { currentBackendTag, effectiveGrantForBackend, withBackendAllow, withUniversalDeny, type BackendTag } from './backend-grant';
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

/**
 * `scope` and `currentBackend` are optional so every existing call site
 * that doesn't care about backend-scoping (nothing outside this file
 * currently calls this with them) keeps working — but every call site
 * inside this file now passes both, since `model:prompt`/`model:tools` are
 * reachable from any of them. Delegates to `backend-grant.ts`'s
 * `effectiveGrantForBackend`, the one place that knows a deny is
 * universal but an allow is per-backend (maintainer decision, 2026-11-19).
 */
function getEffectiveGrant(
  stored: StoredPermission | undefined,
  tabId?: number,
  scope?: PermissionScope,
  currentBackend?: BackendTag,
): PermissionGrant {
  if (scope && currentBackend) {
    return effectiveGrantForBackend(stored, scope, currentBackend, Date.now(), tabId);
  }
  // No scope/backend given: the old flat-grant behaviour, for isToolAllowed's
  // mcp:tools.call check below (never backend-scoped).
  return effectiveGrantForBackend(stored, 'mcp:tools.call', 'builtin', Date.now(), tabId);
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Get the current permission status for an origin.
 */
export async function getPermissionStatus(origin: string, tabId?: number): Promise<PermissionStatus> {
  const stored = await loadOriginPermissions(origin);
  const currentBackend = await currentBackendTag();

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
      scopes[scope] = getEffectiveGrant(stored.scopes[scope], tabId, scope, currentBackend);
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
 * Grant permissions for an origin. `backendOverride`, when given, is the
 * backend to stamp a backend-scoped allow (model:prompt/model:tools) for,
 * instead of a live read of the currently selected one — used when the
 * grant follows a prompt that already named a specific backend
 * (`requestPermissions`/`showPermissionPrompt`'s `backendTag`), so a
 * switch *while the prompt was open* can't make the allow land on the
 * wrong backend.
 */
export async function grantPermissions(
  origin: string,
  scopes: PermissionScope[],
  grantType: 'granted-once' | 'granted-always',
  tabId?: number,
  allowedTools?: string[],
  backendOverride?: BackendTag,
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
  // For a backend-scoped scope (model:prompt/model:tools), the new allow
  // is added under this backend without disturbing any other backend's own
  // allow (withBackendAllow); every other scope keeps the old flat shape.
  const backend = backendOverride ?? await currentBackendTag();
  const expiresAt = grantType === 'granted-once' ? now + ONCE_GRANT_DURATION_MS : undefined;
  const grantTabId = grantType === 'granted-once' ? tabId : undefined;

  for (const scope of scopes) {
    stored.scopes[scope] = withBackendAllow(stored.scopes[scope], scope, backend, grantType, now, {
      expiresAt, tabId: grantTabId,
    });
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
    resultScopes[scope] = getEffectiveGrant(stored.scopes[scope], tabId, scope, backend);
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
    // A deny is universal (maintainer decision, 2026-11-19): it applies
    // under every backend, and clears every backend's own allow for this
    // scope — withUniversalDeny never carries a backend or an `allows` map.
    stored.scopes[scope] = withUniversalDeny(now);
  }

  await saveOriginPermissions(stored);

  // Build result. A denial is reported as-is here — this is the direct
  // result of *this* deny call, not a general status read, so there's no
  // "current backend" to reconcile against (unlike getEffectiveGrant,
  // which checkPermissions/getPermissionStatus use for that). A universal
  // deny reports the same either way.
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
      // A per-backend once-allow (model:prompt/model:tools) is already
      // read as not-live past its own expiry (effectiveGrantForBackend),
      // so this is tidiness, not correctness — but it's the same stored
      // grant shape every other reader here was checked against, so it's
      // swept the same way.
      if (permission.allows) {
        for (const [backendTag, allow] of Object.entries(permission.allows)) {
          if (allow.grant === 'granted-once' && allow.expiresAt && allow.expiresAt < now) {
            delete permission.allows[backendTag];
            changed = true;
          }
        }
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

    let backendAllows: Partial<Record<PermissionScope, Record<string, PermissionGrant>>> | undefined;

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

        // `model:prompt`/`model:tools` can hold a *separate* allow per
        // backend (policy/backend-grant.ts), which never shows up in the
        // flat `grant` field above once it exists — a site holding only
        // one of these would otherwise vanish from this list entirely,
        // with no way to see or revoke it. Each live (non-expired) allow
        // is reported here, by the backend tag it was given for.
        if (storedPerm.allows) {
          for (const [backendTag, allow] of Object.entries(storedPerm.allows)) {
            const live = allow.grant === 'granted-once' && allow.expiresAt && allow.expiresAt < now
              ? 'not-granted'
              : allow.grant;
            if (live === 'not-granted') continue;
            backendAllows ??= {};
            backendAllows[scope] ??= {};
            backendAllows[scope]![backendTag] = live;
          }
        }
      }
    }

    // Only include origins with at least one non-default grant — either
    // the flat per-scope grant, or a backend-scoped allow living only in
    // `backendAllows`.
    const hasGrants = Object.values(scopes).some(g => g !== 'not-granted') ||
      (backendAllows !== undefined && Object.keys(backendAllows).length > 0);
    if (hasGrants) {
      result.push({
        origin,
        scopes,
        backendAllows,
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
  backendTag?: BackendTag;
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
 * The backend this prompt actually named, recorded here by
 * `showPermissionPrompt` the moment it builds the prompt's own URL —
 * never read back from the popup's response message. The popup's
 * `response.backendTag` only echoes the URL param it was given
 * (permission-prompt.ts), but that message crosses a process boundary
 * (`browserAPI.runtime.sendMessage`) the background doesn't otherwise
 * trust for anything else it decides with — a compromised or buggy
 * sender could claim any backend it likes. This is the one value
 * `handlePermissionPromptResponse` actually grants against; a mismatched
 * echo (or none at all) changes nothing, since it's never consulted.
 */
let promptBackendTag: BackendTag | undefined;

/**
 * Registers `resolve` as one of the answers the currently-open prompt will
 * settle (`handlePermissionPromptResponse` calls every registered
 * resolver with the same response) — or, when `signal` is given and fires
 * first, pulls `resolve` back out and settles it early with `{granted:
 * false}` instead, without ever calling `grantPermissions` for it (that
 * only happens in `requestPermissions`, after its own call to
 * `showPermissionPrompt` resolves). This is what makes a page's own
 * giving-up (its client-side request timeout, or its tab/port closing —
 * either one aborts `signal`, see page-api/background.ts) something this
 * prompt actually acts on, rather than leaving a stale caller to be
 * resolved, maybe much later, by a person answering a popup the page
 * stopped listening to.
 *
 * If this was the only resolver still waiting on the prompt once removed,
 * the popup itself is closed too — there is nobody left for its eventual
 * answer to reach, so leaving it open would just be a dangling window.
 * Other callers (same-origin requests merged into this same prompt, see
 * the "reuse" branch below) and other origins' own prompts are untouched.
 */
function registerPromptResolver(resolve: PromptResolve, signal?: AbortSignal): void {
  if (!signal) {
    pendingPromptResolvers.push(resolve);
    return;
  }
  // The page could already have given up by the time its own call reaches
  // here (several awaits — resolveConsentAgentName, currentBackendTag, a
  // same-origin merge's own window.get/tabs.update — sit between a
  // request arriving and this point). `addEventListener('abort', ...)`
  // never replays a past event, so this is checked explicitly rather than
  // relying on one firing later; never pushed in the first place.
  if (signal.aborted) {
    resolve({ granted: false });
    return;
  }

  let settled = false;
  const wrapped: PromptResolve = (result) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener('abort', onAbort);
    resolve(result);
  };
  const onAbort = (): void => {
    if (settled) return;
    settled = true;
    const idx = pendingPromptResolvers.indexOf(wrapped);
    if (idx !== -1) pendingPromptResolvers.splice(idx, 1);
    resolve({ granted: false });
    if (pendingPromptResolvers.length === 0 && promptWindowId !== null) {
      const windowId = promptWindowId;
      browserAPI.windows.remove(windowId).catch(() => {});
      clearPromptState();
    }
  };
  signal.addEventListener('abort', onAbort);
  pendingPromptResolvers.push(wrapped);
}

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
  agentName?: string | null;
  backendTag: BackendTag;
}): string {
  const params = new URLSearchParams({
    origin: opts.origin,
    scopes: opts.scopes.join(','),
    // The backend selected right now, when the prompt is shown —
    // permission-prompt.ts echoes this back unchanged in its response, so
    // the grant lands on the backend the prompt actually named even if the
    // person switches backends while the popup is still open (item 3,
    // docs/ACP_BACKEND_DESIGN.md).
    backendTag: opts.backendTag,
  });
  if (opts.reason) params.set('reason', opts.reason);
  // Names where a model:prompt/model:tools request actually goes when the
  // person has selected an ACP agent — permission-prompt.ts switches those
  // two scopes' wording on it (agent-consent-copy.ts). Absent (or null)
  // when no agent is selected, leaving the built-in wording untouched.
  if (opts.agentName) params.set('agent', opts.agentName);
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
  return browserAPI.runtime.getURL(`permission-prompt.html?${params.toString()}`);
}

function clearPromptState(): void {
  promptWindowId = null;
  promptOrigin = null;
  promptScopes = [];
  promptTools = [];
  promptReason = undefined;
  promptSessionContext = undefined;
  promptBackendTag = undefined;
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
  // Aborts when *this* call's own page has given up — see
  // registerPromptResolver. Optional: callers with nothing of their own to
  // watch (none today) simply never discard early.
  signal?: AbortSignal,
): Promise<{
  granted: boolean;
  grantType?: 'granted-once' | 'granted-always';
  allowedTools?: string[];
  explicitDeny?: boolean;
  backendTag?: BackendTag;
}> {
  console.log('[Permissions] showPermissionPrompt called:', { origin, scopes, hasSessionContext: !!sessionContext });

  // Resolved once per call, from the same snapshot: null (agentName) /
  // 'builtin' whenever no ACP agent is selected, which is the common case,
  // so this never makes the built-in prompt wait on the bridge for no
  // reason. `backendTag` travels with the prompt and comes back unchanged
  // in its response (item 3) — it's the backend the prompt actually named,
  // not whatever is selected when the person answers.
  const agentName = await resolveConsentAgentName();
  const backendTag = await currentBackendTag();

  // Same site already has a prompt: merge and reuse so we never show a second popup for this origin
  if (promptOrigin === origin) {
    promptScopes = [...new Set([...promptScopes, ...scopes])];
    promptTools = [...new Set([...promptTools, ...(requestedTools || [])])];
    if (reason) promptReason = reason;
    if (sessionContext) promptSessionContext = sessionContext;
    // Re-recorded on every merge, same as the URL itself is rebuilt below
    // — a later request for the same origin can find a different live
    // backend than the first one did, and the popup's own URL is updated
    // to match, so the background's own record must track that update.
    promptBackendTag = backendTag;

    const promptUrl = buildPromptUrl({
      origin,
      scopes: promptScopes,
      reason: promptReason,
      tools: promptTools,
      sessionContext: promptSessionContext,
      agentName,
      backendTag,
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
      return new Promise<{ granted: boolean; grantType?: 'granted-once' | 'granted-always'; allowedTools?: string[]; explicitDeny?: boolean; backendTag?: BackendTag }>((resolve) => {
        registerPromptResolver(resolve, signal);
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
  promptBackendTag = backendTag;

  const promptUrl = buildPromptUrl({
    origin,
    scopes: promptScopes,
    reason: promptReason,
    tools: promptTools,
    sessionContext: promptSessionContext,
    agentName,
    backendTag,
  });
  console.log('[Permissions] Opening permission prompt for', origin);

  return new Promise((resolve) => {
    registerPromptResolver(resolve, signal);

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
 *
 * `response.backendTag` — the popup's own echo of the URL param it was
 * given — is never trusted here: this uses `promptBackendTag`, the
 * background's own record of the backend it stamped this exact prompt
 * with (`showPermissionPrompt`), and ignores the message's own field
 * entirely, mismatched or not. The popup has no other way to influence
 * which backend a grant lands on than its buttons' own `granted`/
 * `grantType`/`allowedTools`/`explicitDeny` choices.
 */
export function handlePermissionPromptResponse(response: {
  granted: boolean;
  grantType?: 'granted-once' | 'granted-always';
  allowedTools?: string[];
  explicitDeny?: boolean;
  backendTag?: BackendTag;
}): void {
  console.log('[Permissions] handlePermissionPromptResponse:', response);
  const resolvers = pendingPromptResolvers;
  const resolvedBackendTag = promptBackendTag;
  pendingPromptResolvers = [];
  for (const r of resolvers) {
    r({ ...response, backendTag: resolvedBackendTag });
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
  promptBackendTag = undefined;
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
 * Handle a permission request from a web page. `signal`, when given,
 * aborts if the page's own request gives up first (its client-side
 * timeout, or its tab/port closing) — forwarded to `showPermissionPrompt`
 * so a prompt this call is waiting on closes, or discards this call's own
 * answer, instead of still granting once nobody on the page's side is
 * listening for the result.
 */
export async function requestPermissions(
  origin: string,
  options: RequestPermissionsOptions,
  tabId?: number,
  signal?: AbortSignal,
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
        const promptResult = await showPermissionPrompt(origin, ['mcp:tools.call'], reason, missingTools, undefined, signal);
        if (promptResult.granted && promptResult.grantType) {
          return grantPermissions(origin, [], promptResult.grantType, tabId, promptResult.allowedTools, promptResult.backendTag);
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
  const promptResult = await showPermissionPrompt(origin, check.missingScopes, reason, tools, undefined, signal);

  if (promptResult.granted && promptResult.grantType) {
    // promptResult.backendTag is the backend the prompt itself named (the
    // one selected when it was shown), not whatever is selected right now
    // — a switch while the popup was open must not change which backend
    // the resulting allow lands on (item 3, docs/ACP_BACKEND_DESIGN.md).
    return grantPermissions(origin, check.missingScopes, promptResult.grantType, tabId, promptResult.allowedTools, promptResult.backendTag);
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
