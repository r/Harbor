/**
 * Orchestration for the sidebar's Agent panel, kept apart from sidebar.ts
 * so it's testable without a DOM: loading the configured-agent list and
 * the `harbor_agent_backend` selection, pruning a selection that no longer
 * names a real agent, saving and removing against a freshly re-read list
 * (never a stale in-memory copy — see `saveAgent`/`removeAgent`), and
 * clearing the selection when the selected agent is removed.
 *
 * `AgentBackendIO` is the thin seam over the message-passing handlers
 * (acp_get_agents, acp_save_agents, agent_backend_get, agent_backend_set);
 * sidebar.ts supplies the real `browserAPI.runtime.sendMessage` calls, and
 * tests supply plain mocks.
 */
import type { ConfiguredAgent } from './sidebar-agents';
import { backendSettingForChoice, withAgentRemoved, withAgentSaved } from './sidebar-agents';

export interface AgentBackendIO {
  getAgents(): Promise<{ ok: boolean; agents?: ConfiguredAgent[]; error?: string }>;
  saveAgents(agents: ConfiguredAgent[]): Promise<{ ok: boolean; error?: string }>;
  getBackend(): Promise<{ ok: boolean; setting?: { type: 'acp'; agentId: string } | null }>;
  setBackend(setting: { type: 'acp'; agentId: string } | null): Promise<{ ok: boolean; error?: string }>;
}

export type LoadResult =
  | { ok: true; agents: ConfiguredAgent[]; selection: string | null }
  | { ok: false; error: string };

export type SaveResult =
  | { ok: true; agents: ConfiguredAgent[] }
  | { ok: false; error: string };

export type RemoveResult =
  | { ok: true; agents: ConfiguredAgent[]; selectionCleared: boolean }
  | { ok: false; error: string };

export type SelectResult =
  | { ok: true }
  | { ok: false; error: string };

export class AgentPanelController {
  private agents: ConfiguredAgent[] = [];
  private loaded = false;
  private selectedAgentId: string | null = null;

  constructor(private readonly io: AgentBackendIO) {}

  /** Whether the list has loaded at least once — the caller (sidebar.ts) disables Add/Save/Edit/Remove until this is true. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  get currentAgents(): readonly ConfiguredAgent[] {
    return this.agents;
  }

  get currentSelection(): string | null {
    return this.selectedAgentId;
  }

  /**
   * Loads the agent list and the backend selection. A selection naming an
   * agent that isn't in the list — removed, or never valid — is cleared
   * (`agent_backend_set(null)`) and reported as `null`, so the picker
   * shows "Harbor (built-in model)" rather than a ghost entry.
   */
  async load(): Promise<LoadResult> {
    const agentsResponse = await this.io.getAgents();
    if (!agentsResponse.ok) {
      return { ok: false, error: agentsResponse.error ?? 'Failed to load agents' };
    }
    this.agents = agentsResponse.agents ?? [];
    this.loaded = true;

    const backendResponse = await this.io.getBackend();
    let selection = backendResponse.ok ? backendResponse.setting?.agentId ?? null : null;
    if (selection && !this.agents.some((a) => a.id === selection)) {
      await this.io.setBackend(null);
      selection = null;
    }
    this.selectedAgentId = selection;
    return { ok: true, agents: this.agents, selection };
  }

  /**
   * Re-reads the agent list immediately before saving, and applies `apply`
   * to *that* fresh copy — never to whatever this controller last
   * rendered. If the re-read itself fails, this aborts before
   * `acp_save_agents` is ever called, so a transient load failure can
   * never result in a save that's missing agents.
   */
  private async saveWithFreshList(apply: (fresh: ConfiguredAgent[]) => ConfiguredAgent[]): Promise<SaveResult> {
    const fresh = await this.io.getAgents();
    if (!fresh.ok) {
      return { ok: false, error: `Could not confirm the current agent list before saving: ${fresh.error ?? 'unknown error'}` };
    }
    const updated = apply(fresh.agents ?? []);
    const saveResponse = await this.io.saveAgents(updated);
    if (!saveResponse.ok) {
      return { ok: false, error: saveResponse.error ?? 'Failed to save' };
    }
    this.agents = updated;
    this.loaded = true;
    return { ok: true, agents: updated };
  }

  /** Saves `agent` (an add or an edit, by id) against a freshly re-read list. */
  async saveAgent(agent: ConfiguredAgent): Promise<SaveResult> {
    return this.saveWithFreshList((fresh) => withAgentSaved(fresh, agent));
  }

  /**
   * Removes `id` against a freshly re-read list, and clears the backend
   * selection if it pointed at the removed agent.
   */
  async removeAgent(id: string): Promise<RemoveResult> {
    const wasSelected = this.selectedAgentId === id;
    const result = await this.saveWithFreshList((fresh) => withAgentRemoved(fresh, id));
    if (!result.ok) return result;

    let selectionCleared = false;
    if (wasSelected) {
      await this.io.setBackend(null);
      this.selectedAgentId = null;
      selectionCleared = true;
    }
    return { ok: true, agents: result.agents, selectionCleared };
  }

  /** Writes the picker's choice (`null` for "Harbor (built-in model)"). */
  async selectBackend(agentId: string | null): Promise<SelectResult> {
    const response = await this.io.setBackend(backendSettingForChoice(agentId));
    if (!response.ok) {
      return { ok: false, error: response.error ?? 'Failed to switch agent' };
    }
    this.selectedAgentId = agentId;
    return { ok: true };
  }
}
