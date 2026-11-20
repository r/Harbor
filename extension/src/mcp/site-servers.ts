/**
 * Site-registered MCP servers.
 *
 * `window.agent.mcp.register()` lets the page a person is on offer its own
 * MCP server for Harbor's agent to use — a different thing from the
 * person's own *installed* servers (`mcp/host.ts`, `storage/servers.ts`),
 * which the sidebar lists and the person manages directly. A site server:
 *
 *   - is gated by the `mcp.server.register` typed action before Harbor ever
 *     connects to it (`agents/handlers/mcp-website.ts`);
 *   - lives only in memory, keyed by the tab that registered it — never
 *     written to storage, never listed by `mcp/host.ts`'s
 *     `listMcpServers()`/`listServersWithStatus()`, so it never appears in
 *     the sidebar;
 *   - is visible and callable only to the origin and tab that registered
 *     it (`listSiteTools`/`callSiteTool` below);
 *   - is disconnected and forgotten when its tab closes or navigates to a
 *     different origin (`forgetTabServers`/`forgetTabServersIfOriginChanged`,
 *     wired from `page-api/background.ts`), or when the page calls
 *     `unregister()`. Nothing here outlives the tab.
 */

import { createRemoteTransport, type RemoteTransportKind } from './remote-transport';
import type { McpNotification, McpRequest, McpResponse } from './protocol';
import type { McpTransport } from './transport';

// =============================================================================
// Types
// =============================================================================

/** The transports a site may register. `stdio` is refused — see `registerSiteServer`. */
export type SiteMcpTransport = 'sse' | 'websocket' | 'streamable-http';

export interface SiteMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface RegisterSiteServerOptions {
  origin: string;
  tabId: number;
  url: string;
  name: string;
  description?: string;
  /** Whatever the page sent; validated here, not trusted from its declared type. */
  transport: unknown;
}

export type RegisterSiteServerResult =
  | { ok: true; serverId: string; tools: string[] }
  | { ok: false; error: string };

export interface SiteMcpServerDescriptor {
  serverId: string;
  name: string;
  url: string;
  transport: SiteMcpTransport;
}

interface SiteMcpServerEntry {
  serverId: string;
  origin: string;
  tabId: number;
  url: string;
  name: string;
  description?: string;
  transport: SiteMcpTransport;
  tools: SiteMcpTool[];
  client: McpTransport;
}

// Keyed by `${tabId}:${serverId}` — see `registryKey`.
const registry = new Map<string, SiteMcpServerEntry>();

// =============================================================================
// serverId
// =============================================================================

/**
 * A deterministic id for a site's server: `site:<host[:port]>:<name slug>`.
 * Deterministic so a tool-allowlist grant for `<serverId>/<tool>` survives
 * across visits, even though the connection itself doesn't. Two different
 * display names that slugify to the same thing collide the same way a
 * literal re-registration does (see `registerSiteServer`): the newer one
 * replaces the older under that id.
 */
export function siteServerId(origin: string, name: string): string {
  return `site:${hostPort(origin)}:${slugify(name)}`;
}

function hostPort(origin: string): string {
  try {
    const u = new URL(origin);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return 'unknown-host';
  }
}

function slugify(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'server';
}

function registryKey(tabId: number, serverId: string): string {
  return `${tabId}:${serverId}`;
}

function isSiteMcpTransport(value: unknown): value is SiteMcpTransport {
  return value === 'sse' || value === 'websocket' || value === 'streamable-http';
}

// =============================================================================
// Connect — MCP handshake (initialize, notifications/initialized, tools/list)
// =============================================================================

async function safeDisconnect(client: McpTransport): Promise<void> {
  try {
    await client.disconnect?.();
  } catch {
    // Best-effort: the connection is being torn down either way.
  }
}

/**
 * Runs the MCP handshake over a freshly created transport and returns the
 * server's real tools. The caller's declared `tools` hint (if any) is never
 * consulted — only what the server itself reports.
 */
async function handshakeAndListTools(client: McpTransport): Promise<SiteMcpTool[]> {
  const initRequest: McpRequest = {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'harbor', version: '1.0.0' },
    },
  };
  const initResponse = await client.send(initRequest);
  if (initResponse.error) {
    throw new Error(initResponse.error.message || 'MCP initialize failed');
  }

  const initializedNotification: McpNotification = {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  };
  await client.notify?.(initializedNotification);

  const toolsRequest: McpRequest = {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method: 'tools/list',
    params: {},
  };
  const toolsResponse: McpResponse = await client.send(toolsRequest);
  if (toolsResponse.error) {
    throw new Error(toolsResponse.error.message || 'MCP tools/list failed');
  }
  const result = toolsResponse.result as { tools?: SiteMcpTool[] } | undefined;
  return Array.isArray(result?.tools) ? result!.tools! : [];
}

/**
 * Connect to a site's declared MCP server, verify its tools, and register
 * it for `(origin, tabId)`. The caller (`agents/handlers/mcp-website.ts`)
 * has already run this past `requireAction('mcp.server.register', ...)`
 * and the same-origin-or-localhost URL check — this only does the
 * connection and bookkeeping. On any failure, nothing is stored and
 * whatever got connected is torn down again.
 */
