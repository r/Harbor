/**
 * AI/LLM Handlers
 * 
 * Handles text sessions, prompts, and provider management.
 */

import { harborRequest } from '../harbor-core';
import type { RequestContext, HandlerResponse, TextSessionState } from './types';
import type { SessionSummary } from '../types';
import { errorResponse, successResponse } from './types';
import { hasPermission } from './permission-handlers';
import { FEATURE_LABELS, getFeatureFlags } from '../policy/feature-flags';

// =============================================================================
// Session State
// =============================================================================

const textSessions = new Map<string, TextSessionState>();
let sessionIdCounter = 0;

function generateSessionId(): string {
  return `session-${Date.now()}-${++sessionIdCounter}`;
}

// =============================================================================
// Handlers
// =============================================================================

export async function handleAiCanCreateTextSession(ctx: RequestContext): HandlerResponse {
  try {
    const capabilities = await harborRequest<{ bridgeReady: boolean }>('system.getCapabilities');
    return successResponse(ctx.id, capabilities.bridgeReady ? 'readily' : 'no');
  } catch {
    return successResponse(ctx.id, 'no');
  }
}

export async function handleAiCreateTextSession(ctx: RequestContext): HandlerResponse {
  console.log('[Web Agents API] handleAiCreateTextSession called', { origin: ctx.origin });
  
  // Check permission
  if (!await hasPermission(ctx.origin, 'model:prompt', ctx.tabId)) {
    console.log('[Web Agents API] handleAiCreateTextSession: Permission denied for', ctx.origin);
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Permission model:prompt required');
  }

  const options = (ctx.payload || {}) as Record<string, unknown>;
  const sessionId = generateSessionId();
  
  console.log('[Web Agents API] handleAiCreateTextSession: Creating session', {
    sessionId,
    systemPromptLength: options.systemPrompt ? String(options.systemPrompt).length : 0,
    hasTemperature: !!options.temperature,
  });
  
  textSessions.set(sessionId, {
    sessionId,
    origin: ctx.origin,
    options,
    history: [],
    createdAt: Date.now(),
  });

  console.log('[Web Agents API] handleAiCreateTextSession: Session created successfully', sessionId);
  return successResponse(ctx.id, sessionId);
}

/**
 * Track an explicit session (agent.sessions.create) so session.prompt can find
 * it. Harbor's session registry stays the authority on whether the session is
 * still alive and has LLM access; this only holds its options and chat history.
 */
export function registerExplicitTextSession(
  sessionId: string,
  origin: string,
  options: Record<string, unknown>,
): void {
  textSessions.set(sessionId, {
    sessionId,
    origin,
    options,
    history: [],
    createdAt: Date.now(),
    explicit: true,
  });
}

/** Drop the local state for an explicit session the origin terminated. */
export function forgetExplicitTextSession(sessionId: string, origin: string): void {
  const session = textSessions.get(sessionId);
  if (session?.explicit && session.origin === origin) textSessions.delete(sessionId);
}

/** Harbor's refusals from getValidatedSession: the session is gone for this origin. */
const HARBOR_SESSION_GONE = /^Session (not found|has been terminated|has expired|belongs to different origin)$/;

/**
 * Tell Harbor an explicit session was prompted, so its registry sees the
 * activity (inactivity cleanup, usage shown in the sidebar). Best effort.
 */
export function recordExplicitPrompt(
  session: TextSessionState,
  userMessage: string,
  assistantMessage: string,
): void {
  if (!session.explicit) return;
  harborRequest('session.recordUsage', {
    sessionId: session.sessionId,
    origin: session.origin,
    type: 'prompt',
    detail: { userMessage, assistantMessage },
  }).catch(() => {});
}

/**
 * Look up a text session for a prompt from `origin`. Explicit sessions are
 * revalidated with Harbor on every prompt, so termination and expiry apply.
 * A window.ai session is refused while Text Generation is off, even one made
 * before it was turned off.
 */
export async function resolveTextSession(
  sessionId: string,
  origin: string,
): Promise<{ session: TextSessionState } | { code: string; message: string }> {
  const session = textSessions.get(sessionId);
  if (!session) {
    return { code: 'ERR_SESSION_NOT_FOUND', message: 'Session not found' };
  }
  if (session.origin !== origin) {
    return { code: 'ERR_PERMISSION_DENIED', message: 'Session belongs to different origin' };
  }
  if (!session.explicit && !(await getFeatureFlags()).textGeneration) {
    return { code: 'ERR_FEATURE_DISABLED', message: `${FEATURE_LABELS.textGeneration} is disabled` };
  }
  if (session.explicit) {
    let hasLLM: boolean;
    try {
      const result = await harborRequest<{ session?: SessionSummary | null; supported?: false }>(
        'session.get', { sessionId, origin });
      if (result.supported === false) {
        // Safari's HTTP bridge has no session registry.
        return { code: 'ERR_INTERNAL', message: 'Explicit sessions are not supported in this browser' };
      }
      if (!result.session) throw new Error('Session not found');
      hasLLM = result.session.capabilities.hasLLM;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!HARBOR_SESSION_GONE.test(message)) {
        // Harbor couldn't answer (not connected, timed out). Keep the session:
        // it may still be alive, and the prompt fails closed either way.
        const code = (e as { code?: string }).code ?? 'ERR_INTERNAL';
        return { code, message: `Could not check the session with Harbor: ${message}` };
      }
      textSessions.delete(sessionId);
      return { code: 'ERR_SESSION_NOT_FOUND', message: 'Session not found' };
    }
    if (!hasLLM) {
      return { code: 'ERR_PERMISSION_DENIED', message: 'Session does not have LLM access' };
    }
  }
  return { session };
}

