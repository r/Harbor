import {
  callMcpMethod,
  callMcpTool,
  getMcpServer,
  initializeMcpRuntime,
  listMcpServers,
  listRunningServerIds,
  registerMcpServer,
  startMcpServer,
  stopMcpServer,
  unregisterMcpServer,
} from '../wasm/runtime';
import {
  addInstalledServer,
  ensureBuiltinServers,
  removeInstalledServer,
  updateInstalledServer,
} from '../storage/servers';
import type { McpServerManifest } from '../wasm/types';

export function initializeMcpHost(): void {
  console.log('[Harbor] MCP host starting...');
  initializeMcpRuntime();
  ensureBuiltinServers().then(async (servers) => {
    // Register all servers
    servers.forEach((server) => registerMcpServer(server));
    console.log('[Harbor] MCP host ready (WASM + JS support).');
    
    // Auto-start servers that were previously running
    const autoStartServers = servers.filter(s => s.autostart);
    if (autoStartServers.length > 0) {
      console.log('[Harbor] Auto-starting', autoStartServers.length, 'servers...');
      for (const server of autoStartServers) {
        try {
          const started = await startMcpServer(server.id);
          if (started) {
            console.log('[Harbor] Auto-started:', server.id);
          } else {
            console.warn('[Harbor] Failed to auto-start:', server.id);
          }
        } catch (e) {
          console.error('[Harbor] Error auto-starting', server.id, e);
        }
      }
    }
  });
}

export async function listRegisteredServers(): Promise<McpServerManifest[]> {
  return listMcpServers().map((handle) => handle.manifest);
}

export async function listServersWithStatus(): Promise<Array<McpServerManifest & { running: boolean }>> {
  const running = new Set(listRunningServerIds());
  return listMcpServers().map((handle) => ({
    ...handle.manifest,
    running: running.has(handle.id),
  }));
}

export async function addServer(manifest: McpServerManifest): Promise<void> {
  registerMcpServer(manifest);
  await addInstalledServer(manifest);
}

export async function startServer(serverId: string): Promise<boolean> {
  const started = await startMcpServer(serverId);
  if (started) {
    // Persist autostart state
    const handle = getMcpServer(serverId);
    if (handle && !handle.manifest.autostart) {
      const updated: McpServerManifest = { ...handle.manifest, autostart: true };
      registerMcpServer(updated);
      await updateInstalledServer(updated);
    }
  }
  return started;
}

export async function validateAndStartServer(serverId: string): Promise<{ ok: boolean; tools?: McpServerManifest['tools']; error?: string }> {
  const started = await startMcpServer(serverId);
  if (!started) {
    return { ok: false, error: 'Failed to start server' };
  }
  
  try {
    const response = await callMcpMethod(serverId, 'tools/list');
    if (response.error) {
      // Stop the server if validation fails
      stopMcpServer(serverId);
      return { ok: false, error: response.error.message };
    }
    const tools = (response.result as { tools?: McpServerManifest['tools'] })?.tools || [];
    const handle = getMcpServer(serverId);
    if (handle) {
      // Update tools AND set autostart flag
      const updated: McpServerManifest = {
        ...handle.manifest,
        tools,
        autostart: true,
      };
      registerMcpServer(updated);
      await updateInstalledServer(updated);
    }
    return { ok: true, tools };
  } catch (e) {
    // Stop the server if validation throws
    stopMcpServer(serverId);
    return { ok: false, error: e instanceof Error ? e.message : 'Unknown error' };
  }
}

export async function stopServer(serverId: string): Promise<boolean> {
  const stopped = stopMcpServer(serverId);
  if (stopped) {
    // Clear autostart state
    const handle = getMcpServer(serverId);
    if (handle && handle.manifest.autostart) {
      const updated: McpServerManifest = { ...handle.manifest, autostart: false };
      registerMcpServer(updated);
      await updateInstalledServer(updated);
    }
  }
  return stopped;
}

export async function removeServer(serverId: string): Promise<void> {
  unregisterMcpServer(serverId);
  await removeInstalledServer(serverId);
}

export async function listTools(serverId: string): Promise<McpServerManifest['tools']> {
  const handle = getMcpServer(serverId);
  return handle?.manifest.tools || [];
}

/** Optional context for MCP.requestHost (browser capture). */
export type ToolCallContext = { origin?: string; tabId?: number };

export function callTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  context?: ToolCallContext,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const finalArgs = { ...args };
  if (serverId === 'time-wasm' && toolName === 'time.now' && !finalArgs.now) {
    finalArgs.now = new Date().toISOString();
  }
  return callMcpTool(serverId, toolName, finalArgs, context);
}
