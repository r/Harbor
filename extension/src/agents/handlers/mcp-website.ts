/**
 * Website MCP Server Registration handlers.
 */

import type { RequestContext, ResponseSender } from './router-types';
import { log } from './helpers';
import { browserAPI } from '../../browser-compat';

// =============================================================================
// Types
// =============================================================================

interface WebsiteMcpServer {
  serverId: string;
  origin: string;
  tabId: number;
  url: string;
  name: string;
  description?: string;
  tools?: string[];
  transport: 'sse' | 'websocket' | 'streamable-http';
  connected: boolean;
  registeredAt: number;
}

// Store website-registered MCP servers (keyed by serverId)
const websiteMcpServers = new Map<string, WebsiteMcpServer>();

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
 */
export async function handleMcpRegister(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const { url, name, description, tools, transport } = ctx.payload as {
    url: string;
    name: string;
    description?: string;
    tools?: string[];
    transport?: 'sse' | 'websocket' | 'streamable-http';
  };

  if (!url || !name) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'Missing url or name' },
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
      log('MCP register rejected - cross-origin:', url, 'from', ctx.origin);
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

  // Generate a unique server ID
  const serverId = `website-${ctx.origin.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}`;

  // Create the server record
  const server: WebsiteMcpServer = {
    serverId,
    origin: ctx.origin,
    tabId: ctx.tabId || 0,
    url,
    name,
    description,
    tools,
    transport: transport || 'sse',
    connected: false,
    registeredAt: Date.now(),
  };

  // Store the server
  websiteMcpServers.set(serverId, server);
  log('MCP server registered:', serverId, url);

  // TODO: Connect to the server and verify tools
  // For now, we just register it and trust the declared tools

  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: {
      success: true,
      serverId,
    },
  });
}

/**
 * Handle agent.mcp.unregister - unregister a website's MCP server.
 */
export function handleMcpUnregister(
  ctx: RequestContext,
  sender: ResponseSender,
): void {
  const { serverId } = ctx.payload as { serverId: string };

  if (!serverId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'Missing serverId' },
    });
    return;
  }

  const server = websiteMcpServers.get(serverId);
  if (!server) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'MCP server not found' },
    });
    return;
  }

  // Verify the origin matches
  if (server.origin !== ctx.origin) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Cannot unregister server from different origin' },
    });
    return;
  }

  // Remove the server
  websiteMcpServers.delete(serverId);
  log('MCP server unregistered:', serverId);

  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: { success: true },
  });
}
