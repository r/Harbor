/**
 * MCP Host
 * 
 * Main implementation of the MCP execution environment.
 * Provides a policy layer on top of the existing MCP client manager.
 * Manages tool discovery, invocation with permissions and rate limiting.
 */

import { log, pushStatus } from '../native-messaging.js';
import { getMcpClientManager, McpClientManager } from '../mcp/index.js';
import { getInstalledServerManager, InstalledServerManager } from '../installer/index.js';
import { getSecretStore } from '../installer/secrets.js';
import {
  ToolDescriptor,
  ToolCallResult,
  Origin,
  ProfileId,
  PermissionScope,
  ApiError,
  ErrorCode,
  createError,
  ListToolsOptions,
  CallToolOptions,
  RunAgentOptions,
  RunEvent,
  ServerState,
  ServerStatus,
  GrantType,
} from './types.js';
import { checkPermission, isToolAllowed } from './permissions.js';
import {
  registerServerTools,
  unregisterServerTools,
  listTools as registryListTools,
  resolveTool,
  getToolStats,
  clearAllTools,
  namespaceTool,
} from './tool-registry.js';
import {
  createRun,
  endRun,
  acquireCallSlot,
  getDefaultTimeout,
  createTimeoutPromise,
  getRateLimits,
} from './rate-limiter.js';
import { recordToolCall, recordRateLimitEvent } from './observability.js';
import { randomUUID } from 'node:crypto';

/**
 * Default profile ID for single-profile installations.
 */
const DEFAULT_PROFILE_ID = 'default';

/**
 * MCP Host implementation.
 */
export class McpHost {
  private mcpManager: McpClientManager;
  private installerManager: InstalledServerManager;
  private profileId: ProfileId;

  constructor(profileId: ProfileId = DEFAULT_PROFILE_ID) {
    this.mcpManager = getMcpClientManager();
    this.installerManager = getInstalledServerManager();
    this.profileId = profileId;
  }

  // ===========================================================================
  // Server & Tool Discovery
  // ===========================================================================

  /**
   * Sync tools from all connected servers.
   * Should be called after servers connect or periodically.
   */
  async syncTools(): Promise<number> {
    let totalTools = 0;

    // Get all connected servers
    const connectedIds = this.mcpManager.getConnectedServerIds();

    for (const serverId of connectedIds) {
      try {
        const connection = this.mcpManager.getConnection(serverId);
        if (!connection) continue;

        // Get the server info for the label
        const serverInfo = this.installerManager.getServer(serverId);
        const serverLabel = serverInfo?.name || serverId;

        // Get tools from the connection
        const tools = connection.tools || [];

        // Register tools in the registry
        const registered = registerServerTools(
          serverId,
          serverLabel,
          tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as object | undefined,
          }))
        );

