/**
 * Shared helper functions for request handlers.
 */

import type { PermissionScope } from '../types';
import type { RequestContext, ResponseSender } from './router-types';
import { checkPermissions } from '../../policy/permissions';

const DEBUG = false;

export function log(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[Harbor Router]', ...args);
  }
}

/**
 * Check if the origin has a required permission scope.
 * Sends an error response if not granted.
 * @returns true if permission is granted, false otherwise
 */
export async function requirePermission(
  ctx: RequestContext,
  sender: ResponseSender,
  scope: PermissionScope,
): Promise<boolean> {
  log('requirePermission check - origin:', ctx.origin, 'scope:', scope, 'tabId:', ctx.tabId);
  const result = await checkPermissions(ctx.origin, [scope], ctx.tabId);
  log('requirePermission result:', JSON.stringify(result));
  
  if (result.granted) {
    return true;
  }

  sender.sendResponse({
    id: ctx.id,
    ok: false,
    error: {
      code: 'ERR_SCOPE_REQUIRED',
      message: `Permission "${scope}" is required. Call agent.requestPermissions() first.`,
      details: { requiredScope: scope, missingScopes: result.missingScopes },
    },
  });
  return false;
}
