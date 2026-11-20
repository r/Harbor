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
import { registerSiteServer, unregisterSiteServer } from '../../mcp/site-servers';

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
 * Gated by `mcp.server.register` (asks by default, remembered per origin
 * like any other scope) *before* Harbor ever connects to the site's
 * server. Only once that's granted does this validate the URL and run the
 * MCP handshake over the requested transport (`mcp/site-servers.ts`).
 */
export async function handleMcpRegister(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requireAction(ctx, sender, 'mcp.server.register', { promptAsScope: 'mcp:servers.register' }))) {
    return;
  }

  const { url, name, description, transport } = ctx.payload as {
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

  // Validate URL is allowed (must be from same origin or explicitly permitted)
  try {
    const serverUrl = new URL(url);
    const originUrl = new URL(ctx.origin);

    // For now, allow localhost and same-origin servers
    const isLocalhost = serverUrl.hostname === 'localhost' || serverUrl.hostname === '127.0.0.1';
    const isSameOrigin = serverUrl.origin === originUrl.origin;

    if (!isLocalhost && !isSameOrigin) {
      log('MCP register rejected - cross-origin server from', ctx.origin);
      sender.sendResponse({
        id: ctx.id,
        ok: false,
        error: { code: 'ERR_PERMISSION_DENIED', message: 'MCP server must be on localhost or same origin' },
      });
      return;
    }
  } catch {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'Invalid MCP server URL' },
    });
    return;
  }

  const result = await registerSiteServer({
    origin: ctx.origin,
    tabId: ctx.tabId,
    url,
    name,
    description,
    transport,
  });

  if (!result.ok) {
    log('MCP server registration failed:', result.error);
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: result.error },
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