export async function registerSiteServer(options: RegisterSiteServerOptions): Promise<RegisterSiteServerResult> {
  const { origin, tabId, url, name, description, transport } = options;

  if (transport === 'stdio') {
    return { ok: false, error: 'stdio is not supported for a site-registered MCP server' };
  }
  if (!isSiteMcpTransport(transport)) {
    return { ok: false, error: `Unknown MCP transport: ${String(transport)}` };
  }

  let client: McpTransport;
  try {
    // No auto-reconnect: a site server lives as long as its page, and the
    // SSE/WebSocket transports would otherwise reconnect after
    // `forgetTabServers` disconnects them, reaching the site after the person left.
    client = createRemoteTransport({ url, transport: transport as RemoteTransportKind, autoReconnect: false });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to set up the MCP transport' };
  }

  let tools: SiteMcpTool[];
  try {
    tools = await handshakeAndListTools(client);
  } catch (e) {
    await safeDisconnect(client);
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to connect to the MCP server' };
  }

  const serverId = siteServerId(origin, name);
  const key = registryKey(tabId, serverId);

  // Re-registering the same (slugified) name in the same tab replaces the
  // old connection rather than running two side by side.
  const existing = registry.get(key);
  if (existing) await safeDisconnect(existing.client);

  registry.set(key, { serverId, origin, tabId, url, name, description, transport, tools, client });

  return { ok: true, serverId, tools: tools.map((t) => t.name) };
}

/**
 * Unregister a site's server. Origin-checked the same way the old stub
 * was: only the origin that registered a `(tabId, serverId)` may remove it.
 */
export async function unregisterSiteServer(
  origin: string,
  tabId: number,
  serverId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const key = registryKey(tabId, serverId);
  const entry = registry.get(key);
  if (!entry) {
    return { ok: false, error: 'MCP server not found' };
  }
  if (entry.origin !== origin) {
    return { ok: false, error: 'Cannot unregister server from different origin' };
  }
  registry.delete(key);
  await safeDisconnect(entry.client);
  return { ok: true };
}

// =============================================================================
// Reads — scoped to the registering origin and tab
// =============================================================================

export interface SiteMcpToolListing {
  serverId: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * The tools `origin`'s page registered for itself in `tabId`. Never called
 * with no origin (the sidebar never sees site tools — see
 * `extension-api.ts`'s `handleMcpListTools`).
 */
export function listSiteTools(origin: string, tabId: number): SiteMcpToolListing[] {
  const out: SiteMcpToolListing[] = [];
  for (const entry of registry.values()) {
    if (entry.tabId !== tabId || entry.origin !== origin) continue;
    for (const tool of entry.tools) {
      out.push({ serverId: entry.serverId, name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
    }
  }
  return out;
}

/** Whether `serverId` names a site server at all (any tab/origin). Used to route `mcp.callTool`. */
export function isSiteServerId(serverId: string): boolean {
  return serverId.startsWith('site:');
}

/**
 * Call a tool on a site's server. Fails as "not found" both when the
 * server doesn't exist and when it exists but under a different
 * origin/tab, so a caller can't distinguish "wrong tab" from "never
 * registered".
 */
export async function callSiteTool(
  origin: string,
  tabId: number,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const entry = registry.get(registryKey(tabId, serverId));
  if (!entry || entry.origin !== origin) {
    return { ok: false, error: 'MCP server not found' };
  }
  if (!entry.tools.some((t) => t.name === toolName)) {
    return { ok: false, error: `Tool "${toolName}" not found on server "${serverId}"` };
  }
  try {
    const response = await entry.client.send({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    });
    if (response.error) {
      return { ok: false, error: response.error.message };
    }
    return { ok: true, result: response.result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Tool call failed' };
  }
}

/**
 * The candidate MCP servers to offer the person's own ACP agent for this
 * origin/tab's `agent.run` (`page-api/acp-backend.ts`). The caller filters
 * by the agent's own declared capabilities — this just reports what's live.
 */
export function listSiteServersForAcp(origin: string, tabId: number): SiteMcpServerDescriptor[] {
  const out: SiteMcpServerDescriptor[] = [];
  for (const entry of registry.values()) {
    if (entry.tabId !== tabId || entry.origin !== origin) continue;
    out.push({ serverId: entry.serverId, name: entry.name, url: entry.url, transport: entry.transport });
  }
  return out;
}

// =============================================================================
// Lifetime — per tab, nothing persisted
// =============================================================================

/** The tab closed, or the page registering its servers went away outright. */
export function forgetTabServers(tabId: number): void {
  for (const [key, entry] of registry) {
    if (entry.tabId !== tabId) continue;
    registry.delete(key);
    void safeDisconnect(entry.client);
  }
}

/**
 * The tab navigated. If its new URL's origin no longer matches a
 * registered server's origin, that server (and every other one this tab
 * registered — only one origin's page runs the top frame at a time) is
 * dropped. A same-document URL change (hash, `pushState`) that keeps the
 * same origin is a no-op.
 */
export function forgetTabServersIfOriginChanged(tabId: number, newUrl: string): void {
  const newOrigin = originOf(newUrl);
  for (const [key, entry] of registry) {
    if (entry.tabId !== tabId) continue;
    if (newOrigin && newOrigin === entry.origin) continue;
    registry.delete(key);
    void safeDisconnect(entry.client);
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Test-only: drop every registered server without the usual per-tab scoping. */
export function resetSiteMcpServersForTests(): void {
  for (const entry of registry.values()) {
    void safeDisconnect(entry.client);
  }
  registry.clear();
}
