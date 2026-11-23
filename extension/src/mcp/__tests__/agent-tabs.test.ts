/**
 * The person's own agent, running outside the browser, reaching into tabs
 * (docs/AGENT_REACHES_TABS.md). Each op answers with an MCP CallToolResult,
 * never a thrown error. The agent sees only tabs it opened (pinned to their
 * origin) or tabs the person shared, and only while the setting is on.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAgentTabs, AGENT_TABS_LIMITS } from '../agent-tabs';

const AGENT = 'agent-aaaaaaaaaaaaaaaa';
const OTHER_AGENT = 'agent-bbbbbbbbbbbbbbbb';

function harness() {
  const tabs = new Map<number, { id: number; url: string; title: string }>();
  let nextTab = 10;
  let enabled = true;
  const pageTools = new Map<number, { origin: string; generation: number; tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }>();
  const deps = {
    isEnabled: vi.fn(async () => enabled),
    createTab: vi.fn(async (url: string) => {
      const id = nextTab++;
      tabs.set(id, { id, url, title: 'Loading' });
      return id;
    }),
    getTab: vi.fn(async (tabId: number) => tabs.get(tabId) ?? null),
    listPageTools: vi.fn((tabId: number, origin: string) => {
      const entry = pageTools.get(tabId);
      return entry && entry.origin === origin ? { generation: entry.generation, tools: entry.tools } : null;
    }),
    allowToolList: vi.fn(async () => true),
    callPageTool: vi.fn(async (_call: { origin: string; tabId: number; generation: number; name: string; input: Record<string, unknown> }) => ({ ok: true }) as unknown),
    now: vi.fn(() => 1_000_000),
  };
  const agentTabs = createAgentTabs(deps);
  return {
    deps, tabs, pageTools, agentTabs,
    setEnabled: (v: boolean) => { enabled = v; },
    request: (op: string, params: Record<string, unknown> = {}, agentId = AGENT) =>
      agentTabs.handleRequest({ agentId, agentName: 'goose', op, params }),
  };
}

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const pageOf = (r: unknown) => (r as { structuredContent: { page: string } }).structuredContent.page;

describe('the setting', () => {
  it('refuses every op while "Agents outside the browser" is off', async () => {
    const h = harness();
    h.setEnabled(false);
    for (const op of ['open_page', 'list_pages', 'list_page_tools', 'call_page_tool']) {
      const r = await h.request(op, { url: 'https://tale.example/', page: 'x', tool: 'y', input: {} });
      expect(isError(r)).toBe(true);
      expect(text(r)).toMatch(/Agents outside the browser/);
    }
    expect(h.deps.createTab).not.toHaveBeenCalled();
  });
});

describe('open_page', () => {
  it('opens the URL in a new tab and returns a page handle', async () => {
    const h = harness();
    const r = await h.request('open_page', { url: 'https://tale.example/book#p3' });
    expect(isError(r)).toBe(false);
    expect(h.deps.createTab).toHaveBeenCalledWith('https://tale.example/book#p3');
    expect(pageOf(r)).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'about:config', 'moz-extension://x/sidebar.html', 'not a url', ''])(
    'refuses %s', async (url) => {
      const h = harness();
      const r = await h.request('open_page', { url });
      expect(isError(r)).toBe(true);
      expect(h.deps.createTab).not.toHaveBeenCalled();
    });

  it('refuses a missing url', async () => {
    const h = harness();
    expect(isError(await h.request('open_page', {}))).toBe(true);
  });
});

describe('which tabs an agent sees', () => {
  it('lists the tabs this agent opened, not another agent\'s', async () => {
    const h = harness();
    const mine = pageOf(await h.request('open_page', { url: 'https://tale.example/' }));
    await h.request('open_page', { url: 'https://other.example/' }, OTHER_AGENT);
    const listed = (await h.request('list_pages')) as unknown as { structuredContent: { pages: Array<{ page: string; url: string }> } };
    expect(listed.structuredContent.pages.map((p) => p.page)).toEqual([mine]);
  });

  it('lists a tab the person shared, for every agent', async () => {
    const h = harness();
    h.tabs.set(5, { id: 5, url: 'https://news.example/a', title: 'News' });
    h.agentTabs.shareTab(5, 'https://news.example');
    for (const agent of [AGENT, OTHER_AGENT]) {
      const listed = (await h.request('list_pages', {}, agent)) as unknown as { structuredContent: { pages: Array<{ url: string; title: string }> } };
      expect(listed.structuredContent.pages).toEqual([expect.objectContaining({ url: 'https://news.example/a', title: 'News' })]);
    }
  });

  it('an unknown or guessed handle is refused', async () => {
    const h = harness();
    const r = await h.request('list_page_tools', { page: 'not-a-real-handle' });
    expect(isError(r)).toBe(true);
  });

  it("one agent can't use another agent's page handle", async () => {
    const h = harness();
    const theirs = pageOf(await h.request('open_page', { url: 'https://tale.example/' }, OTHER_AGENT));
    expect(isError(await h.request('list_page_tools', { page: theirs }))).toBe(true);
  });

  it('drops a tab when it closes', async () => {
    const h = harness();
    const page = pageOf(await h.request('open_page', { url: 'https://tale.example/' }));
    h.tabs.delete(10);
    h.agentTabs.tabRemoved(10);
    expect(isError(await h.request('list_page_tools', { page }))).toBe(true);
  });

  it('pins an opened tab to the origin it first loads, and drops it when it leaves that origin', async () => {
    const h = harness();
    const page = pageOf(await h.request('open_page', { url: 'http://tale.example/' }));
    // A redirect to https before the first load completes is fine.
    h.agentTabs.tabNavigated(10, 'https://tale.example/');
    h.agentTabs.tabLoaded(10, 'https://tale.example/');
    h.tabs.set(10, { id: 10, url: 'https://tale.example/ch2', title: 'Ch 2' });
    h.agentTabs.tabNavigated(10, 'https://tale.example/ch2');
    h.pageTools.set(10, { origin: 'https://tale.example', generation: 1, tools: [{ name: 'play', description: 'Play', inputSchema: { type: 'object' } }] });
    expect(isError(await h.request('list_page_tools', { page }))).toBe(false);
    h.agentTabs.tabNavigated(10, 'https://elsewhere.example/');
    expect(isError(await h.request('list_page_tools', { page }))).toBe(true);
  });

  it('drops a shared tab when it leaves the shared origin', async () => {
    const h = harness();
    h.tabs.set(5, { id: 5, url: 'https://news.example/a', title: 'News' });
    h.agentTabs.shareTab(5, 'https://news.example');
    h.agentTabs.tabNavigated(5, 'https://ads.example/');
    const listed = (await h.request('list_pages')) as unknown as { structuredContent: { pages: unknown[] } };
    expect(listed.structuredContent.pages).toEqual([]);
  });
});

describe('page tools', () => {
  async function openWithTools(h: ReturnType<typeof harness>) {
    const page = pageOf(await h.request('open_page', { url: 'https://tale.example/' }));
    h.agentTabs.tabLoaded(10, 'https://tale.example/');
    h.tabs.set(10, { id: 10, url: 'https://tale.example/', title: 'Tale' });
    h.pageTools.set(10, { origin: 'https://tale.example', generation: 7, tools: [
      { name: 'play', description: 'Play the passage', inputSchema: { type: 'object' } },
      { name: 'pause', description: 'Pause', inputSchema: { type: 'object' } },
    ] });
    return page;
  }

  it('lists the page\'s tools after the policy check', async () => {
    const h = harness();
    const page = await openWithTools(h);
    const r = (await h.request('list_page_tools', { page })) as unknown as { structuredContent: { tools: Array<{ name: string }> } };
    expect(r.structuredContent.tools.map((t) => t.name)).toEqual(['play', 'pause']);
    expect(h.deps.allowToolList).toHaveBeenCalledWith('https://tale.example', 10);
  });

  it('lists none when policy refuses them', async () => {
    const h = harness();
    const page = await openWithTools(h);
    h.deps.allowToolList.mockResolvedValue(false);
    const r = await h.request('list_page_tools', { page });
    expect(isError(r)).toBe(true);
  });

  it('says so when the page offers no tools yet', async () => {
    const h = harness();
    const page = pageOf(await h.request('open_page', { url: 'https://tale.example/' }));
    h.agentTabs.tabLoaded(10, 'https://tale.example/');
    const r = (await h.request('list_page_tools', { page })) as unknown as { structuredContent: { tools: unknown[] } };
    expect(r.structuredContent.tools).toEqual([]);
    expect(text(r)).toMatch(/no tools/i);
  });

  it('calls a tool in the page and returns its result as data', async () => {
    const h = harness();
    const page = await openWithTools(h);
    h.deps.callPageTool.mockResolvedValue({ state: 'paused', at: 42 });
    const r = await h.request('call_page_tool', { page, tool: 'pause', input: {} });
    expect(h.deps.callPageTool).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'https://tale.example', tabId: 10, generation: 7, name: 'pause', input: {},
    }));
    expect(r).toEqual({ content: [{ type: 'text', text: JSON.stringify({ state: 'paused', at: 42 }) }], structuredContent: { state: 'paused', at: 42 } });
  });

  it("passes the page's error back as an isError result", async () => {
    const h = harness();
    const page = await openWithTools(h);
    h.deps.callPageTool.mockRejectedValue(Object.assign(new Error('needs_gesture'), { code: 'ERR_TOOL_FAILED' }));
    const r = await h.request('call_page_tool', { page, tool: 'play', input: {} });
    expect(r).toEqual({ content: [{ type: 'text', text: 'needs_gesture' }], isError: true });
  });

  it('passes {} for non-object input', async () => {
    const h = harness();
    const page = await openWithTools(h);
    await h.request('call_page_tool', { page, tool: 'play', input: 'nope' });
    expect(h.deps.callPageTool).toHaveBeenCalledWith(expect.objectContaining({ input: {} }));
  });

  it('rate-limits one agent, not others', async () => {
    const h = harness();
    const page = await openWithTools(h);
    // open_page used one of the minute's calls.
    for (let i = 0; i < AGENT_TABS_LIMITS.callsPerMinute - 1; i++) {
      expect(isError(await h.request('call_page_tool', { page, tool: 'play', input: {} }))).toBe(false);
    }
    const over = await h.request('call_page_tool', { page, tool: 'play', input: {} });
    expect(isError(over)).toBe(true);
    expect(text(over)).toMatch(/too many/i);
    // A minute later it's allowed again.
    h.deps.now.mockReturnValue(1_000_000 + 61_000);
    expect(isError(await h.request('call_page_tool', { page, tool: 'play', input: {} }))).toBe(false);
  });
});

describe('requests', () => {
  it('refuses an unknown op', async () => {
    const h = harness();
    expect(isError(await h.request('click', {}))).toBe(true);
  });

  it('remembers connected agents by name for the sidebar', async () => {
    const h = harness();
    await h.request('list_pages');
    expect(h.agentTabs.connectedAgents()).toEqual([expect.objectContaining({ name: 'goose' })]);
  });
});

describe('review fixes', () => {
  it("doesn't pin a tab to a pre-redirect origin when the agent asks before the first load finishes", async () => {
    const h = harness();
    const page = pageOf(await h.request('open_page', { url: 'http://tale.example/' }));
    // The agent asks right away, while the tab is still on the pre-redirect URL.
    await h.request('list_page_tools', { page });
    // Then the redirect lands and the first load completes on https.
    h.tabs.set(10, { id: 10, url: 'https://tale.example/', title: 'Tale' });
    h.agentTabs.tabNavigated(10, 'https://tale.example/');
    h.agentTabs.tabLoaded(10, 'https://tale.example/');
    h.pageTools.set(10, { origin: 'https://tale.example', generation: 1, tools: [{ name: 'play', description: 'Play', inputSchema: { type: 'object' } }] });
    const r = (await h.request('list_page_tools', { page })) as unknown as { structuredContent?: { tools: Array<{ name: string }> } };
    expect(isError(r)).toBe(false);
    expect(r.structuredContent?.tools.map((t) => t.name)).toEqual(['play']);
  });

  it('says a page is still loading, without dropping it, when its URL is not a web page yet', async () => {
    const h = harness();
    const page = pageOf(await h.request('open_page', { url: 'https://tale.example/' }));
    h.tabs.set(10, { id: 10, url: 'about:blank', title: '' });
    const r = await h.request('list_page_tools', { page });
    expect(isError(r)).toBe(true);
    expect(text(r)).toMatch(/still loading/i);
    h.tabs.set(10, { id: 10, url: 'https://tale.example/', title: 'Tale' });
    expect(isError(await h.request('list_page_tools', { page }))).toBe(false);
  });

  it('counts open_page against the rate limit', async () => {
    const h = harness();
    for (let i = 0; i < AGENT_TABS_LIMITS.callsPerMinute; i++) {
      expect(isError(await h.request('open_page', { url: `https://tale.example/${i}` }))).toBe(false);
    }
    expect(text(await h.request('open_page', { url: 'https://tale.example/x' }))).toMatch(/too many/i);
  });

  it('holds every agent together to an overall limit, so a fresh agent id per call does not escape it', async () => {
    const h = harness();
    let refused = 0;
    for (let i = 0; i < AGENT_TABS_LIMITS.totalCallsPerMinute + 5; i++) {
      const r = await h.request('open_page', { url: `https://tale.example/${i}` }, `agent-${i}`);
      if (isError(r)) refused++;
    }
    expect(refused).toBe(5);
  });

  it('reports hasTools only when policy allows the page\'s tools', async () => {
    const h = harness();
    await h.request('open_page', { url: 'https://tale.example/' });
    h.agentTabs.tabLoaded(10, 'https://tale.example/');
    h.tabs.set(10, { id: 10, url: 'https://tale.example/', title: 'Tale' });
    h.pageTools.set(10, { origin: 'https://tale.example', generation: 1, tools: [{ name: 'play', description: 'Play', inputSchema: { type: 'object' } }] });
    h.deps.allowToolList.mockResolvedValue(false);
    const listed = (await h.request('list_pages')) as unknown as { structuredContent: { pages: Array<{ hasTools: boolean }> } };
    expect(listed.structuredContent.pages[0].hasTools).toBe(false);
  });
});
