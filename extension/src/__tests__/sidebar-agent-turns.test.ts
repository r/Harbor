import { describe, expect, it, vi } from 'vitest';
import { initAgentTurnsSection, renderAgentTurns } from '../sidebar-agent-turns';
import type { AgentTurnRecord } from '../page-api/agent-turns';

function record(over: Partial<AgentTurnRecord> = {}): AgentTurnRecord {
  return {
    id: 'turn_1', startedAt: 0, endedAt: 1, origin: 'https://notes.example', api: 'agent.run', agentId: 'a',
    prompt: 'tidy my notes', tools: [{ title: 'Edit notes.md', kind: 'edit' }], outcome: 'cancelled', unseen: true,
    ...over,
  };
}

/** Just enough of an element for the section: no DOM in this test environment. */
function fakeElement(classes: string[] = []) {
  const set = new Set(classes);
  return {
    innerHTML: '',
    classList: { contains: (c: string) => set.has(c), add: (c: string) => { set.add(c); }, remove: (c: string) => { set.delete(c); } },
  } as unknown as HTMLElement;
}

function setup(turns: AgentTurnRecord[]) {
  const list = fakeElement();
  const panelBody = fakeElement(['collapsed']);
  const markSeen = vi.fn(async () => {});
  const openPanel = vi.fn(() => panelBody.classList.remove('collapsed'));
  const section = initAgentTurnsSection({
    list, panelBody, openPanel,
    io: { list: async () => ({ turns, unseen: turns.filter((t) => t.unseen).length }), markSeen },
  });
  return { list, panelBody, markSeen, openPanel, section };
}

describe('the agent turns list', () => {
  it("shows the site, API, prompt, tools and outcome, and escapes the site's text", () => {
    const html = renderAgentTurns([record({ prompt: '<img src=x onerror=alert(1)>', tools: [{ title: '<b>Edit</b>' }] })], new Set());
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('notes.example');
    expect(html).toContain('agent.run');
    expect(html).toContain('&lt;b&gt;Edit&lt;/b&gt;');
    expect(html).toContain('Cancelled');
  });

  it('opens the activity panel on first load when a turn is unseen, then clears the badge, and keeps the turn marked', async () => {
    const { list, markSeen, openPanel, section } = setup([record()]);
    await section.refresh();
    expect(openPanel).toHaveBeenCalledTimes(1);
    expect(markSeen).toHaveBeenCalledTimes(1);
    expect(list.innerHTML).toContain('The site never showed you how this turn ended.');
  });

  it("doesn't clear the badge while the panel is closed", async () => {
    const turns = [record({ unseen: false })];
    const { markSeen, openPanel, section } = setup(turns);
    await section.refresh();
    expect(openPanel).not.toHaveBeenCalled();

    // A new unseen turn arrives after the sidebar loaded, with the panel still closed.
    turns.push(record({ id: 'turn_2' }));
    await section.refresh();
    expect(openPanel).not.toHaveBeenCalled();
    expect(markSeen).not.toHaveBeenCalled();
  });
});
