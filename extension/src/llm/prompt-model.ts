/**
 * The model a page's prompt will run on.
 */

import { bridgeRequest } from './bridge-client';

/**
 * A prompt that names no model (or names "default") runs on the bridge's
 * default, which `llm.get_config` reports as the bridge resolves it for
 * chat. Returns undefined when that's unknown.
 */
export async function modelForPrompt(model: unknown): Promise<string | undefined> {
  if (typeof model === 'string' && model && model !== 'default') return model;
  try {
    const config = await bridgeRequest<{ default_model?: string | null }>('llm.get_config');
    return config.default_model ?? undefined;
  } catch {
    return undefined;
  }
}
