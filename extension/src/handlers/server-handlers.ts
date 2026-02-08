/**
 * MCP Server Handlers
 * 
 * Handlers for MCP server management (sidebar UI).
 */

import { registerAsyncHandler, registerHandler, errorResponse } from './types';
import {
  addServer,
  startServer,
  stopServer,
  validateAndStartServer,
  removeServer,
  listServersWithStatus,
  callTool,
} from '../mcp/host';
import { getBridgeConnectionState } from '../llm/bridge-client';
import { getServerSecrets, setServerSecrets } from '../storage/server-secrets';

export function registerServerHandlers(): void {
  // List all servers with status (include bridgeConnected so sidebar can show Stub for JS servers)
  registerAsyncHandler('sidebar_get_servers', async () => {
    const servers = await listServersWithStatus();
    const { connected: bridgeConnected } = getBridgeConnectionState();
    return { ok: true, servers, bridgeConnected };
  });

  // Start a server
  registerHandler('sidebar_start_server', (message, _sender, sendResponse) => {
    const serverId = message.serverId as string | undefined;
    if (!serverId) {
      sendResponse({ ok: false, error: 'Missing serverId' });
      return true;
    }
    startServer(serverId)
      .then((started) => sendResponse({ ok: started }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });

  // Stop a server
  registerHandler('sidebar_stop_server', (message, _sender, sendResponse) => {
    const serverId = message.serverId as string | undefined;
    if (!serverId) {
      sendResponse({ ok: false, error: 'Missing serverId' });
      return true;
    }
    stopServer(serverId)
      .then((stopped) => sendResponse({ ok: stopped }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });

  // Install a server
  registerHandler('sidebar_install_server', (message, _sender, sendResponse) => {
    const manifest = message.manifest as { id?: string };
    if (!manifest?.id) {
      sendResponse({ ok: false, error: 'Missing manifest id' });
      return true;
    }
    addServer(message.manifest as Parameters<typeof addServer>[0])
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });

  // Validate and start a server
  registerHandler('sidebar_validate_server', (message, _sender, sendResponse) => {
    const serverId = message.serverId as string | undefined;
    if (!serverId) {
      sendResponse({ ok: false, error: 'Missing serverId' });
      return true;
    }
    validateAndStartServer(serverId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });

  // Get stored secrets for a server (for Configure UI)
  registerAsyncHandler('sidebar_get_server_secrets', async (message) => {
    const serverId = message.serverId as string | undefined;
    if (!serverId) return { ok: false, error: 'Missing serverId' };
    const secrets = await getServerSecrets(serverId);
    return { ok: true, secrets };
  });

  // Save secrets for a server
  registerAsyncHandler('sidebar_set_server_secrets', async (message) => {
    const serverId = message.serverId as string | undefined;
    const secrets = message.secrets as Record<string, string> | undefined;
    if (!serverId) return { ok: false, error: 'Missing serverId' };
    if (!secrets || typeof secrets !== 'object') return { ok: false, error: 'Missing secrets object' };
    await setServerSecrets(serverId, secrets);
    return { ok: true };
  });

  // Remove a server
  registerHandler('sidebar_remove_server', (message, _sender, sendResponse) => {
    const serverId = message.serverId as string | undefined;
    if (!serverId) {
      sendResponse({ ok: false, error: 'Missing serverId' });
      return true;
    }
    removeServer(serverId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });

  // Call a tool (pass harbor-extension context so host_request has an origin for browser capture)
  registerHandler('sidebar_call_tool', (message, _sender, sendResponse) => {
    const { serverId, toolName, args } = message as {
      serverId?: string;
      toolName?: string;
      args?: Record<string, unknown>;
    };
    console.log('[Harbor] sidebar_call_tool:', serverId, toolName, args);
    if (!serverId || !toolName) {
      sendResponse({ ok: false, error: 'Missing serverId or toolName' });
      return true;
    }
    const context = { origin: 'harbor-extension' as const };
    callTool(serverId, toolName, args || {}, context)
      .then((result) => {
        console.log('[Harbor] Tool result:', result);
        sendResponse(result as { ok: boolean });
      })
      .catch((error) => {
        console.error('[Harbor] Tool error:', error);
        sendResponse(errorResponse(error));
      });
    return true;
  });

  // Call MCP method directly
  registerHandler('mcp_call_method', (message, _sender, sendResponse) => {
    const { serverId, method, params } = message as {
      serverId?: string;
      method?: string;
      params?: Record<string, unknown>;
    };
    console.log('[Harbor] mcp_call_method:', serverId, method, params);
    if (!serverId || !method) {
      sendResponse({ ok: false, error: 'Missing serverId or method' });
      return true;
    }
    (async () => {
      const { callMcpMethod } = await import('../wasm/runtime');
      const result = await callMcpMethod(serverId, method, params);
      console.log('[Harbor] MCP method result:', result);
      if (result.error) {
        sendResponse({ ok: false, error: result.error.message });
      } else {
        sendResponse({ ok: true, result: result.result });
      }
    })().catch((error) => sendResponse(errorResponse(error)));
    return true;
  });
}
