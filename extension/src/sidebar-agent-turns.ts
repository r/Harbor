/**
 * The activity feed's list of turns on the person's own agent
 * (page-api/agent-turns.ts): which site prompted it, through which API,
 * what it was asked, which of its own tools it used, and how the turn
 * ended.
 *
 * Opening the feed is what clears the toolbar badge. So when the sidebar
 * loads with unseen turns, it opens the activity panel itself, and any
 * refresh while the panel is open marks new unseen turns seen. Turns that
 * were unseen when this sidebar first showed them stay highlighted for as
 * long as this sidebar stays open, even if the Activity panel is collapsed
 * and opened again, so clearing the badge doesn't also hide which turns it
 * was for.
 */

import { escapeHtml } from './html-escape';
import { icon, type IconName } from './icons';
import type { AgentTurnOutcome, AgentTurnRecord } from './page-api/agent-turns';

const OUTCOME: Record<AgentTurnOutcome | 'running', { label: string; icon: IconName }> = {
  answered: { label: 'Answered', icon: 'badge-check' },
  failed: { label: 'Failed', icon: 'triangle-alert' },
  cancelled: { label: 'Cancelled', icon: 'x' },
  'timed-out': { label: 'Timed out', icon: 'clock' },
  running: { label: 'Running', icon: 'rotate-cw' },
};

function siteOf(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/** HTML for the list, newest first. `highlighted` holds the ids of turns to mark as not shown by the site. */
export function renderAgentTurns(turns: readonly AgentTurnRecord[], highlighted: ReadonlySet<string>): string {
  if (turns.length === 0) {
    return '<div class="empty-state">No turns yet. When a site prompts your agent, it shows here.</div>';
  }
  return turns.slice().reverse().map((t) => {
    const outcome = OUTCOME[t.outcome ?? 'running'];
    const flagged = highlighted.has(t.id);
    const more = t.moreTools ? ` and ${t.moreTools} more` : '';
    const tools = t.tools.length
      ? t.tools.map((c) => escapeHtml(c.title)).join(', ') + more
      : 'No tools used';
    const time = new Date(t.startedAt).toLocaleTimeString();
    return `
      <div class="agent-turn-row" data-turn-id="${escapeHtml(t.id)}" style="padding:6px 0 6px ${flagged ? '8px' : '0'};border-bottom:1px solid var(--color-border-subtle);${flagged ? 'border-left:2px solid var(--color-warning);' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <div style="display:flex;align-items:center;gap:6px;min-width:0;flex:1;">
            <span title="${outcome.label}" style="display:inline-flex;color:var(--color-text-secondary);">${icon(outcome.icon, { size: 12, label: outcome.label })}</span>
            <span style="font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(siteOf(t.origin))}</span>
            <code style="font-size:10px;color:var(--color-text-muted);flex-shrink:0;">${escapeHtml(t.api)}</code>
          </div>
          <span style="font-size:10px;color:var(--color-text-muted);flex-shrink:0;">${outcome.label} · ${escapeHtml(time)}</span>
        </div>
        <div class="agent-turn-prompt" title="${escapeHtml(t.prompt)}" style="font-size:11px;color:var(--color-text-secondary);margin-top:2px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${escapeHtml(t.prompt)}</div>
        <div class="agent-turn-tools" style="font-size:11px;color:var(--color-text-muted);margin-top:2px;display:flex;gap:4px;align-items:flex-start;">${icon('wrench', { size: 10 })}<span>${tools}</span></div>
        ${flagged ? '<div style="font-size:11px;color:var(--color-text-muted);margin-top:2px;">The site never showed you how this turn ended.</div>' : ''}
      </div>`;
  }).join('');
}

interface AgentTurnsIO {
  list(): Promise<{ turns: AgentTurnRecord[]; unseen: number } | null>;
  markSeen(): Promise<void>;
}

/**
 * Wires the list into the activity panel. Returns `refresh`, which the
 * activity panel calls whenever it reloads.
 */
export function initAgentTurnsSection(opts: {
  list: HTMLElement;
  panelBody: HTMLElement;
  /** Opens the activity panel, the same as clicking its header. */
  openPanel: () => void;
  io: AgentTurnsIO;
}): { refresh: () => Promise<void> } {
  const highlighted = new Set<string>();
  let first = true;

  async function refresh(): Promise<void> {
    const res = await opts.io.list().catch(() => null);
    if (!res) {
      opts.list.innerHTML = '<div class="empty-state">Could not load your agent\'s turns.</div>';
      return;
    }
    if (first && res.unseen > 0) opts.openPanel();
    first = false;
    const open = !opts.panelBody.classList.contains('collapsed');
    for (const t of res.turns) if (t.unseen && open) highlighted.add(t.id);
    opts.list.innerHTML = renderAgentTurns(res.turns, highlighted);
    if (open && res.unseen > 0) await opts.io.markSeen().catch(() => {});
  }

  return { refresh };
}
