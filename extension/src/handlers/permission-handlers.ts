/**
 * Permission Handlers
 *
 * Handlers for the sidebar's permission management. Harbor holds the only
 * store of per-origin grants; the Web Agents API reads it through the
 * extension API, so there is nothing to merge or revoke elsewhere.
 */

import { registerHandler, errorResponse } from './types';
import { browserAPI } from '../browser-compat';
import { listAllPermissions, revokePermissions } from '../policy/permissions';

export function registerPermissionHandlers(): void {
  registerHandler('list_all_permissions', (_message, _sender, sendResponse) => {
    listAllPermissions()
      .then((permissions) => {
        sendResponse({ type: 'list_all_permissions_result', permissions, ok: true });
      })
      .catch((error) => {
        sendResponse({
          type: 'list_all_permissions_result',
          permissions: [],
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  });

  registerHandler('revoke_origin_permissions', (message, _sender, sendResponse) => {
    const { origin } = message as { origin?: string };
    if (!origin) {
      sendResponse({ ok: false, error: 'Missing origin' });
      return true;
    }
    (async () => {
      await revokePermissions(origin);
      browserAPI.runtime.sendMessage({ type: 'permissions_changed' }).catch(() => {});
      sendResponse({ ok: true });
    })().catch((error) => sendResponse(errorResponse(error)));
    return true;
  });
}