        totalTools += registered.length;
      } catch (err) {
        log(`[Host] Failed to sync tools from ${serverId}: ${err}`);
      }
    }

    log(`[Host] Synced ${totalTools} tools from ${connectedIds.length} servers`);
    return totalTools;
  }

  /**
   * Get server status in Host format.
   */
  getServerStatus(serverId: string): ServerStatus | undefined {
    const serverInfo = this.installerManager.getServer(serverId);
    if (!serverInfo) return undefined;

    const isConnected = this.mcpManager.isConnected(serverId);
    const connection = this.mcpManager.getConnection(serverId);

    return {
      serverId,
      label: serverInfo.name,
      state: isConnected ? ServerState.RUNNING : ServerState.STOPPED,
      restartCount: 0,
      tools: connection?.tools?.map(t => ({
        name: namespaceTool(serverId, t.name),
        description: t.description,
        inputSchema: t.inputSchema as object | undefined,
        serverId,
        serverLabel: serverInfo.name,
        originalName: t.name,
      })),
    };
  }

  /**
   * Get all server statuses.
   */
  getAllServerStatuses(): ServerStatus[] {
    const servers = this.installerManager.getAllServers();
    return servers.map((server: { id: string }) => this.getServerStatus(server.id)).filter(Boolean) as ServerStatus[];
  }

  // ===========================================================================
  // Host API
  // ===========================================================================

  /**
   * List available tools.
   * Requires mcp:tools.list permission.
   */
  listTools(origin: Origin, options: ListToolsOptions = {}): { tools?: ToolDescriptor[]; error?: ApiError } {
    return registryListTools(origin, this.profileId, options);
  }

  /**
   * Call a tool.
   * Requires mcp:tools.call permission.
   */
  async callTool(
    origin: Origin,
    toolName: string,
    args: Record<string, unknown>,
    options: CallToolOptions = {}
  ): Promise<ToolCallResult> {
    const callId = randomUUID();
    const startTime = Date.now();

    // Log the call (without payload content)
    log(`[Host] Tool call ${callId}: ${toolName} from ${origin}`);

    // Check permission unless explicitly skipped (internal use)
    if (!options.skipPermissionCheck) {
      const resolveResult = resolveTool(origin, this.profileId, toolName);
      if (resolveResult.error) {
        return { ok: false, error: resolveResult.error };
      }
    }

    // Find the tool
    const toolResult = resolveTool(origin, this.profileId, toolName);
    if (!toolResult.tool) {
      return {
        ok: false,
        error: toolResult.error || createError(ErrorCode.TOOL_NOT_FOUND, `Tool "${toolName}" not found`),
      };
    }

    const tool = toolResult.tool;

    // Check rate limits
    const slotResult = acquireCallSlot(origin, options.runId);
    if (!slotResult.acquired) {
      // Record rate limit event
      recordRateLimitEvent({
        origin,
        scope: options.runId ? 'per_run' : 'per_origin',
        limitType: 'concurrent',
        current: 0,
        limit: 0,
        blocked: true,
        timestamp: Date.now(),
      });
      return { ok: false, error: slotResult.error! };
    }

    try {
      // Check server is connected
      if (!this.mcpManager.isConnected(tool.serverId)) {
        const durationMs = Date.now() - startTime;
        recordToolCall({
          toolName,
          serverId: tool.serverId,
          origin,
          durationMs,
          success: false,
          errorCode: ErrorCode.SERVER_UNAVAILABLE,
          timestamp: startTime,
        });
        return {
          ok: false,
          error: createError(
            ErrorCode.SERVER_UNAVAILABLE,
            `Server "${tool.serverLabel}" is not connected`,
            { serverId: tool.serverId }
          ),
        };
      }

      // Determine timeout
      const timeoutMs = options.timeoutMs ?? getDefaultTimeout();

      // Call the tool with timeout
      const resultPromise = this.mcpManager.callTool(tool.serverId, tool.originalName, args);
      const result = await createTimeoutPromise(resultPromise, timeoutMs, toolName);

      const durationMs = Date.now() - startTime;
      log(`[Host] Tool call ${callId} completed in ${durationMs}ms`);

      // Record success metric
      recordToolCall({
        toolName,
        serverId: tool.serverId,
        origin,
        durationMs,
        success: true,
        timestamp: startTime,
      });

      return {
        ok: true,
        result: result.content,
        provenance: {
          serverId: tool.serverId,
          toolName: tool.originalName,
        },
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      
      // Check if it's already an ApiError
      if (typeof err === 'object' && err !== null && 'code' in err) {
        const apiErr = err as ApiError;
        log(`[Host] Tool call ${callId} failed (${durationMs}ms): ${apiErr.code}`);
        
        // Record failure metric
        recordToolCall({
          toolName,
          serverId: tool.serverId,
          origin,
          durationMs,
          success: false,
          errorCode: apiErr.code,
          timestamp: startTime,
        });
        
        return { ok: false, error: apiErr };
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`[Host] Tool call ${callId} failed (${durationMs}ms): ${errorMsg}`);
      
      // Record failure metric
      recordToolCall({
        toolName,
        serverId: tool.serverId,
        origin,
        durationMs,
        success: false,
        errorCode: ErrorCode.TOOL_FAILED,
        timestamp: startTime,
      });

      return {
        ok: false,
        error: createError(ErrorCode.TOOL_FAILED, errorMsg),
      };
    } finally {
      slotResult.release();
    }
  }

  /**
   * Run an agent loop.
   * This is an optional feature for MVP.
   */
  async *runAgent(
    origin: Origin,
    task: string,
    options: RunAgentOptions = {}
  ): AsyncGenerator<RunEvent, void, unknown> {
    const runId = randomUUID();
    const startTime = Date.now();

    // Check permission
    const permCheck = checkPermission(origin, this.profileId, PermissionScope.TOOLS_CALL);
    if (!permCheck.granted) {
      yield {
        type: 'error',
        timestamp: Date.now(),
        runId,
        error: permCheck.error!,
      };
      return;
    }

    // Create run budget
    const budget = createRun(origin, options.budgets?.maxCallsPerRun);

    yield {
      type: 'status',
      timestamp: Date.now(),
      runId,
      message: `Starting agent run: ${task}`,
    };

    // Get available tools
    const toolsResult = this.listTools(origin, {});
    if (!toolsResult.tools) {
      yield {
        type: 'error',
        timestamp: Date.now(),
        runId,
        error: toolsResult.error || createError(ErrorCode.INTERNAL, 'Failed to list tools'),
      };
      endRun(runId);
      return;
    }

    let availableTools = toolsResult.tools;

    // Apply allowlist if provided
    if (options.toolAllowlist && options.toolAllowlist.length > 0) {
      const allowSet = new Set(options.toolAllowlist);
      availableTools = availableTools.filter(t => allowSet.has(t.name));
    }

    yield {
      type: 'status',
      timestamp: Date.now(),
      runId,
      message: `Found ${availableTools.length} available tools`,
    };

    // Note: In a real implementation, this would integrate with an LLM
    // to orchestrate the agent loop. For MVP, we just yield the setup events.

    yield {
      type: 'final',
      timestamp: Date.now(),
      runId,
      output: {
        message: 'Agent run completed',
        task,
        availableTools: availableTools.map(t => t.name),
      },
      stats: {
        totalCalls: budget.callsMade,
        successfulCalls: budget.callsMade, // In real impl, track this
        failedCalls: 0,
        totalDurationMs: Date.now() - startTime,
      },
    };

    endRun(runId);
  }

  // ===========================================================================
  // Utility
  // ===========================================================================

  /**
   * Get tool statistics.
   */
  getStats(): {
    servers: { total: number; running: number };
    tools: ReturnType<typeof getToolStats>;
    rateLimits: ReturnType<typeof getRateLimits>;
  } {
    const serverStatuses = this.getAllServerStatuses();
    return {
      servers: {
        total: serverStatuses.length,
        running: serverStatuses.filter(s => s.state === ServerState.RUNNING).length,
      },
      tools: getToolStats(),
      rateLimits: getRateLimits(),
    };
  }

  /**
   * Clear all cached tools.
   */
  clearTools(): void {
    clearAllTools();
    log('[Host] Cleared all tools');
  }
}

// Singleton instance
let _host: McpHost | null = null;

/**
 * Get the MCP Host singleton.
 */
export function getMcpHost(profileId?: ProfileId): McpHost {
  if (!_host) {
    _host = new McpHost(profileId);
  }
  return _host;
}
