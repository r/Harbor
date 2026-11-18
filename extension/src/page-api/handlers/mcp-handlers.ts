/**
 * MCP Server Handlers
 * 
 * Handles MCP server discovery, registration, and unregistration.
 */

import { harborRequest } from '../harbor-client';
import type { RequestContext, HandlerResponse } from './types';
import { errorResponse, successResponse } from './types';

// =============================================================================
// Handlers
// =============================================================================

export async function handleMcpDiscover(ctx: RequestContext): HandlerResponse {
  try {
    const result = await harborRequest<{
      servers: Array<{
        url: string;
        name?: string;
        description?: string;
        tools?: string[];
        transport?: string;
      }>;
    }>('agent.mcp.discover', { origin: ctx.origin });
    return successResponse(ctx.id, result.servers || []);
  } catch (e) {
    return errorResponse(
      ctx.id,
      'ERR_MCP_DISCOVER',
      e instanceof Error ? e.message : 'Failed to discover MCP servers'
    );
  }
}

export async function handleMcpRegister(ctx: RequestContext): HandlerResponse {
  const { url, name, description, tools, transport } = ctx.payload as {
    url: string;
    name: string;
    description?: string;
    tools?: string[];
    transport?: 'sse' | 'stdio' | 'streamable-http';
  };

  if (!url || !name) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing url or name');
  }

  try {
    const result = await harborRequest<{
      success: boolean;
      serverId?: string;
      error?: { code: string; message: string };
    }>('agent.mcp.register', {
      origin: ctx.origin,
      url,
      name,
      description,
      tools,
      transport,
    });
    return successResponse(ctx.id, result);
  } catch (e) {
    return errorResponse(
      ctx.id,
      'ERR_MCP_REGISTER',
      e instanceof Error ? e.message : 'Failed to register MCP server'
    );
  }
}

export async function handleMcpUnregister(ctx: RequestContext): HandlerResponse {
  const { serverId } = ctx.payload as { serverId: string };

  if (!serverId) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing serverId');
  }

  try {
    const result = await harborRequest<{ success: boolean }>('agent.mcp.unregister', {
      origin: ctx.origin,
      serverId,
    });
    return successResponse(ctx.id, result);
  } catch (e) {
    return errorResponse(
      ctx.id,
      'ERR_MCP_UNREGISTER',
      e instanceof Error ? e.message : 'Failed to unregister MCP server'
    );
  }
}
