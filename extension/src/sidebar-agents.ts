/**
 * Pure logic for the sidebar's Agent setting (docs/ACP_BACKEND_DESIGN.md
 * section 5, outcome 1-3): the three presets, turning a preset or a custom
 * form into the agent record `acp_save_agents` gets, editing/removing an
 * agent in the saved list, and writing/clearing the `harbor_agent_backend`
 * selection. No DOM and no messaging here — sidebar.ts wires this to the
 * page, so this is testable without one.
 */

export type ConfiguredAgent = {
  id: string;
  name: string;
  command: string;
  args: string[];
  /**
   * The bridge's own agent record can carry fields this sidebar doesn't
   * render (e.g. `env`, set by hand in `acp.json` or by a future UI).
   * `agentFromForm` round-trips them on an edit, so Save never drops one.
   */
  [key: string]: unknown;
};

export type AgentPresetId = 'goose' | 'claude-code' | 'codex';

export interface AgentPreset {
  name: string;
  command: string;
  args: readonly string[];
  /** Where to read the agent's own settings for tool keys (outcome 3). */
  docsUrl: string;
}

/**
 * The three presets the maintainer settled on. A preset is a start command
 * only: it sets no approval mode and no env — those stay the person's own,
 * configured in the agent's own harness (docs/ACP_BACKEND_DESIGN.md
 * sections 3 and 5).
 */
export const AGENT_PRESETS: Record<AgentPresetId, AgentPreset> = {
  goose: {
    name: 'goose',
    command: 'goose',
    args: ['acp'],
    docsUrl: 'https://goose-docs.ai/docs/guides/config-files',
  },
  'claude-code': {
    name: 'Claude Code',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@0.108.1'],
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/settings',
  },
  codex: {
    name: 'Codex',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp@2.7.0'],
    docsUrl: 'https://github.com/openai/codex/blob/main/docs/config.md',
  },
};

/**
 * Builds the agent record for a preset. `resolvedPath` is what
 * `acp.resolve_command` returned for the preset's own bare command — the
 * absolute path when the bridge found one, so the saved record doesn't
 * depend on the person's `PATH` at `acp.open` time; the bare command
 * unchanged when it didn't.
 */
export function buildPresetAgent(
  preset: AgentPresetId,
  id: string,
  resolvedPath: string | null,
): ConfiguredAgent {
  const p = AGENT_PRESETS[preset];
  return {
    id,
    name: p.name,
    command: resolvedPath ?? p.command,
    args: [...p.args],
  };
}

/** Splits the args textarea one argument per line, dropping blank lines and surrounding whitespace. */
export function parseArgsText(argsText: string): string[] {
  return argsText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Builds a custom agent from the "Add agent" form's fields, one argument per non-blank line. */
export function buildCustomAgent(
  id: string,
  name: string,
  command: string,
  argsText: string,
): ConfiguredAgent {
  return { id, name, command, args: parseArgsText(argsText) };
}

/**
 * The agent record Save actually sends, built from exactly what the form's
 * fields show — never from a preset's own default, even when a preset was
 * used to pre-fill the form: whatever the person has since typed into
 * `command`/`args` wins. When `original` is given (editing an existing
 * agent), every field it carries beyond id/name/command/args — `env`, for
 * instance — is kept untouched; a brand-new agent (`original` is `null`)
 * never gets one, matching the presets' own "no env" rule.
 */
export function agentFromForm(
  original: ConfiguredAgent | null,
  id: string,
  name: string,
  command: string,
  argsText: string,
): ConfiguredAgent {
  const args = parseArgsText(argsText);
  if (!original) return { id, name, command, args };
  return { ...original, id, name, command, args };
}

/**
 * Turns a free-form name into an id that matches the bridge's own pattern
 * (`^[a-z0-9][a-z0-9-]{0,31}$`, docs/ACP_BACKEND_DESIGN.md's bridge
 * contract), and appends a numeric suffix when that id is already used by
 * one of `existing`'s agents — so adding a second "goose" (a renamed
 * custom agent, say) doesn't collide with the preset's own id.
 */
export function uniqueAgentId(existing: readonly ConfiguredAgent[], name: string): string {
  const base = slugify(name);
  const used = new Set(existing.map((a) => a.id));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`.slice(0, 32);
    if (!used.has(candidate)) return candidate;
  }
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 32);
  return slug || 'agent';
}

/** The `acp_save_agents` payload after adding or editing one agent: replaces by id, or appends when the id is new. */
export function withAgentSaved(existing: readonly ConfiguredAgent[], agent: ConfiguredAgent): ConfiguredAgent[] {
  const idx = existing.findIndex((a) => a.id === agent.id);
  if (idx === -1) return [...existing, agent];
  const copy = [...existing];
  copy[idx] = agent;
  return copy;
}

/** The `acp_save_agents` payload after removing one agent. A no-op (same contents) when `id` isn't in the list. */
export function withAgentRemoved(existing: readonly ConfiguredAgent[], id: string): ConfiguredAgent[] {
  return existing.filter((a) => a.id !== id);
}

/**
 * What `agent_backend_set` should be called with for the picker's choice:
 * `null` ("Harbor (built-in model)") clears the setting; an agent id
 * writes `{type: 'acp', agentId}`.
 */
export function backendSettingForChoice(agentId: string | null): { type: 'acp'; agentId: string } | null {
  return agentId ? { type: 'acp', agentId } : null;
}
