/**
 * AI/LLM Handlers
 * 
 * Handles text sessions, prompts, and provider management.
 */

import { harborRequest, discoverHarbor, getHarborState } from '../harbor-client';
import type { RequestContext, HandlerResponse, TextSessionState } from './types';
import { errorResponse, successResponse } from './types';
import { hasPermission } from './permission-handlers';

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
    const harborState = getHarborState();
    if (!harborState.connected) {
      await discoverHarbor();
    }
    
    const capabilities = await harborRequest<{ bridgeReady: boolean }>('system.getCapabilities');
    return successResponse(ctx.id, capabilities.bridgeReady ? 'readily' : 'no');
  } catch {
    return successResponse(ctx.id, 'no');
  }
}

export async function handleAiCreateTextSession(ctx: RequestContext): HandlerResponse {
  console.log('[Web Agents API] handleAiCreateTextSession called', {
    origin: ctx.origin,
    payload: ctx.payload,
  });
  
  // Check permission
  if (!await hasPermission(ctx.origin, 'model:prompt')) {
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

export async function handleSessionPrompt(ctx: RequestContext): HandlerResponse {
  const { sessionId, input } = ctx.payload as { sessionId: string; input: string };
  
  const session = textSessions.get(sessionId);
  if (!session) {
    return errorResponse(ctx.id, 'ERR_SESSION_NOT_FOUND', 'Session not found');
  }
  
  if (session.origin !== ctx.origin) {
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Session belongs to different origin');
  }

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
      messages,
      model: session.options.model,
      temperature: session.options.temperature,
    });
    
    // Add assistant response to history
    session.history.push({ role: 'assistant', content: result.content });
    
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
  textSessions.delete(sessionId);
  return successResponse(ctx.id, null);
}

export async function handleLanguageModelCapabilities(ctx: RequestContext): HandlerResponse {
  try {
    const harborState = getHarborState();
    if (!harborState.connected) {
      await discoverHarbor();
    }
    
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
  if (!await hasPermission(ctx.origin, 'model:list')) {
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
  if (!(await hasPermission(ctx.origin, 'model:list'))) {
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
  if (!(await hasPermission(ctx.origin, 'model:list'))) {
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

// =============================================================================
// Exports for streaming (used by background.ts directly)
// =============================================================================

export function getTextSession(sessionId: string): TextSessionState | undefined {
  return textSessions.get(sessionId);
}
