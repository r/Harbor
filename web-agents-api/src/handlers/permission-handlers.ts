/**
 * Permission Handlers
 * 
 * Handles permission requests, storage, and prompts.
 */

import { harborRequest } from '../harbor-client';
import type { PermissionScope, PermissionGrantType } from '../types';
import type { RequestContext, HandlerResponse, StoredPermissions } from './types';
import { errorResponse, successResponse } from './types';

// =============================================================================
// Constants
// =============================================================================

const PERMISSION_KEY_PREFIX = 'permissions:';

// =============================================================================
// Permission Storage
// =============================================================================

export async function getPermissions(origin: string): Promise<StoredPermissions> {
  const key = PERMISSION_KEY_PREFIX + origin;
  const result = await chrome.storage.local.get(key);
  return result[key] || { scopes: {} };
}

export async function savePermissions(origin: string, permissions: StoredPermissions): Promise<void> {
  const key = PERMISSION_KEY_PREFIX + origin;
  await chrome.storage.local.set({ [key]: permissions });
}

export async function checkPermission(origin: string, scope: PermissionScope): Promise<PermissionGrantType> {
  const permissions = await getPermissions(origin);
  const grant = permissions.scopes[scope];
  
  if (!grant) {
    return 'not-granted';
  }
  
  // Check expiration for granted-once
  if (grant.type === 'granted-once' && grant.expiresAt) {
    if (Date.now() > grant.expiresAt) {
      return 'not-granted';
    }
  }
  
  return grant.type;
}

export async function hasPermission(origin: string, scope: PermissionScope): Promise<boolean> {
  const status = await checkPermission(origin, scope);
  return status === 'granted-once' || status === 'granted-always';
}

export async function listAllPermissions(): Promise<Array<{
  origin: string;
  scopes: Record<string, PermissionGrantType>;
  allowedTools?: string[];
}>> {
  const result = await chrome.storage.local.get(null);
  const entries: Array<{
    origin: string;
    scopes: Record<string, PermissionGrantType>;
    allowedTools?: string[];
  }> = [];

  for (const [key, value] of Object.entries(result)) {
    if (!key.startsWith(PERMISSION_KEY_PREFIX)) continue;
    const origin = key.slice(PERMISSION_KEY_PREFIX.length);
    const permissions = (value || { scopes: {} }) as StoredPermissions;
    const scopes: Record<string, PermissionGrantType> = {};

    for (const [scope, grant] of Object.entries(permissions.scopes || {})) {
      if (grant.type === 'granted-once' && grant.expiresAt && Date.now() > grant.expiresAt) {
        scopes[scope] = 'not-granted';
      } else {
        scopes[scope] = grant.type;
      }
    }

    entries.push({
      origin,
      scopes,
      allowedTools: permissions.allowedTools,
    });
  }

  return entries;
}

export async function revokeOriginPermissions(origin: string): Promise<void> {
  const key = PERMISSION_KEY_PREFIX + origin;
  await chrome.storage.local.remove(key);
}

// =============================================================================
// Permission Prompt
// =============================================================================

interface PermissionPromptResponse {
  promptId: string;
  granted: boolean;
  grantType?: 'granted-once' | 'granted-always';
  allowedTools?: string[];
  explicitDeny?: boolean;
}

interface PendingPrompt {
  resolvers: Array<(response: PermissionPromptResponse) => void>;
  windowId?: number;
  origin: string;
  currentScopes: PermissionScope[];
  currentTools: string[];
  currentReason?: string;
}

const pendingPermissionPrompts = new Map<string, PendingPrompt>();
/** Tracks which origin has an open prompt so we update it instead of opening a second one. */
const openPromptByOrigin = new Map<string, string>(); // origin -> promptId
let promptIdCounter = 0;

function generatePromptId(): string {
  return `prompt-${Date.now()}-${++promptIdCounter}`;
}

export function resolvePromptClosed(windowId: number): void {
  for (const [promptId, pending] of pendingPermissionPrompts.entries()) {
    if (pending.windowId === windowId) {
      pendingPermissionPrompts.delete(promptId);
      openPromptByOrigin.delete(pending.origin);
      const response = { promptId, granted: false };
      for (const resolve of pending.resolvers) resolve(response);
      return;
    }
  }
}

export function handlePermissionPromptResponse(response: PermissionPromptResponse): boolean {
  let promptId = response.promptId;
  if (!promptId && pendingPermissionPrompts.size === 1) {
    promptId = Array.from(pendingPermissionPrompts.keys())[0];
  }

  const pending = promptId ? pendingPermissionPrompts.get(promptId) : undefined;
  if (!pending) {
    return false;
  }

  pendingPermissionPrompts.delete(promptId);
  openPromptByOrigin.delete(pending.origin);
  if (pending.windowId) {
    chrome.windows.remove(pending.windowId);
  }

  const fullResponse = { ...response, promptId };
  for (const resolve of pending.resolvers) resolve(fullResponse);
  return true;
}

