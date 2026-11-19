/**
 * Sidebar-facing handlers for ACP agent configuration and the
 * `harbor_agent_backend` selection (docs/ACP_BACKEND_DESIGN.md sections 4
 * and 5). Every handler here is registered through
 * `registerExtensionPageHandler` (extension-page-sender.ts), so none of
 * them is reachable from a page or a content script — `acp_save_agents`
 * controls what program the bridge runs, so this matters more than an
 * ordinary permission check.
 *
 * `acp_get_agents`, `acp_save_agents` and `acp_resolve_command` forward
 * directly to the bridge's own `acp.get_agents`/`acp.save_agents`/
 * `acp.resolve_command` RPCs (bridge-rs README, "ACP agents") and pass its
 * errors through unchanged — the bridge is the one place that validates an
 * agent id's shape, so there's nothing to re-validate here.
 *
 * `acp_check_agent`'s `name`/`command` are the sidebar's own copy of the
 * agent record it's checking, used only to word the result (see
 * acp-agent-check.ts). They never choose what the bridge runs — that's
 * `agentId` alone, resolved against the bridge's own configured agents.
 */
import { bridgeRequest } from '../llm/bridge-client';
import { errorResponse, type HandlerResponse } from './types';
import { registerExtensionPageHandler } from './extension-page-sender';
import { checkAcpAgent } from './acp-agent-check';
import {
  parseAgentBackendSetting,
  readAgentBackendSetting,
  writeAgentBackendSetting,
} from '../page-api/agent-backend-setting';

export function registerAcpAgentHandlers(): void {
  registerExtensionPageHandler('acp_get_agents', async () => {
    const result = await bridgeRequest<{ agents: unknown[] }>('acp.get_agents', {});
    return { ok: true, agents: result.agents };
  });

  registerExtensionPageHandler('acp_save_agents', async (message) => {
    const { agents } = message as { agents?: unknown };
    await bridgeRequest<Record<string, never>>('acp.save_agents', { agents });
    return { ok: true };
  });

  registerExtensionPageHandler('acp_resolve_command', async (message) => {
    const { name } = message as { name?: unknown };
    if (typeof name !== 'string' || !name) {
      return { ok: false, error: 'Missing name' };
    }
    const result = await bridgeRequest<{ path: string | null }>('acp.resolve_command', { name });
    return { ok: true, path: result.path };
  });

  registerExtensionPageHandler('acp_check_agent', async (message) => {
    const { agentId, name, command } = message as { agentId?: unknown; name?: unknown; command?: unknown };
    if (typeof agentId !== 'string' || !agentId) {
      return { ok: false, error: 'Missing agentId' };
    }
    const agentName = typeof name === 'string' && name ? name : agentId;
    const agentCommand = typeof command === 'string' && command ? command : agentId;
    const result = await checkAcpAgent(agentId, agentName, agentCommand);
    return result.ok ? { ok: true, message: result.message } : { ok: false, error: result.error };
  });

  registerExtensionPageHandler('agent_backend_get', async (): Promise<HandlerResponse> => {
    const setting = await readAgentBackendSetting();
    return { ok: true, setting };
  });

  registerExtensionPageHandler('agent_backend_set', async (message): Promise<HandlerResponse> => {
    const raw = (message as { setting?: unknown }).setting;
    if (raw === null) {
      await writeAgentBackendSetting(null);
      return { ok: true };
    }
    const parsed = parseAgentBackendSetting(raw);
    if (!parsed) {
      return { ok: false, error: 'Invalid agent backend setting' };
    }
    try {
      await writeAgentBackendSetting(parsed);
      return { ok: true };
    } catch (e) {
      return errorResponse(e);
    }
  });
}
