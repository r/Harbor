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
import { HARBOR_SESSION_GONE } from './ai-handlers';

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
  // Harbor checks that the session is alive and belongs to this origin, and
  // counts the call only once its policy gate allows it, so a call the policy
  // engine refuses doesn't spend the budget. A call past the budget never runs.
  try {
    const result = await harborRequest<{ result: unknown }>('mcp.callTool', {
      origin: ctx.origin,
      tabId: ctx.tabId,
      serverId,
      toolName,
      args: args || {},
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
    return successResponse(ctx.id, result.result);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Tool call failed';
    if (sessionId !== undefined) {
      if (message === BUDGET_EXCEEDED_MESSAGE) {
        return errorResponse(ctx.id, ErrorCodes.BUDGET_EXCEEDED, 'Session tool call budget exceeded');
      }
      // Not found, terminated, expired, or another origin's session: all look
      // the same to the page.
      if (HARBOR_SESSION_GONE.test(message)) {
        return errorResponse(ctx.id, ErrorCodes.SESSION_NOT_FOUND, 'Session not found');
      }
    }
    return errorResponse(ctx.id, 'ERR_TOOL_FAILED', message);
  }
}

// =============================================================================
// Session tool budget
// =============================================================================

/** Harbor's refusal when a session's `limits.maxToolCalls` is spent. */
const BUDGET_EXCEEDED_MESSAGE = 'Tool call budget exceeded';

