/**
 * The Agent panel's "Your agent outside the browser" section
 * (docs/AGENT_REACHES_TABS.md): the setting, the command to add Harbor to an
 * agent, sharing the current tab, and which agents have connected. Every
 * change goes through the background's extension-page-only handlers
 * (handlers/agent-tabs-handlers.ts).
 */

export interface OutsideAgentsState {
  ok: boolean;
  enabled?: boolean;
  mcpCommand?: string | null;
  activeTab?: { url: string; title: string; shareable: boolean; shared: boolean } | null;
  agents?: Array<{ name: string; lastSeen: number }>;
  error?: string;
}

export interface OutsideAgentsIO {
  send(message: Record<string, unknown>): Promise<{ ok: boolean; error?: string; shared?: boolean } & Partial<OutsideAgentsState>>;
  copy(text: string): Promise<void>;
}

export interface OutsideAgentsElements {
  enabled: HTMLInputElement;
  command: HTMLElement;
  copy: HTMLButtonElement;
  share: HTMLButtonElement;
  shareHint: HTMLElement;
  list: HTMLElement;
}

/** What the panel shows for a given state. Pure, so it's testable without a DOM. */
export function describeOutsideAgents(state: OutsideAgentsState) {
  const command = state.mcpCommand ?? null;
  const tab = state.activeTab ?? null;
  const agents = state.agents ?? [];
  return {
    enabled: state.enabled === true,
    commandText: command === null
      ? "Harbor's bridge isn't connected, so the command isn't available yet."
      : [
        command,
        '',
        'goose (one session):',
        `goose session --with-extension "harbor:${command}"`,
        '',
        'Claude Code:',
        `claude mcp add harbor -- ${command}`,
      ].join('\n'),
    canCopy: command !== null,
    shareLabel: tab?.shared ? 'Stop sharing this tab' : 'Share this tab with your agent',
    canShare: state.enabled === true && tab?.shareable === true,
    shareHint: !state.enabled
      ? 'Turn this on to share tabs.'
      : tab?.shared
        ? 'Your agent can use this page while it stays on this site.'
        : tab && !tab.shareable
          ? 'Only web pages can be shared.'
          : '',
    listText: agents.length === 0
      ? 'No agent has connected yet.'
      : `Connected: ${agents.map((a) => a.name).join(', ')}`,
  };
}

export function initOutsideAgentsSection(el: OutsideAgentsElements, io: OutsideAgentsIO) {
  let state: OutsideAgentsState = { ok: false };

  function render(): void {
    const view = describeOutsideAgents(state);
    el.enabled.disabled = !state.ok;
    el.enabled.checked = view.enabled;
    el.command.textContent = view.commandText;
    el.copy.disabled = !view.canCopy;
    el.share.textContent = view.shareLabel;
    el.share.disabled = !view.canShare;
    el.shareHint.textContent = view.shareHint;
    el.list.textContent = view.listText;
  }

  async function refresh(): Promise<void> {
    try {
      const next = await io.send({ type: 'outside_agents_get' });
      state = next.ok ? next : { ok: false };
    } catch {
      state = { ok: false };
    }
    render();
  }

  el.enabled.addEventListener('change', async () => {
    await io.send({ type: 'outside_agents_set_enabled', enabled: el.enabled.checked });
    await refresh();
  });
  el.copy.addEventListener('click', async () => {
    if (state.mcpCommand) await io.copy(state.mcpCommand);
  });
  el.share.addEventListener('click', async () => {
    await io.send({ type: 'outside_agents_share_tab', share: !state.activeTab?.shared });
    await refresh();
  });

  render();
  return { refresh };
}
