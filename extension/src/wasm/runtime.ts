import type { McpServerHandle, McpServerManifest } from './types';
import type { McpResponse, ToolCallParams } from '../mcp/protocol';
import type { McpTransport } from '../mcp/transport';
import { McpStdioTransport } from '../mcp/stdio-transport';
import { createWasmSession } from './session';
import { createJsSession } from '../js-runtime/session';
import { createRemoteTransport, type McpSseTransport, type McpWebSocketTransport } from '../mcp/remote-transport';
import { rpcRequest, isNativeBridgeReady } from '../llm/native-bridge';
import { isSafari } from '../browser-compat';

type ToolEntry = {
  serverId: string;
  name: string;
};

const runningServers = new Map<string, McpServerHandle>();
const toolIndex = new Map<string, ToolEntry>();
const activeSessions = new Map<string, { transport: McpTransport; close: () => void }>();
// Track remote transports separately for connection status
const remoteTransports = new Map<string, McpSseTransport | McpWebSocketTransport>();

/**
 * Initialize the MCP runtime (both WASM and JS).
 */
export function initializeMcpRuntime(): void {
  console.log('[Harbor] MCP runtime initialized (WASM + JS support)');
}

/** @deprecated Use initializeMcpRuntime instead */
export const initializeWasmRuntime = initializeMcpRuntime;

/**
 * Register an MCP server (WASM or JS).
 */
export function registerMcpServer(manifest: McpServerManifest): McpServerHandle {
  const existing = runningServers.get(manifest.id);
  if (existing) {
    (existing.manifest.tools || []).forEach((tool) => {
      toolIndex.delete(`${manifest.id}:${tool.name}`);
    });
  }
  const handle: McpServerHandle = { id: manifest.id, manifest };
  runningServers.set(handle.id, handle);
  (manifest.tools || []).forEach((tool) => {
    const key = `${manifest.id}:${tool.name}`;
    toolIndex.set(key, { serverId: manifest.id, name: tool.name });
  });
  return handle;
}

/** @deprecated Use registerMcpServer instead */
export const registerWasmServer = registerMcpServer;

/**
 * List all registered MCP servers.
 */
export function listMcpServers(): McpServerHandle[] {
  return Array.from(runningServers.values());
}

/** @deprecated Use listMcpServers instead */
export const listWasmServers = listMcpServers;

/**
 * Get a registered MCP server by ID.
 */
export function getMcpServer(serverId: string): McpServerHandle | undefined {
  return runningServers.get(serverId);
}

/** @deprecated Use getMcpServer instead */
export const getWasmServer = getMcpServer;

/**
 * List IDs of all currently running servers.
 */
export function listRunningServerIds(): string[] {
  return Array.from(activeSessions.keys());
}

/**
 * Unregister an MCP server.
 */
export function unregisterMcpServer(serverId: string): void {
  const existing = runningServers.get(serverId);
  if (existing) {
    (existing.manifest.tools || []).forEach((tool) => {
      toolIndex.delete(`${serverId}:${tool.name}`);
    });
  }
  runningServers.delete(serverId);
  const session = activeSessions.get(serverId);
  session?.close();
  activeSessions.delete(serverId);
}

/** @deprecated Use unregisterMcpServer instead */
export const unregisterWasmServer = unregisterMcpServer;

/**
 * Determine the runtime type for a manifest.
 * Defaults to 'wasm' for backward compatibility.
 */
function getServerRuntime(manifest: McpServerManifest): 'wasm' | 'js' | 'remote' {
  if (manifest.runtime) {
    return manifest.runtime;
  }
  // Infer from available fields
  if (manifest.remoteUrl) {
    return 'remote';
  }
  if (manifest.scriptUrl || manifest.scriptBase64) {
    return 'js';
  }
  return 'wasm';
}

/**
 * Start an MCP server (WASM, JS, or Remote).
 * Dispatches to the appropriate runtime based on manifest.runtime.
 */
export async function startMcpServer(serverId: string): Promise<boolean> {
  const handle = runningServers.get(serverId);
  if (!handle) {
    return false;
  }
  if (activeSessions.has(serverId)) {
    return true;
  }

  const runtime = getServerRuntime(handle.manifest);

  try {
    if (runtime === 'remote') {
      // Create remote transport (SSE or WebSocket)
      if (!handle.manifest.remoteUrl) {
        throw new Error('Remote server missing remoteUrl');
      }
      const transport = createRemoteTransport({
        url: handle.manifest.remoteUrl,
        transport: handle.manifest.remoteTransport || 'sse',
        authHeader: handle.manifest.remoteAuthHeader,
      });
      await transport.connect();
      remoteTransports.set(serverId, transport);
      activeSessions.set(serverId, {
        transport,
        close: () => transport.disconnect(),
      });
      console.log('[Harbor] Connected to remote MCP server:', serverId);
    } else if (runtime === 'js') {
      // Create JS worker session (getCurrentRequestContext used for MCP.requestHost)
      const session = await createJsSession(
        { ...handle.manifest, runtime: 'js' },
        getCurrentRequestContext,
      );
      activeSessions.set(serverId, {
        transport: new McpStdioTransport(session.endpoint),
        close: session.close,
      });
      console.log('[Harbor] Started JS MCP server:', serverId);
    } else {
      // Create WASM session (existing path)
      const session = await createWasmSession(handle.manifest);
      activeSessions.set(serverId, {
        transport: new McpStdioTransport(session.endpoint),
        close: session.close,
      });
      console.log('[Harbor] Started WASM MCP server:', serverId);
    }
    
    // Safari: Sync tools to bridge for Web Agents compatibility
    await syncToolsToBridge(serverId, handle.manifest);
    
    return true;
  } catch (error) {
    console.error(`[Harbor] Failed to start ${runtime} MCP server:`, error);
    return false;
  }
}

