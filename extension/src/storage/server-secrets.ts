/**
 * Per-server secret values (e.g. login email/password for Atlantic).
 * Stored in extension local storage; injected as process.env when starting JS servers.
 */

import { browserAPI } from '../browser-compat';

const STORAGE_KEY = 'harbor_server_secrets';

export type ServerSecrets = Record<string, string>;

export async function getServerSecrets(serverId: string): Promise<ServerSecrets> {
  const result = await browserAPI.storage.local.get(STORAGE_KEY);
  const all = (result[STORAGE_KEY] as Record<string, ServerSecrets>) || {};
  return all[serverId] || {};
}

export async function setServerSecrets(serverId: string, values: ServerSecrets): Promise<void> {
  const result = await browserAPI.storage.local.get(STORAGE_KEY);
  const all = (result[STORAGE_KEY] as Record<string, ServerSecrets>) || {};
  all[serverId] = values;
  await browserAPI.storage.local.set({ [STORAGE_KEY]: all });
}

export async function clearServerSecrets(serverId: string): Promise<void> {
  const result = await browserAPI.storage.local.get(STORAGE_KEY);
  const all = (result[STORAGE_KEY] as Record<string, ServerSecrets>) || {};
  delete all[serverId];
  await browserAPI.storage.local.set({ [STORAGE_KEY]: all });
}
