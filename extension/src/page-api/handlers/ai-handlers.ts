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
import { policyRefusalCode } from '../policy-refusal';
import { FEATURE_LABELS, getFeatureFlags } from '../policy/feature-flags';
import { readAgentBackendSetting } from '../agent-backend-setting';
import { isAcpTextSession } from '../acp-text-session-registry';
import { acpBackendChangeSignal } from '../acp-backend-generation';

/** What a page sees when the person switched agents while its session was being created. */
export const AGENT_CHANGED_MESSAGE = 'The agent was changed. Create the session again.';

// Loaded lazily (not a top-level import): acp-text-session.ts pulls in
// acp-connection.ts -> agent-question.ts, which registers a
// `browserAPI.runtime.onMessage` listener as soon as it's imported. This
// file is part of the handlers/ barrel that many unrelated tests reach
// through `../handlers` with only a bare-bones `chrome` stub, so importing
// it lazily keeps that barrel's own import graph light for those tests. It
// doesn't save anything at runtime: background.ts imports acp-text-session.ts
// directly, so the background script loads it for every page anyway. `isAcpTextSession` itself is cheap and side-effect-free
// (acp-text-session-registry.ts), so every prompt/destroy can check it.
async function loadAcpTextSession() {
  return import('../acp-text-session');
}

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

  // When the person has picked an ACP agent as their backend
  // (docs/ACP_BACKEND_DESIGN.md section 2), this session runs on it instead
  // of Harbor's own llm.chat: open the agent process and its ACP session
  // now, so a later prompt/promptStreaming call has one ready. `model` and
  // `temperature`/`topK` are ignored silently on this backend — the agent
  // picks its own model and sampling.
  // A switch while this runs would otherwise leave a session made for the
  // old choice, registered after the switch's own cleanup already ran.
  const backendChanged = acpBackendChangeSignal();
  const backendSetting = await readAgentBackendSetting();
  if (backendSetting) {
    const systemPrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt : undefined;
    try {
      const { createAcpTextSession } = await loadAcpTextSession();
      // `ctx.signal` aborts on the page's own create-request timeout
      // (injected.ts) or an explicit abort for this request id — either
      // way, the agent shouldn't keep starting once nobody's waiting.
      await createAcpTextSession(sessionId, backendSetting.agentId, ctx.origin, ctx.tabId, systemPrompt, ctx.signal);
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'ERR_AGENT_FAILED';
      return errorResponse(ctx.id, code, e instanceof Error ? e.message : 'The agent failed to start');
    }
  }

  if (backendChanged.aborted) {
    if (isAcpTextSession(sessionId)) {
      const { destroyAcpTextSession } = await loadAcpTextSession();
      await destroyAcpTextSession(sessionId);
    }
    return errorResponse(ctx.id, 'ERR_AGENT_FAILED', AGENT_CHANGED_MESSAGE);
  }

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

/**
 * Ends an explicit session's local state once Harbor has ended it (the page
 * terminated it, it expired, or Harbor dropped it), including the agent
 * process behind it when it ran on the person's agent. A no-op for another
 * origin's session or one already gone.
 */
export async function endExplicitTextSession(sessionId: string, origin: string): Promise<void> {
  const session = textSessions.get(sessionId);
  if (!session?.explicit || session.origin !== origin) return;
  textSessions.delete(sessionId);
  if (isAcpTextSession(sessionId)) {
    const { destroyAcpTextSession } = await loadAcpTextSession();
    await destroyAcpTextSession(sessionId);
  }
}

/** Harbor's refusals from getValidatedSession: the session is gone for this origin. */
export const HARBOR_SESSION_GONE = /^Session (not found|has been terminated|has expired|belongs to different origin)$/;

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
 *
 * Every prompt needs a live `model:prompt` grant, not just the one the origin
 * held when it created the session: revoking the site, or a one-time grant
 * expiring, stops the next prompt on a session it already has open.
 */
