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
import { readAgentBackendSetting } from './agent-backend-setting';

export { AGENT_BACKEND_STORAGE_KEY, readAgentBackendSetting, type AgentBackendSetting } from './agent-backend-setting';

/**
 * Returns the backend `harbor_agent_backend` names, or `builtinAgentBackend`
 * when the key is absent or its value doesn't validate.
 */
export async function selectAgentBackend(): Promise<AgentBackend> {
  const setting = await readAgentBackendSetting();
  if (!setting) return builtinAgentBackend;

  return new AcpAgentBackend(setting.agentId);
}
