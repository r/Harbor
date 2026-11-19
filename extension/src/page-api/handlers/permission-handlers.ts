/**
 * Permission Handlers
 *
 * Harbor holds the only store of per-origin grants and the only consent
 * prompt. This extension keeps no copy: every check and request goes to
 * Harbor, so a grant revoked in Harbor stops the next page call here.
 *
 * Every failure is closed. If Harbor can't answer (for example, the
 * request times out), nothing is granted.
 */

import { checkPageAction, harborRequest, type PageBrowserAction } from '../harbor-core';
import type { PermissionScope, PermissionGrantType, TransportResponse } from '../types';
import type { RequestContext, HandlerResponse } from './types';
import { errorResponse, successResponse } from './types';

/** A permission prompt waits on the user, so give it far longer than a normal call. */
const PERMISSION_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

export interface OriginPermissions {
  scopes: Partial<Record<PermissionScope, PermissionGrantType>>;
  /** Tools the origin may call. Empty means none: there is no "all tools" default. */
  allowedTools: string[];
  /** Sites whose agents the origin may reach. Empty means none. */
  agentOrigins: string[];
}

const NOTHING_GRANTED: OriginPermissions = { scopes: {}, allowedTools: [], agentOrigins: [] };

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function isGranted(grant: PermissionGrantType | undefined): boolean {
  return grant === 'granted-once' || grant === 'granted-always';
}

/** Accept Harbor's answer only if it has the expected shape. */
function readPermissions(raw: unknown): OriginPermissions | null {
  if (!raw || typeof raw !== 'object') return null;
  const { scopes, allowedTools, agentOrigins } = raw as { scopes?: unknown; allowedTools?: unknown; agentOrigins?: unknown };
  if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) return null;
  return {
    scopes: scopes as OriginPermissions['scopes'],
    allowedTools: stringList(allowedTools),
    agentOrigins: stringList(agentOrigins),
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

export async function handleRequestPermissions(ctx: RequestContext): HandlerResponse {
  const { scopes, reason, tools, agentOrigins } = (ctx.payload || {}) as {
    scopes?: PermissionScope[];
    reason?: string;
    tools?: string[];
    /** The sites an agents:crossOrigin request is for. */
    agentOrigins?: string[];
  };

  if (!Array.isArray(scopes) || scopes.length === 0) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'requestPermissions needs at least one scope');
  }
  if (scopes.includes('agents:crossOrigin') && (!Array.isArray(agentOrigins) || agentOrigins.length === 0)) {
    return errorResponse(
      ctx.id,
      'ERR_INVALID_REQUEST',
      'agents:crossOrigin is granted per site: name the sites in agentOrigins, such as ["https://example.com"]',
    );
  }

  try {
    const result = await harborRequest<{
      granted?: unknown;
      scopes?: Record<string, PermissionGrantType>;
      allowedTools?: string[];
      agentOrigins?: string[];
    }>(
      'permissions.request',
      // Ask for exactly the scopes the page named, each once.
      { origin: ctx.origin, tabId: ctx.tabId, scopes: [...new Set(scopes)], reason, tools, agentOrigins },
      { timeoutMs: PERMISSION_PROMPT_TIMEOUT_MS },
    );
    if (!result || typeof result.granted !== 'boolean' || !result.scopes) {
      return errorResponse(ctx.id, 'ERR_HARBOR_NOT_FOUND', 'Harbor is needed to grant permissions');
    }
    return successResponse(ctx.id, {
      granted: result.granted,
      scopes: result.scopes,
      allowedTools: Array.isArray(result.allowedTools) ? result.allowedTools : [],
      agentOrigins: stringList(result.agentOrigins),
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
    agentOrigins: permissions.agentOrigins,
  });
}

// =============================================================================
// Policy gate for browser and tab calls
// =============================================================================

/**
 * Run a browser or tab call past Harbor's PolicyEngine after its grant
 * check. Returns the error response to send, or `null` to proceed.
 * `host` defaults to the calling page's own host.
 *
 * A policy rule or the watchdog can make Harbor ask first. If the page gave
 * up on the request while it waited (its own timeout aborts it), the call is
 * refused even when the user then allows it, so the page never sees an
 * error for an action that went on to happen.
 */
export async function policyRefusal(
  ctx: RequestContext,
  action: PageBrowserAction,
  host: string = hostOf(ctx.origin),
  options: { pageFetch?: boolean } = {},
): Promise<TransportResponse | null> {
  const refusal = await checkPageAction(ctx, action, { host }, options);
  if (refusal) return errorResponse(ctx.id, refusal.code, refusal.message);
  if (ctx.signal?.aborted) {
    return errorResponse(ctx.id, 'ERR_ABORTED', 'The page stopped waiting for this call');
  }
  return null;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return '';
  }
}
