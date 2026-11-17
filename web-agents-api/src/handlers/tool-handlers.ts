/**
 * Tool Handlers
 * 
 * Handles tool listing and execution.
 */

import { harborRequest } from '../harbor-client';
import type { RequestContext, HandlerResponse } from './types';
import { errorResponse, successResponse } from './types';
import { hasPermission, getPermissions } from './permission-handlers';

// =============================================================================
// Handlers
// =============================================================================

export async function handleToolsList(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'mcp:tools.list', ctx.tabId)) {
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Permission mcp:tools.list required');
  }

  try {
    const result = await harborRequest<{ tools: unknown[] }>('mcp.listTools', {
      origin: ctx.origin,
      tabId: ctx.tabId,
    });
    return successResponse(ctx.id, result.tools);
  } catch (e) {
    return errorResponse(
      ctx.id,
      'ERR_INTERNAL',
      e instanceof Error ? e.message : 'Failed to list tools'
    );
  }
}

export async function handleToolsCall(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'mcp:tools.call', ctx.tabId)) {
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Permission mcp:tools.call required');
  }

  const { tool, args } = ctx.payload as { tool: string; args?: Record<string, unknown> };
  
  // Check tool allowlist. A site with no allowlist may call no tools.
  const permissions = await getPermissions(ctx.origin, ctx.tabId);
  if (typeof tool !== 'string' || !permissions.allowedTools.includes(tool)) {
    return errorResponse(ctx.id, 'ERR_TOOL_NOT_ALLOWED', `Tool ${tool} not in allowlist`);
  }

  // Parse tool name (may be "serverId/toolName" or just "toolName")
  let serverId: string;
  let toolName: string;
  
  if (tool.includes('/')) {
    [serverId, toolName] = tool.split('/', 2);
  } else {
    // Need to find which server has this tool
    const toolsResult = await harborRequest<{ tools: Array<{ serverId: string; name: string }> }>('mcp.listTools', {
      origin: ctx.origin,
      tabId: ctx.tabId,
    });
    const found = toolsResult.tools.find(t => t.name === tool);
    if (!found) {
      return errorResponse(ctx.id, 'ERR_TOOL_NOT_FOUND', `Tool ${tool} not found`);
    }
    serverId = found.serverId;
    toolName = tool;
  }

  try {
    const result = await harborRequest<{ result: unknown }>('mcp.callTool', {
      origin: ctx.origin,
      tabId: ctx.tabId,
      serverId,
      toolName,
      args: args || {},
    });
    return successResponse(ctx.id, result.result);
  } catch (e) {
    return errorResponse(
      ctx.id,
      'ERR_TOOL_FAILED',
      e instanceof Error ? e.message : 'Tool call failed'
    );
  }
}
