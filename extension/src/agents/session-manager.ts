/**
 * Session Manager
 *
 * Manages text generation sessions with conversation history.
 * Integrates with the Rust bridge for LLM operations.
 */

import { bridgeChat } from '../llm/chat';
import type {
  TextSessionOptions,
  AILanguageModelCreateOptions,
  ConversationMessage,
  StoredSession,
  StreamToken,
  AICapabilityAvailability,
  AILanguageModelCapabilities,
} from './types';
import { bridgeRequest, getBridgeConnectionState } from '../llm/bridge-client';

// In-memory session storage (sessions don't persist across service worker restarts)
const sessions = new Map<string, StoredSession>();

// =============================================================================
// Session Lifecycle
// =============================================================================

/**
 * Create a new text session.
 */
export function createSession(
  origin: string,
  options: TextSessionOptions,
  initialPrompts?: ConversationMessage[],
): string {
  const sessionId = crypto.randomUUID();

  const session: StoredSession = {
    sessionId,
    origin,
    options,
    history: [],
    createdAt: Date.now(),
  };

  // Add initial prompts to history if provided
  if (initialPrompts && initialPrompts.length > 0) {
    session.history.push(...initialPrompts);
  }

  sessions.set(sessionId, session);

  return sessionId;
}

/**
 * Get a session by ID.
 */
export function getSession(sessionId: string): StoredSession | undefined {
  return sessions.get(sessionId);
}

/**
 * Validate that a session exists and belongs to the given origin.
 */
export function validateSession(sessionId: string, origin: string): StoredSession {
  const session = sessions.get(sessionId);
  if (!session) {
    throw Object.assign(new Error('Session not found'), { code: 'ERR_SESSION_NOT_FOUND' });
  }
  if (session.origin !== origin) {
    throw Object.assign(new Error('Session belongs to different origin'), { code: 'ERR_PERMISSION_DENIED' });
  }
  return session;
}

/**
 * Clone a session.
 */
export function cloneSession(sessionId: string, origin: string): string {
  const session = validateSession(sessionId, origin);

  const newSessionId = crypto.randomUUID();
  const newSession: StoredSession = {
    sessionId: newSessionId,
    origin: session.origin,
    options: { ...session.options },
    history: [], // Clone starts fresh
    createdAt: Date.now(),
  };

  sessions.set(newSessionId, newSession);
  return newSessionId;
}

/**
 * Destroy a session.
 */
export function destroySession(sessionId: string, origin: string): void {
  const session = sessions.get(sessionId);
  if (session && session.origin === origin) {
    sessions.delete(sessionId);
  }
}

// =============================================================================
// LLM Operations
// =============================================================================

/**
 * Check if text sessions can be created.
 */
export async function canCreateTextSession(): Promise<AICapabilityAvailability> {
  const state = getBridgeConnectionState();
  if (!state.connected) {
    return 'no';
  }

  try {
    await bridgeRequest<{ status: string }>('system.health');
    return 'readily';
  } catch {
    return 'no';
  }
}

/**
 * Get language model capabilities.
 */
export async function getLanguageModelCapabilities(): Promise<AILanguageModelCapabilities> {
  const available = await canCreateTextSession();
  return {
    available,
    defaultTemperature: 1.0,
    defaultTopK: 40,
    maxTopK: 100,
  };
}

/**
 * Send a prompt to the LLM and get a complete response.
 */
export async function prompt(sessionId: string, origin: string, input: string): Promise<string> {
  const session = validateSession(sessionId, origin);

  // Build messages array
  const messages: Array<{ role: string; content: string }> = [];

  // Add system prompt if present
  if (session.options.systemPrompt) {
    messages.push({ role: 'system', content: session.options.systemPrompt });
  }

  // Add conversation history
  for (const msg of session.history) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // Add current user message
  messages.push({ role: 'user', content: input });

  // Determine model to use
  let model = session.options.model || 'default';
  if (session.options.provider) {
    // If provider specified, prefix with provider
    if (!model.includes(':')) {
      model = `${session.options.provider}:${model}`;
    }
  }

  // Call bridge
  const response = await bridgeChat({
    model,
    messages,
    temperature: session.options.temperature,
  });

  const assistantContent = response.content;

  // Update session history
  session.history.push({ role: 'user', content: input });
  session.history.push({ role: 'assistant', content: assistantContent });

  return assistantContent;
}

/**
 * Send a prompt and stream the response token by token.
 * Returns an async generator of StreamToken events.
 */
