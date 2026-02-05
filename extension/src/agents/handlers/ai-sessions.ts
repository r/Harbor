/**
 * AI session and provider handlers.
 */

import type { RequestContext, ResponseSender } from './router-types';
import { log, requirePermission } from './helpers';
import { bridgeRequest } from '../../llm/bridge-client';
import { getRuntimeCapabilities, listAllProviders } from '../../llm/provider-registry';

// =============================================================================
// State Management
// =============================================================================

// Active text sessions
const textSessions = new Map<string, {
  sessionId: string;
  origin: string;
  options: Record<string, unknown>;
  history: Array<{ role: string; content: string }>;
  createdAt: number;
}>();

// Session/Chat ID counter
let sessionIdCounter = 0;

function generateSessionId(): string {
  return `session-${Date.now()}-${++sessionIdCounter}`;
}

// =============================================================================
// Session Handlers
// =============================================================================

/**
 * Handle ai.canCreateTextSession - Check if text session creation is available.
 */
export async function handleCanCreateTextSession(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  // Check if bridge is connected
  try {
    const result = await bridgeRequest<{ models: unknown[] }>('llm.list_configured_models');
    const available = result.models && result.models.length > 0 ? 'readily' : 'no';
    sender.sendResponse({ id: ctx.id, ok: true, result: available });
  } catch {
    sender.sendResponse({ id: ctx.id, ok: true, result: 'no' });
  }
}

/**
 * Handle ai.createTextSession / ai.languageModel.create - Create a new text session.
 */
export async function handleCreateTextSession(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'model:prompt'))) {
    return;
  }

  const payload = (ctx.payload || {}) as Record<string, unknown>;
  const sessionId = generateSessionId();

  textSessions.set(sessionId, {
    sessionId,
    origin: ctx.origin,
    options: payload,
    history: payload.systemPrompt
      ? [{ role: 'system', content: payload.systemPrompt as string }]
      : [],
    createdAt: Date.now(),
  });

  sender.sendResponse({ id: ctx.id, ok: true, result: sessionId });
}

/**
 * Handle session.prompt - Send a prompt to an existing session.
 */
export async function handleSessionPrompt(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'model:prompt'))) {
    return;
  }

  const payload = ctx.payload as { sessionId: string; input: string };
  const session = textSessions.get(payload.sessionId);

  if (!session) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_SESSION_NOT_FOUND', message: 'Session not found' },
    });
    return;
  }

  if (session.origin !== ctx.origin) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Session belongs to different origin' },
    });
    return;
  }

  try {
    // Add user message to history
    session.history.push({ role: 'user', content: payload.input });

    // Call LLM
    const result = await bridgeRequest<{
      choices?: Array<{ message?: { role: string; content: string } }>;
      response?: { role: string; content: string };
      message?: { role: string; content: string };
      content?: string;
    }>('llm.chat', {
      messages: session.history,
      model: session.options.model,
    });

    // Extract content - bridge returns in choices[0].message.content format
    const content = result.choices?.[0]?.message?.content 
      || result.response?.content 
      || result.message?.content 
      || result.content 
      || '';

    log('Session prompt result:', content.slice(0, 100));

    // Add assistant response to history
    session.history.push({ role: 'assistant', content });

    sender.sendResponse({ id: ctx.id, ok: true, result: content });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_MODEL_FAILED',
        message: error instanceof Error ? error.message : 'Model request failed',
      },
    });
  }
}

/**
 * Handle session.destroy - Destroy a text session.
 */
export async function handleSessionDestroy(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const payload = ctx.payload as { sessionId: string };
  const session = textSessions.get(payload.sessionId);

  if (session && session.origin === ctx.origin) {
    textSessions.delete(payload.sessionId);
  }

  sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
}

/**
 * Handle ai.languageModel.capabilities - Get language model capabilities.
 */
export async function handleLanguageModelCapabilities(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  try {
    const result = await bridgeRequest<{ models: unknown[] }>('llm.list_configured_models');
    const available = result.models && result.models.length > 0 ? 'readily' : 'no';
    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: {
        available,
        defaultTemperature: 0.7,
        defaultTopK: 40,
        maxTopK: 100,
      },
    });
  } catch {
    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: { available: 'no' },
    });
  }
}

// =============================================================================
// Provider Handlers
// =============================================================================

/**
 * Handle ai.providers.list - List available LLM providers.
 */
export async function handleProvidersList(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'model:list'))) {
    return;
  }

  try {
    // Use the provider registry which includes native browser providers
    const providers = await listAllProviders();
    sender.sendResponse({ id: ctx.id, ok: true, result: providers });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to list providers',
      },
    });
  }
}

/**
 * Handle ai.runtime.getCapabilities - Get runtime capabilities.
 */
export async function handleRuntimeGetCapabilities(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  try {
    const capabilities = await getRuntimeCapabilities();
    sender.sendResponse({ id: ctx.id, ok: true, result: capabilities });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to get runtime capabilities',
      },
    });
  }
}

// Export session counter for agent-run handler
export { sessionIdCounter, generateSessionId };
