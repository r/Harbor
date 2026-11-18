/**
 * Permission Handlers
 *
 * Harbor holds the only store of per-origin grants and the only consent
 * prompt. This extension keeps no copy: every check and request goes to
 * Harbor, so a grant revoked in Harbor stops the next page call here.
 *
 * Every failure is closed. If Harbor can't answer (it isn't installed,
 * the request times out, or the browser is Safari, where page calls go to
 * the bridge and Harbor isn't in the path), nothing is granted.
 */

import { harborRequest } from '../harbor-core';
import type { PermissionScope, PermissionGrantType } from '../types';
import type { RequestContext, HandlerResponse } from './types';
import { errorResponse, successResponse } from './types';

/** A permission prompt waits on the user, so give it far longer than a normal call. */
const PERMISSION_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

export interface OriginPermissions {
  scopes: Partial<Record<PermissionScope, PermissionGrantType>>;
  /** Tools the origin may call. Empty means none: there is no "all tools" default. */
  allowedTools: string[];
}

const NOTHING_GRANTED: OriginPermissions = { scopes: {}, allowedTools: [] };

function isGranted(grant: PermissionGrantType | undefined): boolean {
  return grant === 'granted-once' || grant === 'granted-always';
}

/** Accept Harbor's answer only if it has the expected shape. */
function readPermissions(raw: unknown): OriginPermissions | null {
  if (!raw || typeof raw !== 'object') return null;
  const { scopes, allowedTools } = raw as { scopes?: unknown; allowedTools?: unknown };
  if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) return null;
  return {
    scopes: scopes as OriginPermissions['scopes'],
    allowedTools: Array.isArray(allowedTools)
      ? allowedTools.filter((t): t is string => typeof t === 'string')
      : [],
  };
}

// =============================================================================
// Checks
// =============================================================================

/** The origin's grants as Harbor holds them, or nothing if Harbor can't answer. */
export async function getPermissions(origin: string, tabId?: number): Promise<OriginPermissions> {
  try {
    const raw = await harborRequest('permissions.check', { origin, tabId });
    return readPermissions(raw) ?? NOTHING_GRANTED;
  } catch (e) {
    console.warn('[Web Agents API] Permission check failed; treating as not granted:', e);
    return NOTHING_GRANTED;
  }
}

export async function hasPermission(origin: string, scope: PermissionScope, tabId?: number): Promise<boolean> {
  const permissions = await getPermissions(origin, tabId);
  return isGranted(permissions.scopes[scope]);
}

// =============================================================================
// Message Handlers
// =============================================================================

const MULTI_AGENT_SCOPES: PermissionScope[] = ['agents:register', 'agents:invoke'];

export async function handleRequestPermissions(ctx: RequestContext): HandlerResponse {
  const { scopes, reason, tools } = (ctx.payload || {}) as {
    scopes?: PermissionScope[];
    reason?: string;
    tools?: string[];
  };

  if (!Array.isArray(scopes) || scopes.length === 0) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'requestPermissions needs at least one scope');
  }

  // Apps that request model or tool access also get the multi-agent scopes
  // (multi-agent and research apps need them).
  const hasResearchScopes = scopes.some(
    (s) => s === 'model:prompt' || s === 'mcp:tools.call' || s === 'browser:tabs.create'
  );
  const mergedScopes = hasResearchScopes
    ? [...new Set([...scopes, ...MULTI_AGENT_SCOPES])] as PermissionScope[]
    : scopes;

  try {
    const result = await harborRequest<{
      granted?: unknown;
      scopes?: Record<string, PermissionGrantType>;
      allowedTools?: string[];
    }>(
      'permissions.request',
      { origin: ctx.origin, tabId: ctx.tabId, scopes: mergedScopes, reason, tools },
      { timeoutMs: PERMISSION_PROMPT_TIMEOUT_MS },
    );
    if (!result || typeof result.granted !== 'boolean' || !result.scopes) {
      return errorResponse(ctx.id, 'ERR_HARBOR_NOT_FOUND', 'Harbor is needed to grant permissions');
    }
    return successResponse(ctx.id, {
      granted: result.granted,
      scopes: result.scopes,
      allowedTools: Array.isArray(result.allowedTools) ? result.allowedTools : [],
    });
  } catch (e) {
    return errorResponse(
      ctx.id,
      'ERR_HARBOR_NOT_FOUND',
      e instanceof Error ? e.message : 'Harbor is needed to grant permissions',
    );
  }
}

export async function handlePermissionsList(ctx: RequestContext): HandlerResponse {
  const permissions = await getPermissions(ctx.origin, ctx.tabId);
  return successResponse(ctx.id, {
    origin: ctx.origin,
    scopes: permissions.scopes,
    allowedTools: permissions.allowedTools,
  });
}