function buildPromptUrl(params: {
  promptId: string;
  origin: string;
  scopes: PermissionScope[];
  reason?: string;
  tools?: string[];
}): string {
  const url = new URL(chrome.runtime.getURL('permission-prompt.html'));
  url.searchParams.set('promptId', params.promptId);
  url.searchParams.set('origin', params.origin);
  if (params.scopes.length > 0) {
    url.searchParams.set('scopes', params.scopes.join(','));
  }
  if (params.reason) {
    url.searchParams.set('reason', params.reason);
  }
  if (params.tools && params.tools.length > 0) {
    url.searchParams.set('tools', params.tools.join(','));
  }
  return url.toString();
}

async function openPermissionPrompt(options: {
  origin: string;
  scopes: PermissionScope[];
  reason?: string;
  tools?: string[];
}): Promise<PermissionPromptResponse> {
  const existingPromptId = openPromptByOrigin.get(options.origin);
  if (existingPromptId) {
    const pending = pendingPermissionPrompts.get(existingPromptId);
    if (pending) {
      // Same site already has a prompt (window may or may not exist yet). Merge and reuse so we never show a second popup for this origin.
      const mergedScopes = [...new Set([...pending.currentScopes, ...options.scopes])];
      const mergedTools = [...new Set([...pending.currentTools, ...(options.tools || [])])];
      const mergedReason = options.reason || pending.currentReason;
      pending.currentScopes = mergedScopes;
      pending.currentTools = mergedTools;
      pending.currentReason = mergedReason;

      if (pending.windowId != null) {
        const newUrl = buildPromptUrl({
          promptId: existingPromptId,
          origin: options.origin,
          scopes: mergedScopes,
          reason: mergedReason,
          tools: mergedTools,
        });
        try {
          const win = await chrome.windows.get(pending.windowId, { populate: true });
          const tab = win.tabs?.[0];
          if (tab?.id) {
            await chrome.tabs.update(tab.id, { url: newUrl });
          }
        } catch {
          // Window may have been closed; resolvers will be resolved when we detect it
        }
      }
      // Attach this caller to the existing prompt (whether window exists yet or not)
      return new Promise((resolve) => {
        pending.resolvers.push(resolve);
      });
    }
    // Stale entry (promptId in map but no pending); remove and create new prompt below
    openPromptByOrigin.delete(options.origin);
  }

  const promptId = generatePromptId();
  const pending: PendingPrompt = {
    resolvers: [],
    origin: options.origin,
    currentScopes: options.scopes,
    currentTools: options.tools || [],
    currentReason: options.reason,
  };
  pendingPermissionPrompts.set(promptId, pending);
  openPromptByOrigin.set(options.origin, promptId);

  return new Promise((resolve) => {
    pending.resolvers.push(resolve);

    // Use current merged state (may have been updated by a concurrent request for same origin)
    const url = buildPromptUrl({
      promptId,
      origin: options.origin,
      scopes: pending.currentScopes,
      reason: pending.currentReason,
      tools: pending.currentTools,
    });

    chrome.windows.create(
      {
        url,
        type: 'popup',
        width: 480,
        height: 640,
      },
      (createdWindow) => {
        if (chrome.runtime.lastError || !createdWindow?.id) {
          pendingPermissionPrompts.delete(promptId);
          openPromptByOrigin.delete(options.origin);
          resolve({ promptId, granted: false });
          return;
        }

        const p = pendingPermissionPrompts.get(promptId);
        if (p) {
          p.windowId = createdWindow.id;
          // In case more requests merged while we were creating, refresh the tab to show latest
          const mergedUrl = buildPromptUrl({
            promptId,
            origin: p.origin,
            scopes: p.currentScopes,
            reason: p.currentReason,
            tools: p.currentTools,
          });
          chrome.windows.get(createdWindow.id, { populate: true }).then((win) => {
            const tab = win.tabs?.[0];
            if (tab?.id && tab.url !== mergedUrl) {
              chrome.tabs.update(tab.id, { url: mergedUrl });
            }
          }).catch(() => {});
        }
      },
    );
  });
}

