/**
 * Resolves the display name of the ACP agent the person has selected, for
 * the consent prompt's wording switch (agent-consent-copy.ts). `null` when
 * no agent is selected — the built-in wording then stands unchanged.
 *
 * Reads `harbor_agent_backend` through `page-api/agent-backend-setting.ts`
 * (the one leaf module both the page API and this module validate it
 * through) and asks the bridge for the configured agent's own name, via
 * `acp.get_agents` — the same RPC the sidebar's agent list uses. A bridge
 * that's unreachable, or an agent id the bridge no longer has, falls back
 * to the stored id itself rather than failing the prompt.
 */
import { bridgeRequest } from '../llm/bridge-client';
import { readAgentBackendSetting } from '../page-api/agent-backend-setting';

export async function resolveConsentAgentName(): Promise<string | null> {
  const setting = await readAgentBackendSetting();
  if (!setting) return null;

  try {
    const { agents } = await bridgeRequest<{ agents: Array<{ id: string; name: string }> }>('acp.get_agents', {});
    const agent = agents.find((a) => a.id === setting.agentId);
    return agent?.name ?? setting.agentId;
  } catch {
    return setting.agentId;
  }
}
