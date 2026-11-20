/**
 * Website MCP Server Registration handlers.
 *
 * `register` connects to the site's declared MCP server and offers its
 * real tools to the person's agent for the registering origin/tab only —
 * see `mcp/site-servers.ts` for the registry and `extension-api.ts`'s
 * `handleMcpListTools`/`handleMcpCallTool` for where those tools surface.
 */

import type { RequestContext, ResponseSender } from './router-types';
import { log, requireAction } from './helpers';
import { browserAPI } from '../../browser-compat';
import { isSiteMcpTransport, registerSiteServer, unregisterSiteServer } from '../../mcp/site-servers';

// =============================================================================
// D1: same-origin (or matching-loopback) registration rule
// =============================================================================

/** Loopback hostnames, in every form a URL's own `.hostname` can take them. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

/** A server URL's origin, with its scheme mapped for comparison: ws(s) counts as http(s). */
function effectiveServerOrigin(url: URL): string {
  if (url.protocol === 'ws:') return `http://${url.host}`;
  if (url.protocol === 'wss:') return `https://${url.host}`;
  return url.origin;
}

/**
 * Whether a page at `pageOrigin` may register `serverUrl` — a maintainer
 * decision (HBR-134, D1): same-origin only, except a loopback server
 * (localhost/127.0.0.1/::1), which is allowed only when the *page itself*
 * is also loopback (so an ordinary site can't point Harbor at "localhost"
 * and reach whatever's listening on the person's own machine). A
 * same-origin `ws(s)://` URL for `transport: 'websocket'` counts as
 * same-origin via the scheme mapping above.
 */
function isAllowedServerUrl(pageOrigin: URL, serverUrl: URL): boolean {
  if (isLoopbackHost(serverUrl.hostname)) {
    return isLoopbackHost(pageOrigin.hostname);
  }
  return effectiveServerOrigin(serverUrl) === pageOrigin.origin;
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * Handle agent.mcp.discover - find MCP servers declared on the current page.
 */
export async function handleMcpDiscover(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const { tabId } = ctx;

  if (!tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'No tab context for discovery' },
    });
    return;
  }

  try {
    // Execute script in the tab to find <link rel="mcp-server"> elements
    const results = await browserAPI.scripting.executeScript({
      target: { tabId },
      func: () => {
        const links = document.querySelectorAll('link[rel="mcp-server"]');
        return Array.from(links).map((link) => ({
          url: link.getAttribute('href') || '',
          name: link.getAttribute('title') || undefined,
          description: link.getAttribute('data-description') || undefined,
          tools: link.getAttribute('data-tools')?.split(',').map(t => t.trim()) || undefined,
          transport: link.getAttribute('data-transport') || 'sse',
        }));
      },
    });

    const servers = results?.[0]?.result || [];
    log('MCP discover found servers:', servers.length);

    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: { servers },
    });
  } catch (err) {
    log('MCP discover error:', err);
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: err instanceof Error ? err.message : 'Discovery failed' },
    });
  }
}

/**
 * Handle agent.mcp.register - register a website's MCP server.
 *
 * Every check that can fail on its own (missing fields, no tab context,
 * an unrecognized transport, the same-origin/loopback rule) runs *before*
 * `mcp.server.register`'s own gate, so the person is never asked to allow
 * a registration that was always going to be refused. The policy gate
 * itself still runs before any network connection: only once it's
 * granted does this run the MCP handshake over the requested transport
 * (`mcp/site-servers.ts`).
 */
export async function handleMcpRegister(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const { url, name, description, transport: rawTransport } = ctx.payload as {
    url: string;
    name: string;
    description?: string;
    tools?: string[];
    transport?: unknown;
  };

  if (!url || !name) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'Missing url or name' },
    });
    return;
  }

  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'No tab context for registration' },
    });
    return;
  }

  // H2: an omitted transport defaults to sse.
  const transport = rawTransport ?? 'sse';

  if (transport === 'stdio') {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'stdio is not supported for a site-registered MCP server' },
    });
    return;
  }
  if (!isSiteMcpTransport(transport)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: `Unknown MCP transport: ${String(transport)}` },
    });
    return;
  }

  let serverUrl: URL;
  let pageOriginUrl: URL;
  try {
    serverUrl = new URL(url);
    pageOriginUrl = new URL(ctx.origin);
  } catch {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'Invalid MCP server URL' },
    });
    return;
  }

  // D1: same-origin only, except a loopback server registered from a
  // loopback page.
  if (!isAllowedServerUrl(pageOriginUrl, serverUrl)) {
    log('MCP register rejected - server URL not allowed from', ctx.origin);
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'MCP server must be on the same origin, or localhost/127.0.0.1/::1 registered from a page on the same' },
    });
    return;
  }

  // The policy gate: only now does this ask the person, and only once
  // granted does anything below reach the network.
  if (!(await requireAction(ctx, sender, 'mcp.server.register', { promptAsScope: 'mcp:servers.register' }))) {
    return;
  }

  const result = await registerSiteServer({
    origin: ctx.origin,
    tabId: ctx.tabId,
    url,
    name,
    description,
    transport,
    signal: ctx.signal,
  });

  if (!result.ok) {
    log('MCP server registration failed:', result.error);
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: result.aborted ? 'ERR_ABORTED' : 'ERR_INTERNAL', message: result.error },
    });
    return;
  }

  log('MCP server registered:', result.serverId, 'tools:', result.tools);

  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: {
      success: true,
      serverId: result.serverId,
      tools: result.tools,
    },
  });
}

/**
 * Handle agent.mcp.unregister - unregister a website's MCP server.
 */
export async function handleMcpUnregister(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const { serverId } = ctx.payload as { serverId: string };

  if (!serverId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'Missing serverId' },
    });
    return;
  }

  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'No tab context for unregistration' },
    });
    return;
  }

  const result = await unregisterSiteServer(ctx.origin, ctx.tabId, serverId);
  if (!result.ok) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: result.error === 'MCP server not found' ? 'ERR_INTERNAL' : 'ERR_PERMISSION_DENIED',
        message: result.error,
      },
    });
    return;
  }

  log('MCP server unregistered:', serverId);

  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: { success: true },
  });
}
