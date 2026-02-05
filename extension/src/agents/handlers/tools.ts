/**
 * MCP Tools handlers.
 */

import type { ToolDescriptor } from '../types';
import type { RequestContext, ResponseSender } from './router-types';
import { log, requirePermission } from './helpers';
import { listServersWithStatus, callTool } from '../../mcp/host';
import { isToolAllowed } from '../../policy/permissions';

/**
 * Handle agent.tools.list - List available MCP tools.
 */
export async function handleToolsList(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'mcp:tools.list'))) {
    return;
  }

  try {
    const servers = await listServersWithStatus();
    const tools: ToolDescriptor[] = [];

    for (const server of servers) {
      if (server.running && server.tools) {
        for (const tool of server.tools) {
          tools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            serverId: server.id,
          });
        }
      }
    }

    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: tools,
    });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to list tools',
      },
    });
  }
}

/**
 * Handle agent.tools.call - Call an MCP tool.
 */
export async function handleToolsCall(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'mcp:tools.call'))) {
    return;
  }

  const payload = ctx.payload as { tool: string; args: Record<string, unknown> };

  // Check if tool is allowed
  const allowed = await isToolAllowed(ctx.origin, payload.tool);
  if (!allowed) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_TOOL_NOT_ALLOWED',
        message: `Tool "${payload.tool}" is not in the allowed list`,
      },
    });
    return;
  }

  try {
    // Parse tool name to get serverId
    const parts = payload.tool.split('/');
    let serverId: string;
    let toolName: string;

    if (parts.length >= 2) {
      serverId = parts[0];
      toolName = parts.slice(1).join('/');
    } else {
      // Try to find the tool in any server
      const servers = await listServersWithStatus();
      const found = servers.find(s => s.running && s.tools?.some(t => t.name === payload.tool));
      if (!found) {
        sender.sendResponse({
          id: ctx.id,
          ok: false,
          error: {
            code: 'ERR_TOOL_NOT_ALLOWED',
            message: `Tool "${payload.tool}" not found in any running server`,
          },
        });
        return;
      }
      serverId = found.id;
      toolName = payload.tool;
    }

    const result = await callTool(serverId, toolName, payload.args);
    sender.sendResponse({
      id: ctx.id,
      ok: result.ok,
      result: result.result,
      error: result.error ? { code: 'ERR_TOOL_FAILED', message: result.error } : undefined,
    });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Tool call failed',
      },
    });
  }
}
