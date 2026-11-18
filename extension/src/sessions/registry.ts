/**
 * Session Registry
 *
 * Central registry for all agent sessions. Tracks both implicit sessions
 * (from ai.createTextSession) and explicit sessions (from agent.sessions.create).
 *
 * Sessions are ephemeral - stored in memory and cleared on extension restart.
 * This is intentional: agents should re-request capabilities on restart.
 */

import type {
  AgentSession,
  SessionCapabilities,
  SessionStatus,
  SessionType,
  SessionSummary,
  SessionEvent,
  SessionEventListener,
  CreateSessionOptions,
  CreateSessionResult,
  ListSessionsOptions,
  SessionOptions,
  SessionUsage,
} from './types';
import { getDefaultImplicitCapabilities, buildCapabilitiesFromRequest } from './types';
import type { ConversationMessage } from '../agents/types';
import { Tokens, type SessionMode, type CapabilityToken, TokenError } from '../policy/tokens';
import type { TypedAction } from '../policy/actions';
import type { DataLabel } from '../policy/labels';

// =============================================================================
// Session Registry
// =============================================================================

class SessionRegistryImpl {
  private sessions = new Map<string, AgentSession>();
  private listeners = new Set<SessionEventListener>();

  // Cleanup interval (10 minutes)
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
  private readonly SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour default

  constructor() {
    this.startCleanupInterval();
  }

  // ===========================================================================
  // Session Creation
  // ===========================================================================

  /**
   * Create an implicit session (from ai.createTextSession).
   * These have default capabilities (LLM only, no tools/browser).
   */
  createImplicitSession(
    origin: string,
    options: SessionOptions = {},
    tabId?: number,
  ): AgentSession {
    const sessionId = crypto.randomUUID();
    const now = Date.now();

    const capabilities = getDefaultImplicitCapabilities();
    // Implicit sessions only get the local-prompt action — they're created
    // by ai.createTextSession and the user hasn't been prompted for
    // anything else. The token's mode is `execute` because there's no
    // explicit plan/execute distinction at the implicit level.
    const token = Tokens.mint({
      sessionId,
      origin,
      mode: 'execute',
      allowedActions: capabilitiesToActions(capabilities, /*toolsAllowList=*/ []),
      acceptedLabels: ['confidential'],
      ttlMs: 60 * 60 * 1000,
    });

    const session: AgentSession = {
      sessionId,
      type: 'implicit',
      origin,
      tabId,
      status: 'active',
      createdAt: now,
      lastActiveAt: now,
      capabilities,
      history: [],
      options,
      usage: {
        promptCount: 0,
        toolCallCount: 0,
      },
      mode: 'execute',
      tokenId: token.id,
    };

    this.sessions.set(sessionId, session);
    this.emit({ type: 'session_created', session: this.toSummary(session) });

    console.log('[SessionRegistry] Created implicit session:', sessionId, 'for', origin, 'token:', token.id);
    return session;
  }

