/**
 * AI session and provider handlers.
 */

import { bridgeChat } from '../../llm/chat';
import type { RequestContext, ResponseSender } from './router-types';
import { log, requireAction } from './helpers';
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
  // Creating a text session is a no-op against the bridge — the cost is
  // borne when the page actually prompts. We gate on the *least* permissive
  // action (`model.prompt.local`) so a page that only ever uses on-device
  // models doesn't get prompted for cloud egress it never makes.
  if (!(await requireAction(ctx, sender, 'model.prompt.local', {
    promptAsScope: 'model:prompt',
  }))) {
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

  // Pick the typed action based on what the configured model actually does.
  // We can't know the locality of an arbitrary model name without a registry
  // lookup, so we conservatively assume `remote.firstParty` (the user's
  // configured account) for any session that names a model. Sessions with no
  // model selection ride the local path; the engine will still gate
  // remote-egress at the bridge layer through `network.egress.cross_origin`
  // when the bridge actually fetches.
  const modelName =
    typeof session.options.model === 'string' ? session.options.model.toLowerCase() : '';
  const looksLocal =
    !modelName ||
    modelName.startsWith('ollama:') ||
    modelName.startsWith('local:') ||
    modelName.startsWith('firefox-ml:') ||
    modelName.startsWith('chrome-ai:');
  const action = looksLocal ? 'model.prompt.local' : 'model.prompt.remote.firstParty';
  if (!(await requireAction(ctx, sender, action, { promptAsScope: 'model:prompt' }))) {
    return;
  }

  try {
    // Add user message to history
    session.history.push({ role: 'user', content: payload.input });

    // Call LLM
    const result = await bridgeChat({
      messages: session.history,
      model: typeof session.options.model === 'string' ? session.options.model : undefined,
    });

    const content = result.content;

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
  if (!(await requireAction(ctx, sender, 'model.list', { promptAsScope: 'model:list' }))) {
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
