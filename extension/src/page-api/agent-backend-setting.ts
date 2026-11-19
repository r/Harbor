/**
 * Harbor Page API - The `harbor_agent_backend` setting
 *
 * Reads and validates the stored backend choice, with no dependency on
 * `agent-backend.ts`/`acp-backend.ts` (which import `./handlers`, the
 * handler registry barrel) — handlers/ai-handlers.ts is part of that
 * barrel, so it reads the setting through this leaf module instead of
 * through agent-backend-selection.ts, to avoid a module cycle
 * (ai-handlers.ts -> agent-backend-selection.ts -> agent-backend.ts ->
 * ./handlers -> ai-handlers.ts).
 *
 * agent-backend-selection.ts (which turns this into a live `AgentBackend`
 * for `agent.run`) and acp-text-session.ts (which turns it into a live ACP
 * text session) both read the same setting through this module, so there's
 * one place that validates it.
 */

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
 * validated setting, or `null` when the key is absent, storage can't be
 * read, or the stored value doesn't have the one shape this understands.
 * An absent or malformed value always resolves to `null` — this never
 * widens what a page can do, so a bad value fails toward Harbor's own
 * built-in backend, not toward running on some unvalidated agent.
 */
export async function readAgentBackendSetting(): Promise<AgentBackendSetting | null> {
  let raw: unknown;
  try {
    const stored = await chrome.storage.local.get(AGENT_BACKEND_STORAGE_KEY);
    raw = stored[AGENT_BACKEND_STORAGE_KEY];
  } catch {
    return null;
  }
  return readSetting(raw);
}