  /**
   * Create an explicit session (from agent.sessions.create).
   * Capabilities are specified by the caller and bounded by origin permissions.
   */
  createExplicitSession(
    origin: string,
    request: CreateSessionOptions,
    allowedTools: string[] = [],
    tabId?: number,
  ): CreateSessionResult {
    const sessionId = crypto.randomUUID();
    const now = Date.now();

    // Build capabilities from request, filtered by what's allowed
    const capabilities = buildCapabilitiesFromRequest(request.capabilities, allowedTools);

    // Apply limits
    if (request.limits) {
      capabilities.limits = {
        maxToolCalls: request.limits.maxToolCalls,
        expiresAt: request.limits.ttlMinutes
          ? now + request.limits.ttlMinutes * 60 * 1000
          : undefined,
      };
    }

    // Explicit sessions get a capability token sized to the request.
    const mode: SessionMode = request.mode ?? 'execute';
    const ttlMs = capabilities.limits?.expiresAt
      ? Math.max(0, capabilities.limits.expiresAt - now)
      : 30 * 60 * 1000;
    const token = Tokens.mint({
      sessionId,
      origin,
      mode,
      allowedActions: capabilitiesToActions(capabilities, capabilities.tools.allowedTools),
      acceptedLabels: defaultAcceptedLabelsForMode(mode),
      budgets: {
        toolCalls: capabilities.limits?.maxToolCalls,
        wallClockMs: ttlMs,
      },
      ttlMs,
    });

    const session: AgentSession = {
      sessionId,
      type: 'explicit',
      origin,
      tabId,
      status: 'active',
      createdAt: now,
      lastActiveAt: now,
      capabilities,
      name: request.name,
      reason: request.reason,
      history: [],
      options: request.options || {},
      usage: {
        promptCount: 0,
        toolCallCount: 0,
      },
      mode,
      tokenId: token.id,
    };

    this.sessions.set(sessionId, session);
    this.emit({ type: 'session_created', session: this.toSummary(session) });

    console.log('[SessionRegistry] Created explicit session:', sessionId, 'for', origin, {
      name: request.name,
      capabilities,
      tokenId: token.id,
    });

    return {
      success: true,
      sessionId,
      capabilities,
    };
  }

  /**
   * Change the mode of an existing session. Re-mints the capability token
   * with the new mode (cannot widen — see Tokens.attenuate's mode lattice).
   * Used by `agent.upgradeSession`.
   */
  setMode(sessionId: string, origin: string, mode: SessionMode): boolean {
    const session = this.getValidatedSession(sessionId, origin);
    if (session.mode === mode) return true;
    if (!session.tokenId) {
      session.mode = mode;
      return true;
    }
    try {
      // Re-attenuate the token. The mode lattice will reject widenings.
      const child = Tokens.attenuate(session.tokenId, { sessionId, mode });
      session.mode = mode;
      session.tokenId = child.id;
      return true;
    } catch (err) {
      if (err instanceof TokenError) {
        console.warn('[SessionRegistry] setMode rejected:', err.message);
        return false;
      }
      throw err;
    }
  }

  /**
   * Mint a child capability token for a subagent the session is about to
   * delegate to. Always strictly attenuated from the parent. Used by the
   * multi-agent invoke path.
   */
  attenuateForSubagent(
    parentSessionId: string,
    origin: string,
    childSessionId: string,
    restrictions: {
      allowedActions?: TypedAction[];
      acceptedLabels?: DataLabel[];
      mode?: SessionMode;
      ttlMs?: number;
      maxToolCalls?: number;
    } = {},
  ): CapabilityToken | null {
    const parent = this.getValidatedSession(parentSessionId, origin);
    if (!parent.tokenId) return null;
    try {
      return Tokens.attenuate(parent.tokenId, {
        sessionId: childSessionId,
        allowedActions: restrictions.allowedActions,
        acceptedLabels: restrictions.acceptedLabels,
        mode: restrictions.mode,
        ttlMs: restrictions.ttlMs,
        budgets: {
          toolCalls: restrictions.maxToolCalls,
          wallClockMs: restrictions.ttlMs,
        },
      });
    } catch (err) {
      if (err instanceof TokenError) {
        console.warn('[SessionRegistry] attenuateForSubagent rejected:', err.message);
        return null;
      }
      throw err;
    }
  }

