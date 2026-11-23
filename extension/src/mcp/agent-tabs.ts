/**
 * The person's own agent, running outside the browser, reaching into tabs
 * (docs/AGENT_REACHES_TABS.md).
 *
 * The agent talks MCP to `harbor-mcp`, which relays each tool call to the
 * bridge, which hands it here as an `agent_tabs.request` host request. This
 * module answers with an MCP CallToolResult every time, never a thrown error.
 *
 * What an agent can reach:
 * - tabs it opened with `open_page`, pinned to the origin they first load,
 *   until they close or leave that origin;
 * - tabs the person shared from the sidebar, while they stay on the shared
 *   origin.
 * Nothing else. A page handle is random, and only the agent that opened a tab
 * can use its handle; shared tabs get one handle every agent can use.
 *
 * The page's tools come from the page-tool registry (mcp/page-tools.ts) and
 * go through the same policy gate as page tools elsewhere. Their output is
 * untrusted page content, passed back as data.
 */

export const AGENT_TABS_LIMITS = Object.freeze({
  /** Per agent id. Ids are self-reported, so this guards against a runaway agent, not a hostile local process. */
  callsPerMinute: 60,
  /** Every agent together, so a fresh id per call can't escape the limit. */
  totalCallsPerMinute: 120,
  maxIdLength: 128,
});

const SETTING_OFF_MESSAGE =
  "Turn on 'Agents outside the browser' in Harbor's Agent panel to let your agent open and use pages.";

export interface AgentTabsRequest {
  agentId: unknown;
  agentName: unknown;
  op: unknown;
  params: unknown;
}

