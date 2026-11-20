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
import { readAgentBackendSetting } from '../agent-backend-setting';
import { isAcpTextSession } from '../acp-text-session-registry';

// Loaded lazily for the same reason ai-handlers.ts gives: this file is part
// of the handlers/ barrel, and acp-text-session.ts pulls in a runtime
// listener as soon as it's imported.
async function loadAcpTextSession() {
  return import('../acp-text-session');
}

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
    }, { signal: ctx.signal });

    if (!result.sessionId) {
      return errorResponse(ctx.id, 'ERR_INTERNAL', 'Harbor did not create a session');
    }

    // With an agent selected, the session's prompts run on it, like every
    // other model call (docs/ACP_BACKEND_DESIGN.md section 2). Open the
    // agent session now so the first prompt has one ready. The session's
    // tool allowlist and budget still govern session.callTool(); the
    // agent's own tools are its own.
    const backend = options.capabilities.llm ? await readAgentBackendSetting() : null;
    if (backend) {
      const systemPrompt = options.options?.systemPrompt;
      try {
        const { createAcpTextSession } = await loadAcpTextSession();
        await createAcpTextSession(
          result.sessionId, backend.agentId, ctx.origin, ctx.tabId,
          typeof systemPrompt === 'string' ? systemPrompt : undefined, ctx.signal,
        );
      } catch (e) {
        // Don't leave a Harbor session behind that the page never got.
        await harborRequest('session.terminate', { sessionId: result.sessionId, origin: ctx.origin }).catch(() => {});
        const code = (e as { code?: string }).code ?? 'ERR_AGENT_FAILED';
        return errorResponse(ctx.id, code, e instanceof Error ? e.message : 'The agent failed to start');
      }
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
    if (result.terminated) {
      forgetExplicitTextSession(sessionId, ctx.origin);
      if (isAcpTextSession(sessionId)) {
        const { destroyAcpTextSession } = await loadAcpTextSession();
        await destroyAcpTextSession(sessionId);
      }
    }

    return successResponse(ctx.id, { terminated: result.terminated });
  } catch (e) {
    return errorResponse(
      ctx.id,
      'ERR_SESSION_NOT_FOUND',
      e instanceof Error ? e.message : 'Session not found'
    );
  }
}