  // ===========================================================================
  // Session Retrieval
  // ===========================================================================

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get a session by ID, validating it belongs to the origin.
   * Throws if session not found or origin mismatch.
   */
  getValidatedSession(sessionId: string, origin: string): AgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error('Session not found'), { code: 'ERR_SESSION_NOT_FOUND' });
    }
    if (session.origin !== origin) {
      throw Object.assign(new Error('Session belongs to different origin'), {
        code: 'ERR_PERMISSION_DENIED',
      });
    }
    if (session.status === 'terminated') {
      throw Object.assign(new Error('Session has been terminated'), {
        code: 'ERR_SESSION_NOT_FOUND',
      });
    }

    // Check if session has expired
    if (session.capabilities.limits?.expiresAt && Date.now() > session.capabilities.limits.expiresAt) {
      this.terminateSession(sessionId, origin);
      throw Object.assign(new Error('Session has expired'), { code: 'ERR_SESSION_NOT_FOUND' });
    }

    return session;
  }

  /**
   * List sessions with optional filters.
   */
  listSessions(options: ListSessionsOptions = {}): SessionSummary[] {
    const results: SessionSummary[] = [];

    for (const session of this.sessions.values()) {
      // Apply filters
      if (options.origin && session.origin !== options.origin) continue;
      if (options.status && session.status !== options.status) continue;
      if (options.type && session.type !== options.type) continue;
      if (options.activeOnly && session.status !== 'active') continue;

      results.push(this.toSummary(session));
    }

    // Sort by lastActiveAt descending
    results.sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    return results;
  }

  /**
   * Get all sessions for an origin.
   */
  getSessionsForOrigin(origin: string): AgentSession[] {
    const results: AgentSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.origin === origin && session.status === 'active') {
        results.push(session);
      }
    }
    return results;
  }

  // ===========================================================================
  // Session Operations
  // ===========================================================================

  /**
   * Update session's last active time.
   */
  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActiveAt = Date.now();
    }
  }

  /**
   * Record a prompt in the session.
   */
  recordPrompt(sessionId: string, userMessage: string, assistantMessage: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.history.push({ role: 'user', content: userMessage });
    session.history.push({ role: 'assistant', content: assistantMessage });
    session.usage.promptCount++;
    session.lastActiveAt = Date.now();

    this.emit({
      type: 'session_capability_used',
      sessionId,
      capability: 'llm',
    });
  }

  /**
   * Record a tool call in the session.
   */
  recordToolCall(sessionId: string, toolName: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Check if we've exceeded the tool call limit. A limit of 0 allows no calls.
    const limit = session.capabilities.limits?.maxToolCalls;
    if (typeof limit === 'number' && session.usage.toolCallCount >= limit) {
      return false; // Budget exceeded
    }

    session.usage.toolCallCount++;
    session.lastActiveAt = Date.now();

    this.emit({
      type: 'session_capability_used',
      sessionId,
      capability: 'tool',
      detail: toolName,
    });

    return true;
  }

  /**
   * Record browser API usage in the session.
   */
  recordBrowserAccess(sessionId: string, action: 'read' | 'interact' | 'screenshot'): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.lastActiveAt = Date.now();

    this.emit({
      type: 'session_capability_used',
      sessionId,
      capability: 'browser',
      detail: action,
    });
  }

  /**
   * Add a message to session history.
   */
  addToHistory(sessionId: string, message: ConversationMessage): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.history.push(message);
      session.lastActiveAt = Date.now();
    }
  }

  /**
   * Get session history.
   */
  getHistory(sessionId: string): ConversationMessage[] {
    const session = this.sessions.get(sessionId);
    return session?.history ?? [];
  }

  // ===========================================================================
  // Session Lifecycle
  // ===========================================================================

  /**
   * Terminate a session.
   */
  terminateSession(sessionId: string, origin: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.origin !== origin) {
      return false;
    }

    session.status = 'terminated';
    if (session.tokenId) {
      Tokens.revoke(session.tokenId, 'session_terminated');
    }
    this.emit({ type: 'session_terminated', sessionId, origin });

    console.log('[SessionRegistry] Terminated session:', sessionId);
    return true;
  }

  /**
   * Destroy a session completely (remove from registry).
   */
  destroySession(sessionId: string, origin: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.origin !== origin) {
      return false;
    }

    if (session.tokenId) {
      Tokens.revoke(session.tokenId, 'session_destroyed');
    }
    this.sessions.delete(sessionId);
    this.emit({ type: 'session_terminated', sessionId, origin });

    console.log('[SessionRegistry] Destroyed session:', sessionId);
    return true;
  }

  /**
   * Clone a session (creates a new session with same options but fresh history).
   */
  cloneSession(sessionId: string, origin: string): string | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.origin !== origin) {
      return null;
    }

    if (session.type === 'implicit') {
      const newSession = this.createImplicitSession(origin, session.options, session.tabId);
      return newSession.sessionId;
    } else {
      const result = this.createExplicitSession(
        origin,
        {
          name: session.name ? `${session.name} (copy)` : undefined,
          reason: session.reason,
          capabilities: {
            llm: session.capabilities.llm.allowed
              ? { provider: session.capabilities.llm.provider, model: session.capabilities.llm.model }
              : undefined,
            tools: session.capabilities.tools.allowedTools,
            browser: [
              ...(session.capabilities.browser.readActiveTab ? ['read' as const] : []),
              ...(session.capabilities.browser.interact ? ['interact' as const] : []),
              ...(session.capabilities.browser.screenshot ? ['screenshot' as const] : []),
            ],
          },
          limits: session.capabilities.limits
            ? {
                maxToolCalls: session.capabilities.limits.maxToolCalls,
                ttlMinutes: session.capabilities.limits.expiresAt
                  ? Math.ceil((session.capabilities.limits.expiresAt - Date.now()) / 60000)
                  : undefined,
              }
            : undefined,
          options: session.options,
        },
        session.capabilities.tools.allowedTools,
        session.tabId,
      );
      return result.sessionId || null;
    }
  }

  // ===========================================================================
  // Capability Checking
  // ===========================================================================

  /**
   * Check if a session can use LLM.
   */
  canUseLLM(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') return false;
    return session.capabilities.llm.allowed;
  }

  /**
   * Check if a session can call a specific tool.
   */
  canCallTool(sessionId: string, toolName: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') return false;
    if (!session.capabilities.tools.allowed) return false;

    // Check if tool is in allowed list
    return session.capabilities.tools.allowedTools.includes(toolName);
  }

  /**
   * Check if a session can use a browser API.
   */
  canUseBrowser(sessionId: string, action: 'read' | 'interact' | 'screenshot'): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') return false;

    switch (action) {
      case 'read':
        return session.capabilities.browser.readActiveTab;
      case 'interact':
        return session.capabilities.browser.interact;
      case 'screenshot':
        return session.capabilities.browser.screenshot;
      default:
        return false;
    }
  }

  /**
   * Get remaining tool call budget for a session.
   */
  getRemainingToolBudget(sessionId: string): number | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const limit = session.capabilities.limits?.maxToolCalls;
    if (limit === undefined) return undefined;

    return Math.max(0, limit - session.usage.toolCallCount);
  }

  // ===========================================================================
  // Event System
  // ===========================================================================

  /**
   * Subscribe to session events.
   */
  subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[SessionRegistry] Event listener error:', err);
      }
    }
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  private startCleanupInterval(): void {
    if (this.cleanupIntervalId) return;

    this.cleanupIntervalId = setInterval(() => {
      this.cleanupOldSessions();
    }, 10 * 60 * 1000); // Every 10 minutes
  }

  private cleanupOldSessions(): void {
    const now = Date.now();
    const sessionsToRemove: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      // Remove terminated sessions after 5 minutes
      if (session.status === 'terminated' && now - session.lastActiveAt > 5 * 60 * 1000) {
        sessionsToRemove.push(sessionId);
        continue;
      }

      // Remove expired sessions
      if (session.capabilities.limits?.expiresAt && now > session.capabilities.limits.expiresAt) {
        session.status = 'terminated';
        this.emit({ type: 'session_terminated', sessionId, origin: session.origin });
        continue;
      }

      // Remove old inactive sessions
      if (now - session.lastActiveAt > this.SESSION_MAX_AGE_MS) {
        sessionsToRemove.push(sessionId);
      }
    }

    for (const sessionId of sessionsToRemove) {
      const session = this.sessions.get(sessionId);
      if (session?.tokenId) {
        Tokens.revoke(session.tokenId, 'session_cleanup');
      }
      this.sessions.delete(sessionId);
    }

    if (sessionsToRemove.length > 0) {
      console.log('[SessionRegistry] Cleaned up', sessionsToRemove.length, 'old sessions');
    }
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private toSummary(session: AgentSession): SessionSummary {
    return {
      sessionId: session.sessionId,
      type: session.type,
      origin: session.origin,
      status: session.status,
      mode: session.mode,
      tokenId: session.tokenId,
      name: session.name,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      capabilities: {
        hasLLM: session.capabilities.llm.allowed,
        toolCount: session.capabilities.tools.allowedTools.length,
        hasBrowserAccess:
          session.capabilities.browser.readActiveTab ||
          session.capabilities.browser.interact ||
          session.capabilities.browser.screenshot,
      },
      usage: session.usage,
    };
  }

  /**
   * Get statistics about the registry.
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    sessionsByOrigin: Record<string, number>;
    sessionsByType: Record<SessionType, number>;
  } {
    const stats = {
      totalSessions: this.sessions.size,
      activeSessions: 0,
      sessionsByOrigin: {} as Record<string, number>,
      sessionsByType: { implicit: 0, explicit: 0 } as Record<SessionType, number>,
    };

    for (const session of this.sessions.values()) {
      if (session.status === 'active') {
        stats.activeSessions++;
      }

      stats.sessionsByOrigin[session.origin] = (stats.sessionsByOrigin[session.origin] || 0) + 1;
      stats.sessionsByType[session.type]++;
    }

    return stats;
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Translate a SessionCapabilities object into the set of typed actions the
 * capability token should authorize. Keeps the legacy capability shape as
 * the source of truth for what the user agreed to; the engine's allowedActions
 * just mirror that decision in the typed-action vocabulary.
 */
