/**
 * Tool Registry
 * 
 * Maintains a registry of tools from all connected MCP servers.
 * Tools are namespaced with serverId/toolName format.
 */

import { log } from '../native-messaging.js';
import {
  ToolDescriptor,
  ApiError,
  ErrorCode,
  createError,
  ListToolsOptions,
  Origin,
  ProfileId,
  PermissionScope,
} from './types.js';
import { checkPermission, isToolAllowed } from './permissions.js';

/**
 * Tool storage: namespaced name -> descriptor.
 */
const tools: Map<string, ToolDescriptor> = new Map();

/**
 * Server -> tool names mapping for efficient lookups.
 */
const serverTools: Map<string, Set<string>> = new Map();

/**
 * Create a namespaced tool name.
 */
export function namespaceTool(serverId: string, toolName: string): string {
  return `${serverId}/${toolName}`;
}

/**
 * Parse a namespaced tool name.
 */
export function parseNamespacedTool(name: string): { serverId: string; toolName: string } | null {
  const slashIndex = name.indexOf('/');
  if (slashIndex === -1) return null;
  return {
    serverId: name.substring(0, slashIndex),
    toolName: name.substring(slashIndex + 1),
  };
}

/**
 * Register tools from a server.
 * Replaces any existing tools from the same server.
 */
export function registerServerTools(
  serverId: string,
  serverLabel: string,
  serverTools_: { name: string; description?: string; inputSchema?: object }[]
): ToolDescriptor[] {
  // Clear existing tools for this server
  unregisterServerTools(serverId);

  const registered: ToolDescriptor[] = [];
  const toolSet = new Set<string>();

  for (const tool of serverTools_) {
    const namespacedName = namespaceTool(serverId, tool.name);

    const descriptor: ToolDescriptor = {
      name: namespacedName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      serverId,
      serverLabel,
      originalName: tool.name,
    };

    tools.set(namespacedName, descriptor);
    toolSet.add(namespacedName);
    registered.push(descriptor);
  }

  serverTools.set(serverId, toolSet);

  log(`[ToolRegistry] Registered ${registered.length} tools from server "${serverLabel}" (${serverId})`);

  return registered;
}

/**
 * Unregister all tools from a server.
 */
export function unregisterServerTools(serverId: string): number {
  const toolSet = serverTools.get(serverId);
  if (!toolSet) return 0;

  let removed = 0;
  for (const name of toolSet) {
    if (tools.delete(name)) {
      removed++;
    }
  }

  serverTools.delete(serverId);

  if (removed > 0) {
    log(`[ToolRegistry] Unregistered ${removed} tools from server ${serverId}`);
  }

  return removed;
}

/**
 * Get a tool by namespaced name.
 */
export function getTool(name: string): ToolDescriptor | undefined {
  return tools.get(name);
}

/**
 * Get all tools, optionally filtered.
 */
export function getAllTools(options: ListToolsOptions = {}): ToolDescriptor[] {
  let result = Array.from(tools.values());

  // Filter by server IDs
  if (options.serverIds && options.serverIds.length > 0) {
    const serverIdSet = new Set(options.serverIds);
    result = result.filter(t => serverIdSet.has(t.serverId));
  }

  // Filter by name pattern
  if (options.namePattern) {
    result = result.filter(t => options.namePattern!.test(t.name));
  }

  return result;
}

/**
 * List tools with permission and policy filtering.
 * This is the main entry point for the Host API.
 */
export function listTools(
  origin: Origin,
  profileId: ProfileId,
  options: ListToolsOptions = {}
): { tools?: ToolDescriptor[]; error?: ApiError } {
  // Check mcp:tools.list permission
  const permCheck = checkPermission(origin, profileId, PermissionScope.TOOLS_LIST);
  if (!permCheck.granted) {
    return { error: permCheck.error };
  }

  // Get all tools with optional filtering
  let toolList = getAllTools(options);

  // If the grant has an allowlist, filter to only allowed tools
  if (permCheck.grant?.allowedTools && permCheck.grant.allowedTools.length > 0) {
    const allowedSet = new Set(permCheck.grant.allowedTools);
    toolList = toolList.filter(t => allowedSet.has(t.name));
  }

  return { tools: toolList };
}

/**
 * Resolve a tool for invocation.
 * Validates permissions and returns the tool descriptor.
 */
export function resolveTool(
  origin: Origin,
  profileId: ProfileId,
  toolName: string
): { tool?: ToolDescriptor; error?: ApiError } {
  // Check if tool is allowed for this origin
  const allowCheck = isToolAllowed(origin, profileId, toolName);
  if (!allowCheck.allowed) {
    return { error: allowCheck.error };
  }

  // Find the tool
  const tool = getTool(toolName);
  if (!tool) {
    return {
      error: createError(
        ErrorCode.TOOL_NOT_FOUND,
        `Tool "${toolName}" not found`,
        { toolName }
      ),
    };
  }

  return { tool };
}

/**
 * Get tool count statistics.
 */
export function getToolStats(): {
  totalTools: number;
  serverCount: number;
  toolsByServer: Record<string, number>;
} {
  const toolsByServer: Record<string, number> = {};

  for (const [serverId, toolSet] of serverTools) {
    toolsByServer[serverId] = toolSet.size;
  }

  return {
    totalTools: tools.size,
    serverCount: serverTools.size,
    toolsByServer,
  };
}

/**
 * Clear all tools.
 */
export function clearAllTools(): void {
  tools.clear();
  serverTools.clear();
  log('[ToolRegistry] Cleared all tools');
}