export async function* promptStreaming(
  sessionId: string,
  origin: string,
  input: string,
): AsyncGenerator<StreamToken> {
  const session = validateSession(sessionId, origin);

  // Build messages array
  const messages: Array<{ role: string; content: string }> = [];

  // Add system prompt if present
  if (session.options.systemPrompt) {
    messages.push({ role: 'system', content: session.options.systemPrompt });
  }

  // Add conversation history
  for (const msg of session.history) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // Add current user message
  messages.push({ role: 'user', content: input });

  // Determine model to use
  let model = session.options.model || 'default';
  if (session.options.provider) {
    if (!model.includes(':')) {
      model = `${session.options.provider}:${model}`;
    }
  }

  // Add user message to history now
  session.history.push({ role: 'user', content: input });

  let fullContent = '';

  try {
    // Try streaming first
    const { bridgeStreamRequest } = await import('../llm/bridge-client');
    
    for await (const event of bridgeStreamRequest('llm.chat_stream', {
      model,
      messages,
      temperature: session.options.temperature,
    })) {
      if (event.type === 'token' && event.token) {
        fullContent += event.token;
        yield {
          type: 'token',
          token: event.token,
        };
      } else if (event.type === 'done') {
        break;
      } else if (event.type === 'error') {
        yield {
          type: 'error',
          error: {
            code: 'ERR_MODEL_FAILED',
            message: event.error?.message || 'Stream error',
          },
        };
        return;
      }
    }

    // Update session history with full response
    session.history.push({ role: 'assistant', content: fullContent });

    yield { type: 'done' };
  } catch (error) {
    // Fallback to non-streaming if SSE fails
    try {
      const response = await bridgeChat({
        model,
        messages,
        temperature: session.options.temperature,
      });

      const assistantContent = response.content;
      session.history.push({ role: 'assistant', content: assistantContent });

      // Emit content in chunks
      const chunkSize = 20;
      for (let i = 0; i < assistantContent.length; i += chunkSize) {
        yield {
          type: 'token',
          token: assistantContent.slice(i, i + chunkSize),
        };
      }

      yield { type: 'done' };
    } catch (fallbackError) {
      yield {
        type: 'error',
        error: {
          code: 'ERR_MODEL_FAILED',
          message: fallbackError instanceof Error ? fallbackError.message : 'Unknown error',
        },
      };
    }
  }
}

// =============================================================================
// Provider Operations
// =============================================================================

interface BridgeProviderInfo {
  id: string;
  type: string;
  name: string;
  configured: boolean;
  needs_api_key: boolean;
  is_local: boolean;
  is_default: boolean;
  is_type_default: boolean;
  has_api_key: boolean;
  base_url?: string;
}

interface BridgeProviderListResponse {
  providers: BridgeProviderInfo[];
  default_provider?: string;
}

interface BridgeConfigResponse {
  version: number;
  default_model?: string;
  default_provider?: string;
  providers: Record<string, {
    id: string;
    type: string;
    name: string;
    enabled: boolean;
    has_api_key: boolean;
    base_url?: string;
    is_type_default: boolean;
  }>;
}

export interface LLMProviderInfo {
  id: string;
  type: string;
  name: string;
  available: boolean;
  baseUrl?: string;
  models?: string[];
  isDefault: boolean;
  isTypeDefault: boolean;
  supportsTools?: boolean;
}

/**
 * List available LLM provider instances.
 */
export async function listProviders(): Promise<LLMProviderInfo[]> {
  try {
    const result = await bridgeRequest<BridgeProviderListResponse>('llm.list_providers');

    return result.providers.map((p) => ({
      id: p.id,
      type: p.type,
      name: p.name,
      available: p.configured || p.is_local,
      baseUrl: p.base_url,
      isDefault: p.is_default,
      isTypeDefault: p.is_type_default,
      supportsTools: supportsToolCalling(p.type),
    }));
  } catch {
    return [];
  }
}

/**
 * Get the currently active provider and model.
 */
export async function getActiveProvider(): Promise<{ provider: string | null; model: string | null }> {
  try {
    const config = await bridgeRequest<BridgeConfigResponse>('llm.get_config');

    // First check for default_provider (instance ID)
    if (config.default_provider) {
      const instance = config.providers[config.default_provider];
      if (instance) {
        // If there's a default model, extract just the model part
        const model = config.default_model?.split(':')[1] || null;
        return {
          provider: config.default_provider,
          model,
        };
      }
    }

    // Fallback to default_model parsing
    if (config.default_model) {
      const parts = config.default_model.split(':');
      return {
        provider: parts[0] || null,
        model: parts[1] || null,
      };
    }

    return { provider: null, model: null };
  } catch {
    return { provider: null, model: null };
  }
}

/**
 * Add a new provider instance.
 */
export async function addProvider(options: {
  type: string;
  name: string;
  apiKey?: string;
  baseUrl?: string;
}): Promise<{ id: string }> {
  const result = await bridgeRequest<{ ok: boolean; id: string }>('llm.add_provider', {
    type: options.type,
    name: options.name,
    api_key: options.apiKey,
    base_url: options.baseUrl,
  });
  return { id: result.id };
}

/**
 * Remove a provider instance.
 */
export async function removeProvider(instanceId: string): Promise<void> {
  await bridgeRequest<{ ok: boolean }>('llm.remove_provider', { id: instanceId });
}

/**
 * Set the global default provider.
 */
export async function setDefaultProvider(instanceId: string): Promise<void> {
  await bridgeRequest<{ ok: boolean }>('llm.set_default_provider', { id: instanceId });
}

/**
 * Set the type default for a provider.
 */
export async function setTypeDefault(instanceId: string): Promise<void> {
  await bridgeRequest<{ ok: boolean }>('llm.set_type_default', { id: instanceId });
}

function supportsToolCalling(providerType: string): boolean {
  // Most modern providers support tool calling
  return ['openai', 'anthropic', 'mistral', 'ollama', 'apple'].includes(providerType);
}

// =============================================================================
// Session Cleanup
// =============================================================================

const SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Clean up old sessions.
 */
export function cleanupOldSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (now - session.createdAt > SESSION_MAX_AGE_MS) {
      sessions.delete(sessionId);
    }
  }
}

// Run cleanup every 10 minutes
setInterval(cleanupOldSessions, 10 * 60 * 1000);