export async function resolveTextSession(
  sessionId: string,
  origin: string,
  tabId?: number,
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
  if (!await hasPermission(origin, 'model:prompt', tabId)) {
    return { code: 'ERR_PERMISSION_DENIED', message: 'Permission model:prompt required' };
  }
  if (session.explicit) {
    let hasLLM: boolean;
    try {
      const result = await harborRequest<{ session?: SessionSummary | null }>(
        'session.get', { sessionId, origin });
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
      await endExplicitTextSession(sessionId, origin);
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

  const resolved = await resolveTextSession(sessionId, ctx.origin, ctx.tabId);
  if (!('session' in resolved)) {
    return errorResponse(ctx.id, resolved.code, resolved.message);
  }
  const { session } = resolved;

  if (isAcpTextSession(sessionId)) {
    const { promptAcpTextSession } = await loadAcpTextSession();
    // `ctx.signal` aborts on the page's own request timeout (extended for
    // this type past the default 30s, but still finite) or an explicit
    // abort — this turn, and any later one still queued behind it, must not
    // keep running once nobody's waiting for it.
    const result = await promptAcpTextSession(sessionId, input, ctx.signal);
    if (!result.ok) {
      return errorResponse(ctx.id, result.error.error?.code ?? 'ERR_AGENT_FAILED', result.error.error?.message ?? 'Agent run failed');
    }
    return successResponse(ctx.id, result.text);
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
      origin: ctx.origin,
      tabId: ctx.tabId,
      messages,
      model: session.options.model,
      temperature: session.options.temperature,
    }, { signal: ctx.signal });
    
    // Add assistant response to history
    session.history.push({ role: 'assistant', content: result.content });
    recordExplicitPrompt(session, input, result.content);
    
    return successResponse(ctx.id, result.content);
  } catch (e) {
    return errorResponse(
      ctx.id,
      policyRefusalCode(e) ?? 'ERR_MODEL_FAILED',
      e instanceof Error ? e.message : 'LLM request failed'
    );
  }
}

export async function handleSessionDestroy(ctx: RequestContext): HandlerResponse {
  const { sessionId } = ctx.payload as { sessionId: string };
  if (textSessions.get(sessionId)?.origin === ctx.origin) {
    textSessions.delete(sessionId);
    if (isAcpTextSession(sessionId)) {
      // Cancels any turn in progress and kills the agent process.
      const { destroyAcpTextSession } = await loadAcpTextSession();
      await destroyAcpTextSession(sessionId);
    }
  }
  return successResponse(ctx.id, null);
}

/**
 * Forgets every text session still on Harbor's built-in model, for a switch
 * of the person's agent (background.ts): a session made on the built-in
 * model doesn't outlive the switch, just as one made on an agent doesn't.
 * A later prompt on one gets "Session not found". Sessions on an agent are
 * left to destroyAllAcpTextSessions, which also ends their agent process.
 */
export function forgetBuiltinTextSessions(): void {
  for (const sessionId of [...textSessions.keys()]) {
    if (!isAcpTextSession(sessionId)) textSessions.delete(sessionId);
  }
}

/** Drops a text session's state without an origin check — used for cleanup triggered by the extension itself (a tab closing), not a page request. */
export function forgetTextSession(sessionId: string): void {
  textSessions.delete(sessionId);
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

/** The calling page, which Harbor's policy check needs on every page call. */
function pageCall(ctx: RequestContext): { origin: string; tabId?: number } {
  return { origin: ctx.origin, tabId: ctx.tabId };
}

export async function handleProvidersList(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'model:list', ctx.tabId)) {
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Permission model:list required');
  }

  try {
    const result = await harborRequest<{ providers: unknown[] }>('llm.listProviders', pageCall(ctx), { signal: ctx.signal });
    return successResponse(ctx.id, result.providers);
  } catch (e) {
    return errorResponse(
      ctx.id,
      policyRefusalCode(e) ?? 'ERR_INTERNAL',
      e instanceof Error ? e.message : 'Failed to list providers'
    );
  }
}

export async function handleProvidersGetActive(ctx: RequestContext): HandlerResponse {
  if (!(await hasPermission(ctx.origin, 'model:list', ctx.tabId))) {
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Permission model:list required');
  }

  try {
    const result = await harborRequest<{ default_model?: string | null; provider?: string | null }>('llm.getActiveProvider', pageCall(ctx), { signal: ctx.signal });
    return successResponse(ctx.id, { provider: result.provider ?? null, model: result.default_model || null });
  } catch (e) {
    // A refusal is reported; any other failure means no model is known.
    const refused = policyRefusalCode(e);
    if (refused) return errorResponse(ctx.id, refused, e instanceof Error ? e.message : 'Permission denied');
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
      'llm.listConfiguredModels', pageCall(ctx), { signal: ctx.signal },
    );
    return successResponse(ctx.id, result.models ?? []);
  } catch (e) {
    return errorResponse(
      ctx.id,
      policyRefusalCode(e) ?? 'ERR_INTERNAL',
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
      'llm.getConfiguredModelsMetadata', pageCall(ctx), { signal: ctx.signal },
    );
    return successResponse(ctx.id, result.metadata ?? []);
  } catch (e) {
    return errorResponse(
      ctx.id,
      policyRefusalCode(e) ?? 'ERR_INTERNAL',
      e instanceof Error ? e.message : 'Failed to get configured models metadata'
    );
  }
}
