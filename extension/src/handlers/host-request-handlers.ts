/**
 * Host Request Handlers
 *
 * When the native bridge sends a host_request (e.g. an MCP server asking the
 * host to open a tab and return content/cookies), Harbor handles it locally.
 * MCP servers are solely owned by Harbor; no Web Agents dependency. See docs/MCP_BROWSER_CAPTURE_DESIGN.md §10.
 */

import type { HostRequestMessage } from '../llm/native-bridge';
import {
  isAllowedOrigin,
  runCapturePage,
  runGetCookies,
  runLoginThenCapture,
  runEnsureLogin,
} from './browser-capture';

/**
 * Handle a host_request from the bridge: run browser capture locally in Harbor.
 * Only allowed for origin 'harbor-extension' (MCP tools run from sidebar/Tool Tester).
 */
export async function handleHostRequest(msg: HostRequestMessage): Promise<unknown> {
  const { method, params, context } = msg;
  const origin = context?.origin;

  // The bridge's page-tools MCP endpoint relaying an ACP agent's tools/list
  // or tools/call (docs/PAGE_TOOLS_FOR_AGENTS.md §5). Only the bridge's own
  // endpoint sets this context; a JS MCP server's host requests carry the
  // context Harbor gave its tool call instead. harbor-core answers only for
  // an endpoint id it opened itself.
  if (method === 'page_tools.list' || method === 'page_tools.call') {
    if (origin !== 'harbor-bridge-page-tools') {
      throw new Error('Page tool requests come only from the bridge.');
    }
    const { handlePageToolsHostRequest } = await import('../page-api/harbor-core');
    return handlePageToolsHostRequest(method, params);
  }

  // The person's own agent, outside the browser, reaching into tabs through
  // harbor-mcp and the bridge (docs/AGENT_REACHES_TABS.md). Only the bridge's
  // own socket relay sets this context; a JS MCP server can't send
  // agent_tabs.* at all (the bridge refuses it).
  if (method === 'agent_tabs.request') {
    if (origin !== 'harbor-bridge-agent-tabs') {
      throw new Error('Agent tab requests come only from the bridge.');
    }
    const { handleAgentTabsHostRequest } = await import('./agent-tabs-handlers');
    return handleAgentTabsHostRequest(params);
  }

  // http.get sends no cookies, so any tool may use it.
  if (method === 'http.get') {
    return runHttpGet((params ?? {}) as Record<string, unknown>);
  }

  if (!isAllowedOrigin(origin)) {
    throw new Error('Browser capture is only allowed from the Harbor sidebar.');
  }

  if (method === 'browser.capturePage') {
    return runCapturePage((params ?? {}) as Record<string, unknown>);
  }
  if (method === 'browser.getCookies') {
    return runGetCookies((params ?? {}) as Record<string, unknown>);
  }
  if (method === 'browser.loginThenCapture') {
    return runLoginThenCapture((params ?? {}) as Record<string, unknown>);
  }
  if (method === 'browser.ensureLogin') {
    return runEnsureLogin((params ?? {}) as Record<string, unknown>);
  }
  throw new Error(`Unknown host method: ${method}`);
}

/**
 * Perform a GET request (for MCP servers that run in environments without fetch, e.g. QuickJS).
 * Only allows https URLs. Optional headers (e.g. User-Agent for Nominatim) can be passed.
 */
async function runHttpGet(params: Record<string, unknown>): Promise<{ status: number; statusText: string; body: string }> {
  const url = params.url as string | undefined;
  if (!url || typeof url !== 'string') {
    throw new Error('http.get requires a "url" parameter');
  }
  if (!url.startsWith('https://')) {
    throw new Error('http.get only allows https URLs');
  }
  const headers = params.headers as Record<string, string> | undefined;
  const init: RequestInit = { method: 'GET', credentials: 'omit' };
  if (headers && typeof headers === 'object') {
    init.headers = headers;
  }
  const res = await fetch(url, init);
  const body = await res.text();
  return { status: res.status, statusText: res.statusText, body };
}
