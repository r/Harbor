/**
 * Permission Handlers
 * 
 * Handlers for permission management.
 */

import { registerHandler, errorResponse } from './types';
import { browserAPI } from '../browser-compat';
import { listAllPermissions, revokePermissions } from '../policy/permissions';
import { WEB_AGENTS_API_FIREFOX_ID as WEB_AGENTS_API_EXTENSION_ID } from '../known-extensions';

type ExternalPermissionStatusEntry = {
  origin: string;
  scopes: Record<string, string>;
  allowedTools?: string[];
  source?: 'harbor' | 'web-agents-api';
};

async function fetchWebAgentsPermissions(): Promise<ExternalPermissionStatusEntry[]> {
  try {
    const response = await browserAPI.runtime.sendMessage(WEB_AGENTS_API_EXTENSION_ID, {
      type: 'web_agents_permissions.list_all',
    }) as { ok?: boolean; permissions?: ExternalPermissionStatusEntry[] };

    if (!response?.ok || !response.permissions) {
      return [];
    }

    return response.permissions.map((entry) => ({
      ...entry,
      source: 'web-agents-api',
    }));
  } catch {
    return [];
  }
}

export function registerPermissionHandlers(): void {
  // List all permissions (merged from Harbor and Web Agents API)
  registerHandler('list_all_permissions', (_message, _sender, sendResponse) => {
    (async () => {
      const permissions = await listAllPermissions();
      const webAgentsPermissions = await fetchWebAgentsPermissions();
      const merged: ExternalPermissionStatusEntry[] = [
        ...permissions.map((entry) => ({ ...entry, source: 'harbor' as const })),
        ...webAgentsPermissions,
      ];
      sendResponse({ type: 'list_all_permissions_result', permissions: merged, ok: true });
    })().catch((error) => {
      sendResponse({
        type: 'list_all_permissions_result',
        permissions: [],
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  });

  // Revoke permissions for an origin
  registerHandler('revoke_origin_permissions', (message, _sender, sendResponse) => {
    const { origin, source } = message as { origin?: string; source?: 'harbor' | 'web-agents-api' };
    if (!origin) {
      sendResponse({ ok: false, error: 'Missing origin' });
      return true;
    }
    (async () => {
      if (source === 'web-agents-api') {
        await browserAPI.runtime.sendMessage(WEB_AGENTS_API_EXTENSION_ID, {
          type: 'web_agents_permissions.revoke_origin',
          origin,
        });
      } else {
        await revokePermissions(origin);
      }

      // Notify sidebar to refresh
      browserAPI.runtime.sendMessage({ type: 'permissions_changed' }).catch(() => {});
      sendResponse({ ok: true });
    })().catch((error) => sendResponse(errorResponse(error)));
    return true;
  });
}
