/**
 * The model a page's prompt will run on.
 */

import { bridgeRequest } from './bridge-client';
import { promptActionForModel } from '../policy/actions';

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

/** Harbor's own in-browser providers: they never reach the bridge. */
const IN_BROWSER_PREFIXES = ['local:', 'firefox-ml:', 'chrome-ai:'];

/**
 * The typed action a page's prompt is checked as: local when the model it
 * runs on is local, otherwise first-party remote. The bridge decides, since
 * it knows each provider's type, including a named instance such as
 * "my-ollama:llama3". Harbor's in-browser providers are local without asking.
 * When the bridge can't say, the prompt counts as remote, the stricter
 * class. An older bridge without llm.model_locality falls back to the
 * model's name.
 */
export async function promptActionForPrompt(
  model: unknown,
): Promise<'model.prompt.local' | 'model.prompt.remote.firstParty'> {
  const resolved = await modelForPrompt(model);
  if (!resolved) return 'model.prompt.remote.firstParty';
  const name = resolved.toLowerCase();
  if (IN_BROWSER_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'model.prompt.local';
  try {
    const { is_local } = await bridgeRequest<{ is_local?: boolean }>('llm.model_locality', { model: resolved });
    return is_local === true ? 'model.prompt.local' : 'model.prompt.remote.firstParty';
  } catch (e) {
    if (e instanceof Error && /Unknown method/i.test(e.message)) return promptActionForModel(resolved);
    return 'model.prompt.remote.firstParty';
  }
}
