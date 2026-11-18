/**
 * Tool Handlers
 * 
 * Handles tool listing and execution.
 */

import { harborRequest } from '../harbor-core';
import type { RequestContext, HandlerResponse } from './types';
import { errorResponse, successResponse } from './types';
import { hasPermission, getPermissions } from './permission-handlers';
import { ErrorCodes } from '../types';

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

  const { tool, args, sessionId } = ctx.payload as {
    tool: string;
    args?: Record<string, unknown>;
    sessionId?: unknown;
  };
  if (sessionId !== undefined && typeof sessionId !== 'string') {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'sessionId must be a string');
  }

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

  // A call made through a session counts against that session's tool budget.
  // Harbor's registry checks that the session is alive and belongs to this
  // origin, and refuses once `limits.maxToolCalls` is spent. Recording before
  // the call means a refused call never runs.
  if (sessionId !== undefined) {
    const refusal = await recordSessionToolCall(ctx.origin, sessionId, tool);
    if (refusal) return errorResponse(ctx.id, refusal.code, refusal.message);
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

// =============================================================================
// Session tool budget
// =============================================================================

/** Harbor's refusal when a session's `limits.maxToolCalls` is spent. */
const BUDGET_EXCEEDED_MESSAGE = 'Tool call budget exceeded';

/**
 * Count one tool call against a session's budget. Returns the error to send
 * the page if Harbor refuses it, or null if the call may run.
 */
async function recordSessionToolCall(
  origin: string,
  sessionId: string,
  toolName: string,
): Promise<{ code: string; message: string } | null> {
  try {
    await harborRequest('session.recordUsage', { sessionId, origin, type: 'tool', detail: { toolName } });
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message === BUDGET_EXCEEDED_MESSAGE) {
      return { code: ErrorCodes.BUDGET_EXCEEDED, message: 'Session tool call budget exceeded' };
    }
    // Not found, terminated, expired, or another origin's session.
    return { code: ErrorCodes.SESSION_NOT_FOUND, message: 'Session not found' };
  }
}