function capabilitiesToActions(
  capabilities: SessionCapabilities,
  allowedToolsList: string[],
): TypedAction[] {
  const actions: TypedAction[] = [];

  if (capabilities.llm.allowed) {
    // Local prompts are always available. Remote first-party (the user's
    // configured provider) is added when the session asks for LLM at all,
    // since we don't know at session-creation time whether the chosen model
    // is local or remote. Third-party remote is never auto-granted; that
    // requires an explicit page-driven provider choice the engine gates
    // separately.
    actions.push('model.prompt.local');
    actions.push('model.prompt.remote.firstParty');
    actions.push('model.list');
  }

  if (capabilities.tools.allowed && allowedToolsList.length > 0) {
    actions.push('tool.list', 'tool.call');
  }

  if (capabilities.browser.readActiveTab) {
    actions.push('browser.read.activeTab', 'browser.read.element', 'browser.read.tabs');
  }
  if (capabilities.browser.interact) {
    actions.push('browser.write.interact');
  }
  if (capabilities.browser.screenshot) {
    actions.push('browser.read.screenshot');
  }

  // Same-origin egress is implicit for any session — it's how we fetch
  // from the page's own backend. Cross-origin is gated separately by
  // policy and never auto-granted by session creation.
  actions.push('network.egress.same_origin');

  return actions;
}

/**
 * Default accepted label set for a session of the given mode. Plan and
 * watch sessions never accept sensitive labels at the egress boundary; only
 * execute sessions can carry credentials/payments/identity into outgoing
 * requests, and even then only with explicit user consent.
 */
function defaultAcceptedLabelsForMode(mode: SessionMode): DataLabel[] {
  switch (mode) {
    case 'plan':
    case 'watch':
      return ['confidential'];
    case 'execute':
      return ['confidential', 'identity'];
    default:
      return ['confidential'];
  }
}

// =============================================================================
// Singleton Export
// =============================================================================

export const SessionRegistry = new SessionRegistryImpl();

// Export types for convenience
export type { AgentSession, SessionCapabilities, SessionSummary, CreateSessionOptions, CreateSessionResult };
