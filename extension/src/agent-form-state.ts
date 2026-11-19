/**
 * Tracks which agent (if any) the sidebar's Add/Edit agent form is
 * currently editing — Save needs this to decide whether to update that
 * agent in place or add a new one. Pulled out of sidebar.ts so it's
 * testable without a DOM.
 *
 * In particular: pressing Check on a brand-new agent saves it first
 * (`acp.open` only starts an already-configured agent), and from that
 * point on the form must treat it as the agent it's editing — otherwise a
 * later Save computes a fresh id for the same fields and adds a
 * duplicate instead of updating the one Check just saved. `trackSaved`
 * closes that gap.
 */
import { uniqueAgentId, type ConfiguredAgent } from './sidebar-agents';

export class AgentFormState {
  private editing: ConfiguredAgent | null = null;

  /** The agent this form is currently editing, or `null` when adding a new one. */
  get editingOriginal(): ConfiguredAgent | null {
    return this.editing;
  }

  /** Starts editing `agent` (the Edit button), or clears back to "adding a new agent" when called with no argument (Add, or closing the form). */
  reset(agent?: ConfiguredAgent): void {
    this.editing = agent ?? null;
  }

  /**
   * Called once a save for the form's current agent succeeds — including
   * Check's own save of a brand-new agent, not just an explicit Save —
   * so a *later* Save on the same form updates that agent instead of
   * adding a duplicate.
   */
  trackSaved(agent: ConfiguredAgent): void {
    this.editing = agent;
  }

  /** The id Save/Check should use: the agent already being edited, or a fresh unique one for a brand-new agent. */
  idFor(existingAgents: readonly ConfiguredAgent[], nameOrCommand: string): string {
    return this.editing?.id ?? uniqueAgentId(existingAgents, nameOrCommand);
  }
}