/**
 * Safari: Sync server tools to the bridge for Web Agents compatibility.
 * In Safari, Web Agents can only communicate with the bridge, not Harbor directly.
 */
async function syncToolsToBridge(serverId: string, manifest: McpServerManifest): Promise<void> {
  // Only sync if bridge is ready and we're in Safari
  if (!isNativeBridgeReady()) {
    return;
  }
  
  const tools = manifest.tools || [];
  if (tools.length === 0) {
    return;
  }
  
  try {
    await rpcRequest('mcp.register_tools', {
      server_id: serverId,
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
    console.log(`[Harbor] Synced ${tools.length} tools to bridge for ${serverId}`);
  } catch (err) {
    // Non-fatal - just log and continue
    console.warn('[Harbor] Failed to sync tools to bridge:', err);
  }
}

/** @deprecated Use startMcpServer instead */
export const startWasmServer = startMcpServer;

/**
 * Stop an MCP server.
 */
export function stopMcpServer(serverId: string): boolean {
  if (!runningServers.has(serverId)) {
    return false;
  }
  const session = activeSessions.get(serverId);
  session?.close();
  activeSessions.delete(serverId);
  remoteTransports.delete(serverId);
  
  // Safari: Unregister tools from bridge
  unsyncToolsFromBridge(serverId);
  
  console.log('[Harbor] Stopped MCP server:', serverId);
  return true;
}

/**
 * Safari: Unregister server tools from the bridge.
 */
function unsyncToolsFromBridge(serverId: string): void {
  if (!isNativeBridgeReady()) {
    return;
  }
  
  rpcRequest('mcp.unregister_tools', { server_id: serverId })
    .then(() => console.log(`[Harbor] Unsynced tools from bridge for ${serverId}`))
    .catch(() => { /* ignore errors */ });
}

/**
 * Get the connection status of a remote server.
 */
export function getRemoteServerStatus(serverId: string): 'disconnected' | 'connecting' | 'connected' | 'error' {
  const transport = remoteTransports.get(serverId);
  if (!transport) {
    return 'disconnected';
  }
  return transport.getState();
}

/**
 * Check if a server is a remote server.
 */
export function isRemoteServer(serverId: string): boolean {
  const handle = runningServers.get(serverId);
  if (!handle) {
    return false;
  }
  return getServerRuntime(handle.manifest) === 'remote';
}

/** @deprecated Use stopMcpServer instead */
export const stopWasmServer = stopMcpServer;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('MCP request timed out'));
    }, timeoutMs);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export async function callMcpMethod(
  serverId: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<McpResponse> {
  const handle = runningServers.get(serverId);
  if (!handle) {
    return {
      jsonrpc: '2.0',
      id: 'missing',
      error: { code: -32000, message: 'Server not found' },
    };
  }
  const session = activeSessions.get(serverId);
  if (!session) {
    return {
      jsonrpc: '2.0',
      id: 'missing',
      error: { code: -32000, message: 'Server not started' },
    };
  }
  const requestId = crypto.randomUUID();
  const request = {
    jsonrpc: '2.0' as const,
    id: requestId,
    method,
    params,
  };
  try {
    return await withTimeout(session.transport.send(request), 10_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      jsonrpc: '2.0',
      id: requestId,
      error: { code: -32001, message },
    };
  }
}

/** Current request context (origin, tabId) for host requests; set during tool call. */
let currentRequestContext: { origin?: string; tabId?: number } | undefined;

export function getCurrentRequestContext(): { origin?: string; tabId?: number } | undefined {
  return currentRequestContext;
}

/**
 * Call a tool on an MCP server.
 * @param context - Optional context (origin, tabId) for MCP.requestHost (browser capture).
 */
export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  context?: { origin?: string; tabId?: number },
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const handle = runningServers.get(serverId);
  if (!handle) {
    return { ok: false, error: 'Server not found' };
  }
  const key = `${serverId}:${toolName}`;
  if (!toolIndex.has(key)) {
    return { ok: false, error: `Tool not found: ${toolName}` };
  }
  const session = activeSessions.get(serverId);
  if (!session) {
    return { ok: false, error: 'Server not started' };
  }

  const requestId = crypto.randomUUID();
  const params: ToolCallParams = { name: toolName, arguments: args };
  const request = {
    jsonrpc: '2.0' as const,
    id: requestId,
    method: 'tools/call',
    params,
  };

  const prevContext = currentRequestContext;
  currentRequestContext = context;
  try {
    // Tool can do browser capture (scroll + DOM extract); allow up to 90s
    const response = await withTimeout(
      session.transport.send(request),
      90_000,
    );
    if (response.error) {
      return { ok: false, error: response.error.message };
    }
    return {
      ok: true,
      result: response.result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  } finally {
    currentRequestContext = prevContext;
  }
}

/** @deprecated Use callMcpTool instead */
export const callWasmTool = callMcpTool;
