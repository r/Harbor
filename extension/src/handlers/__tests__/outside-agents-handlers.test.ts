/**
 * The sidebar's controls for the person's own agent outside the browser
 * (docs/AGENT_REACHES_TABS.md): reading the state, turning the setting on or
 * off, and sharing the current tab. Only Harbor's own pages may use them —
 * a site that could flip the setting or share a tab could hand itself to an
 * agent.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser, getMockStorage } from '../../__tests__/test-setup';

type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

const listeners: Listener[] = [];
const mocks = vi.hoisted(() => ({ bridgeRequest: vi.fn(), tabsQuery: vi.fn() }));
vi.mock('../../llm/bridge-client', () => ({ bridgeRequest: mocks.bridgeRequest }));

const EXTENSION_SENDER = { id: 'harbor-test', url: 'chrome-extension://harbor-test/sidebar.html' } as chrome.runtime.MessageSender;
const PAGE_SENDER = { id: 'harbor-test', url: 'https://example.com/page', tab: { id: 1 } } as chrome.runtime.MessageSender;

let agentTabs: typeof import('../agent-tabs-handlers')['agentTabs'];

beforeAll(async () => {
  const chromeGlobal = (globalThis as unknown as { chrome: Record<string, any> }).chrome;
  chromeGlobal.runtime.onMessage.addListener = (l: Listener) => { listeners.push(l); };
  chromeGlobal.tabs.query = mocks.tabsQuery;
  const mod = await import('../agent-tabs-handlers');
  mod.registerOutsideAgentHandlers();
  agentTabs = mod.agentTabs;
});

beforeEach(() => {
  resetMockBrowser();
  mocks.bridgeRequest.mockReset();
  mocks.bridgeRequest.mockResolvedValue({ mcpCommand: '/opt/harbor/harbor-mcp', socketPath: '/Users/x/.harbor/agent.sock' });
  mocks.tabsQuery.mockReset();
  mocks.tabsQuery.mockResolvedValue([{ id: 42, url: 'https://news.example/story', title: 'Story' }]);
});

function dispatch(message: Record<string, unknown>, sender = EXTENSION_SENDER): Promise<any> {
  return new Promise((resolve) => {
    let done = false;
    for (const l of listeners) l(message, sender, (r) => { if (!done) { done = true; resolve(r); } });
  });
}

describe('sender checks', () => {
  for (const message of [
    { type: 'outside_agents_get' },
    { type: 'outside_agents_set_enabled', enabled: true },
    { type: 'outside_agents_share_tab', share: true },
  ]) {
    it(`${message.type} refuses a content-script sender`, async () => {
      expect(await dispatch(message, PAGE_SENDER)).toEqual({ ok: false, error: 'Not available to this sender' });
      expect(getMockStorage().local.data.harbor_outside_agents_enabled).toBeUndefined();
      expect(agentTabs.isShared(42)).toBe(false);
    });
  }
});

describe('outside_agents_get', () => {
  it('reports the setting off by default, the connect command, and the current tab', async () => {
    const r = await dispatch({ type: 'outside_agents_get' });
    expect(r).toMatchObject({
      ok: true,
      enabled: false,
      mcpCommand: '/opt/harbor/harbor-mcp',
      activeTab: { url: 'https://news.example/story', shared: false, shareable: true },
      agents: [],
    });
  });

  it('still answers when the bridge has no connect command (older bridge, or not running)', async () => {
    mocks.bridgeRequest.mockRejectedValue(new Error('unknown method'));
    const r = await dispatch({ type: 'outside_agents_get' });
    expect(r).toMatchObject({ ok: true, mcpCommand: null });
  });

  it("says a non-web tab can't be shared", async () => {
    mocks.tabsQuery.mockResolvedValue([{ id: 7, url: 'about:addons', title: 'Add-ons' }]);
    const r = await dispatch({ type: 'outside_agents_get' });
    expect(r.activeTab).toMatchObject({ shareable: false });
  });
});

describe('outside_agents_set_enabled', () => {
  it('turns the setting on and off', async () => {
    expect(await dispatch({ type: 'outside_agents_set_enabled', enabled: true })).toEqual({ ok: true });
    expect(getMockStorage().local.data.harbor_outside_agents_enabled).toBe(true);
    await dispatch({ type: 'outside_agents_set_enabled', enabled: false });
    expect(getMockStorage().local.data.harbor_outside_agents_enabled).toBe(false);
  });

  it('refuses a non-boolean', async () => {
    expect((await dispatch({ type: 'outside_agents_set_enabled', enabled: 'yes' })).ok).toBe(false);
  });
});

describe('outside_agents_share_tab', () => {
  it('shares and unshares the current tab', async () => {
    expect(await dispatch({ type: 'outside_agents_share_tab', share: true })).toEqual({ ok: true, shared: true });
    expect(agentTabs.isShared(42)).toBe(true);
    expect(await dispatch({ type: 'outside_agents_share_tab', share: false })).toEqual({ ok: true, shared: false });
    expect(agentTabs.isShared(42)).toBe(false);
  });

  it("refuses to share a tab that isn't a web page", async () => {
    mocks.tabsQuery.mockResolvedValue([{ id: 7, url: 'about:addons' }]);
    expect((await dispatch({ type: 'outside_agents_share_tab', share: true })).ok).toBe(false);
    expect(agentTabs.isShared(7)).toBe(false);
  });
});