export async function showPermissionPrompt(
  origin: string,
  scopes: PermissionScope[],
  reason?: string,
  tools?: string[],
): Promise<{ granted: boolean; scopes: Record<PermissionScope, PermissionGrantType>; allowedTools?: string[] }> {
  const permissions = await getPermissions(origin);
  const result: Record<PermissionScope, PermissionGrantType> = {} as Record<PermissionScope, PermissionGrantType>;
  const scopesToRequest: PermissionScope[] = [];
  const requestedTools = tools && tools.length > 0 ? tools : [];
  const existingAllowedTools = permissions.allowedTools || [];
  const missingTools = requestedTools.filter((tool) => !existingAllowedTools.includes(tool));
  
  for (const scope of scopes) {
    // Check if already granted
    const existing = await checkPermission(origin, scope);
    if (existing === 'granted-once' || existing === 'granted-always') {
      result[scope] = existing;
      continue;
    }
    
    if (existing === 'denied') {
      result[scope] = 'denied';
      continue;
    }

    scopesToRequest.push(scope);
  }

  let didUpdatePermissions = false;

  if (scopesToRequest.length > 0) {
    const promptResponse = await openPermissionPrompt({ origin, scopes: scopesToRequest, reason, tools });

    if (promptResponse.granted) {
      const grantType = promptResponse.grantType || 'granted-once';
      for (const scope of scopesToRequest) {
        const grant = {
          type: grantType as PermissionGrantType,
          grantedAt: Date.now(),
          expiresAt: grantType === 'granted-once' ? Date.now() + 10 * 60 * 1000 : undefined,
        };
        permissions.scopes[scope] = grant;
        result[scope] = grant.type;
      }

      if (promptResponse.allowedTools && promptResponse.allowedTools.length > 0) {
        permissions.allowedTools = [
          ...new Set([...(permissions.allowedTools || []), ...promptResponse.allowedTools]),
        ];
      }

      didUpdatePermissions = true;
    } else {
      for (const scope of scopesToRequest) {
        if (promptResponse.explicitDeny) {
          permissions.scopes[scope] = { type: 'denied', grantedAt: Date.now() };
          result[scope] = 'denied';
          didUpdatePermissions = true;
        } else {
          result[scope] = 'not-granted';
        }
      }
    }
  }

  if (scopesToRequest.length === 0 && missingTools.length > 0) {
    const promptResponse = await openPermissionPrompt({
      origin,
      scopes: ['mcp:tools.call'],
      reason,
      tools: missingTools,
    });

    if (promptResponse.granted && promptResponse.allowedTools && promptResponse.allowedTools.length > 0) {
      permissions.allowedTools = [
        ...new Set([...(permissions.allowedTools || []), ...promptResponse.allowedTools]),
      ];
      didUpdatePermissions = true;
    }
  }

  if (didUpdatePermissions) {
    await savePermissions(origin, permissions);
    
    // Sync granted permissions to Harbor so it can enforce them
    const grantedScopes = Object.entries(result)
      .filter(([, grant]) => grant === 'granted-once' || grant === 'granted-always')
      .map(([scope]) => scope as PermissionScope);
    
    if (grantedScopes.length > 0) {
      const grantType = result[grantedScopes[0]]; // Use the same grant type
      try {
        await harborRequest('system.syncPermissions', {
          origin,
          scopes: grantedScopes,
          grantType,
          allowedTools: permissions.allowedTools,
        });
        console.log('[Web Agents API] Synced permissions to Harbor:', grantedScopes);
      } catch (e) {
        console.warn('[Web Agents API] Failed to sync permissions to Harbor:', e);
        // Continue even if sync fails - local permissions still work
      }
    }
  }
  
  const allGranted = scopes.every(s => result[s] === 'granted-once' || result[s] === 'granted-always');
  
  return {
    granted: allGranted,
    scopes: result,
    allowedTools: permissions.allowedTools,
  };
}

// =============================================================================
// Message Handlers
// =============================================================================

export async function handleRequestPermissions(ctx: RequestContext): HandlerResponse {
  const { scopes, reason, tools } = ctx.payload as {
    scopes: PermissionScope[];
    reason?: string;
    tools?: string[];
  };

  const result = await showPermissionPrompt(ctx.origin, scopes, reason, tools);
  return successResponse(ctx.id, result);
}

export async function handlePermissionsList(ctx: RequestContext): HandlerResponse {
  const permissions = await getPermissions(ctx.origin);
  const scopes: Record<string, PermissionGrantType> = {};
  
  for (const [scope, grant] of Object.entries(permissions.scopes)) {
    // Check expiration
    if (grant.type === 'granted-once' && grant.expiresAt && Date.now() > grant.expiresAt) {
      scopes[scope] = 'not-granted';
    } else {
      scopes[scope] = grant.type;
    }
  }
  
  return successResponse(ctx.id, {
    origin: ctx.origin,
    scopes,
    allowedTools: permissions.allowedTools,
  });
}
