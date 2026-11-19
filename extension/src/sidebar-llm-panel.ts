/**
 * Pure logic for the LLM Providers panel's reaction to the Agent panel's
 * selection (sidebar.ts): when the person has selected an ACP
 * agent, requests the agent covers (window.ai text sessions, agent.run) no
 * longer go through Harbor's own model, so the panel collapses by default
 * and shows a one-line note that it's still used elsewhere. Selecting the
 * built-in model restores today's behavior exactly — expanded, no note.
 *
 * No DOM here, so sidebar.ts's "update when the selection changes" wiring
 * is testable without one: these two functions only take "is an agent
 * selected" and answer what the panel's collapse state and header note
 * should be.
 */

/** The one-line note shown in the LLM panel's header area while an agent is selected. */
export const LLM_PANEL_AGENT_NOTE = "Still used by agent.sessions and Harbor's own chat";

/** Whether the LLM Providers panel should start collapsed, given whether an ACP agent is currently selected. */
export function llmPanelCollapsedForAgent(agentSelected: boolean): boolean {
  return agentSelected;
}

/** The header note to show, or `null` when the built-in model is selected (today's behavior: no note). */
export function llmPanelNoteForAgent(agentSelected: boolean): string | null {
  return agentSelected ? LLM_PANEL_AGENT_NOTE : null;
}
