/**
 * The consent prompt's wording for `model:prompt`/`model:tools` when the
 * person has selected an ACP agent (docs/ACP_BACKEND_DESIGN.md section 4):
 * it names which calls these two scopes actually send to that agent —
 * `window.ai` text sessions, `agent.run` and now a page's own chat
 * (`agent.chat.open`) — and says plainly that the site gets that agent
 * with whatever it can do in the person's setup, including its tools and
 * what it remembers about the person. It also says what *doesn't* go to
 * the agent yet: `agent.sessions` and a direct `llm.chat` still run on
 * Harbor's own model (docs/ACP_BACKEND_DESIGN.md section 2's mapping
 * table and its "everything that uses a model" decision), so the wording
 * doesn't claim more than is true. No agent selected is unchanged: the
 * built-in wording stands.
 *
 * The wording never names the protocol (maintainer decision):
 * a person looking at the consent prompt doesn't need to know Harbor talks
 * to the agent over ACP, so this says "your own agent", not "(via ACP)".
 * Developer docs may still say ACP; this file is the one place that writes
 * the person-facing wording.
 *
 * Because an agent, once selected, can always use its own tools to answer
 * a prompt, `model:prompt` is exactly as risky as `model:tools` once an
 * agent is in the picture — both get the built-in `model:tools` risk tier
 * (medium), not `model:prompt`'s own lower one. With no agent selected,
 * each scope keeps its own built-in risk.
 *
 * A pure function, no storage or bridge access — `agent-consent.ts` resolves
 * the selected agent's display name (or `null`); this only turns that into
 * copy. Kept apart from `permissions.ts`'s `SCOPE_DESCRIPTIONS` so the
 * switch is testable on its own.
 */
import { SCOPE_DESCRIPTIONS } from './permissions';
import type { PermissionScope } from '../agents/types';

const AGENT_COVERED_SCOPES = new Set<PermissionScope>(['model:prompt', 'model:tools']);

/** The risk level `model:prompt`/`model:tools` show once an agent is selected — the higher of the two built-in tiers. */
const AGENT_COVERED_RISK: 'medium' = 'medium';

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
    title: `Text prompts, agent runs and page chat go to ${agentName}, your own agent`,
    description: `When this site uses window.ai text sessions, agent.run or page chat, ${agentName} answers, with whatever it can do in your setup, including its tools and what it remembers about you. Other features still use Harbor's built-in model.`,
    risk: AGENT_COVERED_RISK,
  };
}

/**
 * Groups `scopes` into the rows the consent prompt actually shows: when an
 * agent is selected and the request carries both `model:prompt` and
 * `model:tools`, they collapse into one row (same title, description and
 * risk from `consentScopeDescription` either way), since telling the person
 * about "text prompts" and "agent runs" twice, identically, says nothing a
 * single row doesn't. Every other scope — and both of these when no agent
 * is selected, or only one of them is requested — stays its own row. Order
 * is preserved; a merged pair is placed at the first of the two scopes'
 * original positions. Grants, and what's sent to `grantPermissions`, are
 * untouched by this — it's display-only.
 */
export function consentScopeRows(
  scopes: readonly PermissionScope[],
  agentName: string | null,
): PermissionScope[][] {
  const mergeable = Boolean(agentName) && scopes.includes('model:prompt') && scopes.includes('model:tools');
  const rows: PermissionScope[][] = [];
  let mergedRowPlaced = false;
  for (const scope of scopes) {
    if (mergeable && (scope === 'model:prompt' || scope === 'model:tools')) {
      if (!mergedRowPlaced) {
        rows.push(['model:prompt', 'model:tools']);
        mergedRowPlaced = true;
      }
      continue;
    }
    rows.push([scope]);
  }
  return rows;
}
