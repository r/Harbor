/**
 * The consent prompt's wording for `model:prompt`/`model:tools` when the
 * person has selected an ACP agent (docs/ACP_BACKEND_DESIGN.md section 4):
 * it names which calls these two scopes actually send to that agent —
 * `window.ai` text sessions and `agent.run` — and says plainly that the
 * site gets that agent with whatever it can do in the person's setup,
 * including its tools. It also says what *doesn't* go to the agent:
 * `agent.sessions` and a direct `llm.chat` still run on Harbor's own
 * model (docs/ACP_BACKEND_DESIGN.md section 2's mapping table), so the
 * wording doesn't claim more than is true. No agent selected is
 * unchanged: the built-in wording stands.
 *
 * A pure function, no storage or bridge access — `agent-consent.ts` resolves
 * the selected agent's display name (or `null`); this only turns that into
 * copy. Kept apart from `permissions.ts`'s `SCOPE_DESCRIPTIONS` so the
 * switch is testable on its own.
 */
import { SCOPE_DESCRIPTIONS } from './permissions';
import type { PermissionScope } from '../agents/types';

const AGENT_COVERED_SCOPES = new Set<PermissionScope>(['model:prompt', 'model:tools']);

/**
 * `agentName` is the selected agent's display name (e.g. "goose"), or
 * `null` when no ACP agent is selected — the built-in description for
 * `scope` is returned unchanged in that case, and for every scope other
 * than `model:prompt`/`model:tools` regardless of what's selected.
 */
export function consentScopeDescription(
  scope: PermissionScope,
  agentName: string | null,
): { title: string; description: string; risk: 'low' | 'medium' | 'high' } {
  const builtin = SCOPE_DESCRIPTIONS[scope];
  if (!agentName || !AGENT_COVERED_SCOPES.has(scope)) return builtin;

  return {
    title: `Text prompts and agent runs go to ${agentName} (via ACP), your own agent`,
    description: `When this site uses window.ai text sessions or agent.run, ${agentName} answers, with whatever it can do in your setup, including its tools. Other features still use Harbor's built-in model.`,
    risk: builtin.risk,
  };
}