interface PageToolListing {
  generation: number;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

export interface AgentTabsDeps {
  /** Whether "Agents outside the browser" is on. */
  isEnabled(): Promise<boolean>;
  /** Open `url` in a new, focused tab; resolves to its tab id. */
  createTab(url: string): Promise<number>;
  /** The tab's current URL and title, or null if it's gone. */
  getTab(tabId: number): Promise<{ url?: string; title?: string } | null>;
  listPageTools(tabId: number, origin: string): PageToolListing | null;
  /** The `tool.list` policy check (audited). */
  allowToolList(origin: string, tabId: number): Promise<boolean>;
  /** Policy-check (audited) and run one page tool. Rejects on refusal or failure. */
  callPageTool(call: { origin: string; tabId: number; generation: number; name: string; input: Record<string, unknown> }): Promise<unknown>;
  now(): number;
}

interface AgentTab {
  tabId: number;
  /** Null until the tab's first load completes; then fixed. */
  origin: string | null;
  /** Opened by this agent, or shared by the person (any agent). */
  owner: string | { shared: true };
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true; structuredContent?: Record<string, unknown>; _meta?: Record<string, unknown> };

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function dataResult(text: string, structuredContent: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** Where a page's tool came from, from the browser's own record of the page (never the site's own text). */
function provenance(origin: string) {
  return { 'harbor/provenance': { source: 'page-tool', origin } };
}

function describedBy(origin: string, description: string): string {
  const host = new URL(origin).host;
  const text = description.trim();
  return text ? `From ${host}: ${text}` : `From ${host}.`;
}

function randomHandle(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A page tool's result as an MCP CallToolResult. Untrusted page content, passed as data only. */
function toolCallResult(result: unknown): ToolResult {
  if (typeof result === 'string') return { content: [{ type: 'text', text: result }] };
  let text: string;
  try {
    text = result === undefined ? '' : JSON.stringify(result);
  } catch {
    return errorResult("The page tool's result can't be sent");
  }
  return isRecord(result) ? { content: [{ type: 'text', text }], structuredContent: result } : { content: [{ type: 'text', text }] };
}

export function createAgentTabs(deps: AgentTabsDeps) {
  /** page handle → tab */
  const pages = new Map<string, AgentTab>();
  /** agentId → call timestamps in the last minute */
  const recentCalls = new Map<string, number[]>();
  /** agentId → display name and when it was last seen */
  const agents = new Map<string, { name: string; lastSeen: number }>();

  function dropTab(tabId: number): void {
    for (const [handle, entry] of pages) if (entry.tabId === tabId) pages.delete(handle);
  }

  function canUse(entry: AgentTab, agentId: string): boolean {
    return typeof entry.owner === 'string' ? entry.owner === agentId : true;
  }

  /** The tab behind `page`, if this agent may use it and it's still on its pinned origin. */
  async function resolve(page: unknown, agentId: string): Promise<{ entry: AgentTab; origin: string } | ToolResult> {
    const entry = typeof page === 'string' ? pages.get(page) : undefined;
    if (!entry || !canUse(entry, agentId)) return errorResult('No such page. Call list_pages to see the pages you can use.');
    const tab = await deps.getTab(entry.tabId);
    if (!tab) {
      dropTab(entry.tabId);
      return errorResult('That page has been closed.');
    }
    const current = originOf(tab.url);
    // Before its first load completes, a tab the agent opened isn't pinned
    // yet (tabLoaded does that), and it may still be redirecting: use where
    // it is now, but don't pin or drop it here.
    if (!current) {
      if (entry.origin === null) return errorResult('That page is still loading; try again shortly.');
      dropTab(entry.tabId);
      return errorResult('That page has moved away from the web page it showed, so it is no longer available.');
    }
    if (entry.origin === null) return { entry, origin: current };
    if (current !== entry.origin) {
      dropTab(entry.tabId);
      return errorResult('That page has moved to another site, so it is no longer available.');
    }
    return { entry, origin: current };
  }

  let recentTotal: number[] = [];

  function overRateLimit(agentId: string): boolean {
    const now = deps.now();
    const recent = (recentCalls.get(agentId) ?? []).filter((t) => now - t < 60_000);
    recentTotal = recentTotal.filter((t) => now - t < 60_000);
    recentCalls.set(agentId, recent);
    if (recent.length >= AGENT_TABS_LIMITS.callsPerMinute) return true;
    if (recentTotal.length >= AGENT_TABS_LIMITS.totalCallsPerMinute) return true;
    recent.push(now);
    recentTotal.push(now);
    return false;
  }

  async function openPage(agentId: string, params: Record<string, unknown>): Promise<ToolResult> {
    const url = typeof params.url === 'string' ? params.url : '';
    if (!originOf(url)) return errorResult('open_page needs an http or https URL.');
    if (overRateLimit(agentId)) return errorResult('Too many requests; wait a minute and try again.');
    let tabId: number;
    try {
      tabId = await deps.createTab(url);
    } catch {
      return errorResult("Harbor couldn't open that page.");
    }
    const handle = randomHandle();
    pages.set(handle, { tabId, origin: null, owner: agentId });
    return dataResult(`Opened ${url} as page ${handle}. Call list_page_tools once it has loaded.`, { page: handle, url });
  }

  async function listPages(agentId: string): Promise<ToolResult> {
    const listed: Array<{ page: string; url: string; title: string; hasTools: boolean; sharedByPerson: boolean }> = [];
    for (const [handle, entry] of [...pages]) {
      if (!canUse(entry, agentId)) continue;
      const tab = await deps.getTab(entry.tabId);
      const current = originOf(tab?.url);
      if (!tab || !current || (entry.origin !== null && current !== entry.origin)) {
        dropTab(entry.tabId);
        continue;
      }
      listed.push({
        page: handle,
        url: tab.url ?? '',
        title: tab.title ?? '',
        // Behind the same policy check as list_page_tools, so a page whose
        // tools policy refuses doesn't show as having them.
        hasTools: (deps.listPageTools(entry.tabId, current)?.tools.length ?? 0) > 0
          && await deps.allowToolList(current, entry.tabId),
        sharedByPerson: typeof entry.owner !== 'string',
      });
    }
    const text = listed.length === 0
      ? 'No pages yet. Open one with open_page, or ask the person to share a tab from Harbor.'
      : JSON.stringify(listed);
    return dataResult(text, { pages: listed });
  }

  async function listTools(agentId: string, params: Record<string, unknown>): Promise<ToolResult> {
    const resolved = await resolve(params.page, agentId);
    if ('content' in resolved) return resolved;
    const { entry, origin } = resolved;
    if (!(await deps.allowToolList(origin, entry.tabId))) {
      return errorResult("Harbor's policy doesn't allow this page's tools.");
    }
    const listing = deps.listPageTools(entry.tabId, origin);
    const tools = (listing?.tools ?? []).map((t) => ({
      name: t.name,
      description: describedBy(origin, t.description),
      inputSchema: t.inputSchema,
      _meta: provenance(origin),
    }));
    const text = tools.length === 0
      ? 'This page offers no tools (yet). If it is still loading, try again shortly.'
      : JSON.stringify(tools);
    return dataResult(text, { tools });
  }

  async function callTool(agentId: string, params: Record<string, unknown>): Promise<ToolResult> {
    const resolved = await resolve(params.page, agentId);
    if ('content' in resolved) return resolved;
    const { entry, origin } = resolved;
    const name = typeof params.tool === 'string' ? params.tool : '';
    if (!name) return errorResult('call_page_tool needs a tool name.');
    if (overRateLimit(agentId)) return errorResult('Too many page tool calls; wait a minute and try again.');
    const listing = deps.listPageTools(entry.tabId, origin);
    if (!listing) return errorResult('This page offers no tools right now. Call list_page_tools again.');
    const input = isRecord(params.input) ? params.input : {};
    try {
      const result = await deps.callPageTool({ origin, tabId: entry.tabId, generation: listing.generation, name, input });
      return { ...toolCallResult(result), _meta: provenance(origin) };
    } catch (e) {
      return { ...errorResult(e instanceof Error && e.message ? e.message : 'Page tool failed'), _meta: provenance(origin) };
    }
  }

  return {
    async handleRequest(request: AgentTabsRequest): Promise<ToolResult> {
      const { agentId, agentName, op } = request;
      const params = isRecord(request.params) ? request.params : {};
      if (typeof agentId !== 'string' || agentId === '' || agentId.length > AGENT_TABS_LIMITS.maxIdLength) {
        return errorResult('Invalid agent.');
      }
      const name = typeof agentName === 'string' && agentName ? agentName.slice(0, AGENT_TABS_LIMITS.maxIdLength) : 'agent';
      agents.set(agentId, { name, lastSeen: deps.now() });
      if (!(await deps.isEnabled())) return errorResult(SETTING_OFF_MESSAGE);
      switch (op) {
        case 'open_page': return openPage(agentId, params);
        case 'list_pages': return listPages(agentId);
        case 'list_page_tools': return listTools(agentId, params);
        case 'call_page_tool': return callTool(agentId, params);
        default: return errorResult('Unknown request.');
      }
    },

    /** The person shares a tab they opened with every connected agent. */
    shareTab(tabId: number, origin: string): string {
      for (const [handle, entry] of pages) {
        if (entry.tabId === tabId && typeof entry.owner !== 'string') return handle;
      }
      const handle = randomHandle();
      pages.set(handle, { tabId, origin, owner: { shared: true } });
      return handle;
    },

    unshareTab(tabId: number): void {
      for (const [handle, entry] of pages) {
        if (entry.tabId === tabId && typeof entry.owner !== 'string') pages.delete(handle);
      }
    },

    isShared(tabId: number): boolean {
      return [...pages.values()].some((e) => e.tabId === tabId && typeof e.owner !== 'string');
    },

    /** A tab's first load finished: pin an opened tab to that origin. */
    tabLoaded(tabId: number, url: string): void {
      const origin = originOf(url);
      for (const entry of pages.values()) {
        if (entry.tabId === tabId && entry.origin === null && origin) entry.origin = origin;
      }
    },

    /** A tab's URL changed: drop it from any entry pinned to another origin. */
    tabNavigated(tabId: number, url: string): void {
      const origin = originOf(url);
      for (const [handle, entry] of pages) {
        if (entry.tabId !== tabId || entry.origin === null) continue;
        if (origin !== entry.origin) pages.delete(handle);
      }
    },

    tabRemoved(tabId: number): void {
      dropTab(tabId);
    },

    connectedAgents(): Array<{ name: string; lastSeen: number }> {
      return [...agents.values()].sort((a, b) => b.lastSeen - a.lastSeen);
    },
  };
}

export type AgentTabs = ReturnType<typeof createAgentTabs>;
