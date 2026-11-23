/**
 * Wiring for the person's own agent, running outside the browser, reaching
 * into tabs (mcp/agent-tabs.ts, docs/AGENT_REACHES_TABS.md): the real tabs
 * API, the "Agents outside the browser" setting, the page-tool registry and
 * its policy gate, and the tab events that end an agent's access.
 */
import { browserAPI } from '../browser-compat';
import { createAgentTabs, type AgentTabsRequest } from '../mcp/agent-tabs';
import { callPageToolForAgent, listPageToolsForTab, policyAllowsPageToolList } from '../page-api/harbor-core';

/** storage.local key for the "Agents outside the browser" setting. Off unless the person turns it on. */
export const OUTSIDE_AGENTS_SETTING = 'harbor_outside_agents_enabled';

export const agentTabs = createAgentTabs({
  async isEnabled() {
    const stored = await browserAPI.storage.local.get(OUTSIDE_AGENTS_SETTING);
    return stored?.[OUTSIDE_AGENTS_SETTING] === true;
  },
  async createTab(url) {
    const tab = await browserAPI.tabs.create({ url, active: true });
    if (tab.id === undefined) throw new Error('No tab id');
    return tab.id;
  },
  async getTab(tabId) {
    try {
      const tab = await browserAPI.tabs.get(tabId);
      return { url: tab.url, title: tab.title };
    } catch {
      return null;
    }
  },
  listPageTools: (tabId, origin) => listPageToolsForTab(tabId, origin),
  allowToolList: (origin, tabId) => policyAllowsPageToolList(origin, tabId),
  callPageTool: ({ origin, tabId, generation, name, input }) =>
    callPageToolForAgent({ origin, tabId, generation, name, input }),
  now: () => Date.now(),
});

let initialized = false;

/** Ends an agent's access when its tabs close or leave their site. */
export function initializeAgentTabs(): void {
  if (initialized) return;
  initialized = true;
  browserAPI.tabs.onRemoved?.addListener((tabId: number) => agentTabs.tabRemoved(tabId));
  browserAPI.tabs.onUpdated?.addListener((tabId: number, changeInfo: { url?: string; status?: string }, tab?: { url?: string }) => {
    if (changeInfo.url) agentTabs.tabNavigated(tabId, changeInfo.url);
    if (changeInfo.status === 'complete' && tab?.url) agentTabs.tabLoaded(tabId, tab.url);
  });
}

/** The bridge relaying one request from `harbor-mcp`. Always an MCP CallToolResult. */
export function handleAgentTabsHostRequest(params: unknown) {
  const p = (params && typeof params === 'object' ? params : {}) as Partial<AgentTabsRequest>;
  return agentTabs.handleRequest({ agentId: p.agentId, agentName: p.agentName, op: p.op, params: p.params });
}