export async function handleSessionPrompt(ctx: RequestContext): HandlerResponse {
  const { sessionId, input } = ctx.payload as { sessionId: string; input: string };
  
  const resolved = await resolveTextSession(sessionId, ctx.origin);
  if (!('session' in resolved)) {
    return errorResponse(ctx.id, resolved.code, resolved.message);
  }
  const { session } = resolved;

  try {
    // Add user message to history
    session.history.push({ role: 'user', content: input });
    
    // Build messages array
    const messages: Array<{ role: string; content: string }> = [];
    if (session.options.systemPrompt) {
      messages.push({ role: 'system', content: session.options.systemPrompt as string });
    }
    messages.push(...session.history);
    
    // Call Harbor
    const result = await harborRequest<{ content: string; model?: string }>('llm.chat', {
      origin: ctx.origin,
      tabId: ctx.tabId,
      messages,
      model: session.options.model,
      temperature: session.options.temperature,
    });
    
    // Add assistant response to history
    session.history.push({ role: 'assistant', content: result.content });
    recordExplicitPrompt(session, input, result.content);
    
    return successResponse(ctx.id, result.content);
  } catch (e) {
    return errorResponse(
      ctx.id,
      'ERR_MODEL_FAILED',
      e instanceof Error ? e.message : 'LLM request failed'
    );
  }
}

export async function handleSessionDestroy(ctx: RequestContext): HandlerResponse {
  const { sessionId } = ctx.payload as { sessionId: string };
  if (textSessions.get(sessionId)?.origin === ctx.origin) textSessions.delete(sessionId);
  return successResponse(ctx.id, null);
}

export async function handleLanguageModelCapabilities(ctx: RequestContext): HandlerResponse {
  try {
    const capabilities = await harborRequest<{ bridgeReady: boolean }>('system.getCapabilities');
    return successResponse(ctx.id, {
      available: capabilities.bridgeReady ? 'readily' : 'no',
      defaultTemperature: 0.7,
      defaultTopK: 40,
      maxTopK: 100,
    });
  } catch {
    return successResponse(ctx.id, { available: 'no' });
  }
}

export async function handleProvidersList(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'model:list', ctx.tabId)) {
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Permission model:list required');
  }

  try {
    const result = await harborRequest<{ providers: unknown[] }>('llm.listProviders');
    return successResponse(ctx.id, result.providers);
  } catch (e) {
    return errorResponse(
      ctx.id,
      'ERR_INTERNAL',
      e instanceof Error ? e.message : 'Failed to list providers'
    );
  }
}

export async function handleProvidersGetActive(ctx: RequestContext): HandlerResponse {
  try {
    const result = await harborRequest<{ default_model?: string }>('llm.getActiveProvider');
    return successResponse(ctx.id, { provider: null, model: result.default_model || null });
  } catch {
    return successResponse(ctx.id, { provider: null, model: null });
  }
}

/** List configured models (named aliases) from Harbor — e.g. "llama", "gpt". */
export async function handleProvidersListConfiguredModels(ctx: RequestContext): HandlerResponse {
  if (!(await hasPermission(ctx.origin, 'model:list', ctx.tabId))) {
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Permission model:list required');
  }

  try {
    const result = await harborRequest<{ models: Array<{ name: string; model_id: string; is_default?: boolean }> }>(
      'llm.listConfiguredModels'
    );
    return successResponse(ctx.id, result.models ?? []);
  } catch (e) {
    return errorResponse(
      ctx.id,
      'ERR_INTERNAL',
      e instanceof Error ? e.message : 'Failed to list configured models'
    );
  }
}

/** Get metadata for configured models (companion to listConfiguredModels). Includes is_local. */
export async function handleProvidersGetConfiguredModelsMetadata(ctx: RequestContext): HandlerResponse {
  if (!(await hasPermission(ctx.origin, 'model:list', ctx.tabId))) {
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Permission model:list required');
  }

  try {
    const result = await harborRequest<{ metadata: Array<{ model_id: string; is_local: boolean }> }>(
      'llm.getConfiguredModelsMetadata'
    );
    return successResponse(ctx.id, result.metadata ?? []);
  } catch (e) {
    return errorResponse(
      ctx.id,
      'ERR_INTERNAL',
      e instanceof Error ? e.message : 'Failed to get configured models metadata'
    );
  }
}
