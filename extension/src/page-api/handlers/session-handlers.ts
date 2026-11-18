/**
 * Session Handlers
 * 
 * Handles explicit sessions via Harbor.
 */

import { harborRequest } from '../harbor-core';
import type { PermissionScope, CreateSessionOptions, SessionSummary } from '../types';
import type { RequestContext, HandlerResponse } from './types';
import { errorResponse, successResponse } from './types';
import { hasPermission, getPermissions } from './permission-handlers';
import { registerExplicitTextSession, forgetExplicitTextSession } from './ai-handlers';

// =============================================================================
// Handlers
// =============================================================================

/**
 * Create an explicit session with specified capabilities.
 * This proxies to Harbor's session.create endpoint.
 */
export async function handleSessionsCreate(ctx: RequestContext): HandlerResponse {
  const options = ctx.payload as CreateSessionOptions;
  
  if (!options || !options.capabilities) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing capabilities in session options');
  }

  // Check required permissions based on requested capabilities
  const requiredScopes: PermissionScope[] = [];
  if (options.capabilities.llm) {
    requiredScopes.push('model:prompt');
  }
  if (options.capabilities.tools && options.capabilities.tools.length > 0) {
    requiredScopes.push('mcp:tools.call');
  }

  // Check permissions
  for (const scope of requiredScopes) {
    if (!await hasPermission(ctx.origin, scope, ctx.tabId)) {
      return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', `Permission ${scope} required`);
    }
  }

  // Get allowed tools for this origin
  const permissions = await getPermissions(ctx.origin, ctx.tabId);
  const allowedTools = permissions.allowedTools || [];

  try {
    const result = await harborRequest<{
      sessionId: string;
      capabilities: unknown;
    }>('session.create', {
      origin: ctx.origin,
      tabId: ctx.tabId,
      options,
      allowedTools,
    });

    if (!result.sessionId) {
      return errorResponse(ctx.id, 'ERR_INTERNAL', 'Harbor did not create a session');
    }

    registerExplicitTextSession(result.sessionId, ctx.origin, {
      systemPrompt: options.options?.systemPrompt,
      temperature: options.options?.temperature,
      model: options.capabilities.llm?.model,
    });

    return successResponse(ctx.id, {
      success: true,
      sessionId: result.sessionId,
      capabilities: result.capabilities,
    });
  } catch (e) {
    return errorResponse(
      ctx.id,
      'ERR_INTERNAL',
      e instanceof Error ? e.message : 'Session creation failed'
    );
  }
}

/**
 * Get a session by ID.
 */
export async function handleSessionsGet(ctx: RequestContext): HandlerResponse {
  const { sessionId } = ctx.payload as { sessionId: string };

  if (!sessionId) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing sessionId');
  }

  try {
    const result = await harborRequest<{ session: SessionSummary | null }>('session.get', {
      sessionId,
      origin: ctx.origin,
    });

    return successResponse(ctx.id, result.session);
  } catch (e) {
    return errorResponse(
      ctx.id,
      'ERR_SESSION_NOT_FOUND',
      e instanceof Error ? e.message : 'Session not found'
    );
  }
}

/**
 * List sessions for the requesting origin.
 */
export async function handleSessionsList(ctx: RequestContext): HandlerResponse {
  try {
    const result = await harborRequest<{ sessions: SessionSummary[] }>('session.list', {
      origin: ctx.origin,
      activeOnly: true,
    });

    return successResponse(ctx.id, result.sessions);
  } catch (e) {
    return errorResponse(
      ctx.id,
      'ERR_INTERNAL',
      e instanceof Error ? e.message : 'Failed to list sessions'
    );
  }
}

/**
 * Terminate a session.
 */
export async function handleSessionsTerminate(ctx: RequestContext): HandlerResponse {
  const { sessionId } = ctx.payload as { sessionId: string };

  if (!sessionId) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing sessionId');
  }

  try {
    const result = await harborRequest<{ terminated: boolean }>('session.terminate', {
      sessionId,
      origin: ctx.origin,
    });
    if (result.terminated) forgetExplicitTextSession(sessionId, ctx.origin);

    return successResponse(ctx.id, { terminated: result.terminated });
  } catch (e) {
    return errorResponse(
      ctx.id,
      'ERR_SESSION_NOT_FOUND',
      e instanceof Error ? e.message : 'Session not found'
    );
  }
}
