/**
 * Harbor Page API - Agent backend selection
 *
 * Picks which `AgentBackend` runs a page's `agent.run`, from a setting
 * stored by the (not yet built) sidebar picker. No UI sets this yet; it's
 * read here so the wiring is in place ahead of it. An absent or malformed
 * value always falls back to the built-in backend — this never widens
 * what a page can do, so a bad value fails toward Harbor's own loop, not
 * toward running on some unvalidated agent.
 */
import { builtinAgentBackend, type AgentBackend } from './agent-backend';
import { AcpAgentBackend } from './acp-backend';

export const AGENT_BACKEND_STORAGE_KEY = 'harbor_agent_backend';

export type AgentBackendSetting = { type: 'acp'; agentId: string };

/** Accepts the stored value only if it has the one shape this understands. */
function readSetting(raw: unknown): AgentBackendSetting | null {
  if (!raw || typeof raw !== 'object') return null;
  const { type, agentId } = raw as { type?: unknown; agentId?: unknown };
  if (type !== 'acp') return null;
  if (typeof agentId !== 'string' || agentId.length === 0) return null;
  return { type: 'acp', agentId };
}

/**
 * Reads `harbor_agent_backend` from `chrome.storage.local` and returns the
 * backend it names, or `builtinAgentBackend` when the key is absent or its
 * value doesn't validate.
 */
export async function selectAgentBackend(): Promise<AgentBackend> {
  let raw: unknown;
  try {
    const stored = await chrome.storage.local.get(AGENT_BACKEND_STORAGE_KEY);
    raw = stored[AGENT_BACKEND_STORAGE_KEY];
  } catch {
    return builtinAgentBackend;
  }

  const setting = readSetting(raw);
  if (!setting) return builtinAgentBackend;

  return new AcpAgentBackend(setting.agentId);
}
