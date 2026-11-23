import { describe, expect, it } from 'vitest';
import { describeOutsideAgents } from '../sidebar-outside-agents';

describe("the Agent panel's outside-agent section", () => {
  it('starts off, and sharing is disabled until the setting is on', () => {
    const view = describeOutsideAgents({ ok: true, enabled: false, mcpCommand: '/opt/harbor-mcp', activeTab: { url: 'https://a.example/', title: 'A', shareable: true, shared: false }, agents: [] });
    expect(view).toMatchObject({ enabled: false, canShare: false, canCopy: true, commandText: '/opt/harbor-mcp', listText: 'No agent has connected yet.' });
    expect(view.shareHint).toMatch(/Turn this on/);
  });

  it('offers to share a web page once on, and to stop sharing a shared one', () => {
    const tab = { url: 'https://a.example/', title: 'A', shareable: true, shared: false };
    expect(describeOutsideAgents({ ok: true, enabled: true, activeTab: tab })).toMatchObject({ canShare: true, shareLabel: 'Share this tab with your agent' });
    expect(describeOutsideAgents({ ok: true, enabled: true, activeTab: { ...tab, shared: true } })).toMatchObject({ canShare: true, shareLabel: 'Stop sharing this tab' });
  });

  it("can't share a non-web tab", () => {
    const view = describeOutsideAgents({ ok: true, enabled: true, activeTab: { url: 'about:addons', title: '', shareable: false, shared: false } });
    expect(view.canShare).toBe(false);
    expect(view.shareHint).toMatch(/Only web pages/);
  });

  it('explains a missing command, and names connected agents', () => {
    const view = describeOutsideAgents({ ok: true, enabled: true, mcpCommand: null, agents: [{ name: 'goose', lastSeen: 2 }, { name: 'claude-code', lastSeen: 1 }] });
    expect(view.canCopy).toBe(false);
    expect(view.commandText).toMatch(/bridge isn't connected/);
    expect(view.listText).toBe('Connected: goose, claude-code');
  });
});
