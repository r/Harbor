/**
 * Permission request handlers.
 */

import type { RequestPermissionsOptions } from '../types';
import type { RequestContext, ResponseSender } from './router-types';
import { log } from './helpers';
import {
  getPermissionStatus,
  requestPermissions,
} from '../../policy/permissions';

/**
 * Handle agent.requestPermissions - Request permissions from the user.
 */
export async function handleRequestPermissions(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const payload = ctx.payload as RequestPermissionsOptions;
  log('handleRequestPermissions:', ctx.origin, payload);

  const result = await requestPermissions(ctx.origin, payload, ctx.tabId);
  log('Permission result:', result);

  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result,
  });
}

/**
 * Handle agent.permissions.list - List current permission status.
 */
export async function handleListPermissions(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const status = await getPermissionStatus(ctx.origin, ctx.tabId);
  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: status,
  });
}
