/**
 * Agent Session Types
 *
 * Types for the two-level permission model:
 * 1. Origin-level permissions (persistent) - can this origin access LLM/MCP/Browser?
 * 2. Session-level capabilities (ephemeral) - what can this specific agent do?
 */

import type { PermissionScope, PermissionGrant, ConversationMessage } from '../agents/types';

// =============================================================================
// Session Capability Types
// =============================================================================

/**
 * LLM capabilities for a session.
 */
export interface LLMCapabilities {
  /** Whether this session can use LLM */
  allowed: boolean;
  /** Specific provider instance ID, or undefined = user's default */
  provider?: string;
  /** Specific model ID, or undefined = provider's default */
  model?: string;
}

/**
 * MCP tool capabilities for a session.
 */
export interface ToolCapabilities {
  /** Whether this session can call tools */
  allowed: boolean;
  /** Specific tools this session can call (empty = none, undefined with allowed = all origin-allowed tools) */
  allowedTools: string[];
}

/**
 * Browser API capabilities for a session.
 */
export interface BrowserCapabilities {
  /** Can read active tab content (readability) */
  readActiveTab: boolean;
  /** Can interact with active tab (click, fill, scroll) */
  interact: boolean;
  /** Can take screenshots of active tab */
  screenshot: boolean;
}

/**
 * Session limits and budgets.
 */
export interface SessionLimits {
  /** Maximum tool calls allowed in this session */
  maxToolCalls?: number;
  /** When this session expires (timestamp) */
  expiresAt?: number;
  /** Maximum tokens/chars per prompt */
  maxPromptLength?: number;
}

/**
 * Full capability set for a session.
 */
export interface SessionCapabilities {
  llm: LLMCapabilities;
  tools: ToolCapabilities;
  browser: BrowserCapabilities;
  limits?: SessionLimits;
}

// =============================================================================
// Session Types
// =============================================================================

/**
 * Session status.
 */
export type SessionStatus = 'active' | 'suspended' | 'terminated';

/**
 * Session type - how was this session created?
 */
export type SessionType = 'implicit' | 'explicit';

/**
 * Agent session - tracks an active agent with its capabilities.
 */
export interface AgentSession {
  /** Unique session identifier */
  sessionId: string;

  /** Type: implicit (from ai.createTextSession) or explicit (from agent.sessions.create) */
  type: SessionType;

  /** Origin that created this session */
  origin: string;

  /** Tab ID if session is tab-scoped */
  tabId?: number;

  /** Session status */
  status: SessionStatus;

  /** When the session was created */
  createdAt: number;

  /** When the session was last active */
  lastActiveAt: number;

  /** Capabilities granted to this session */
  capabilities: SessionCapabilities;

  /** Human-readable name for display (explicit sessions) */
  name?: string;

  /** Reason provided when requesting capabilities */
  reason?: string;

  /** Conversation history (for text sessions) */
  history: ConversationMessage[];

  /** Session options (temperature, systemPrompt, etc.) */
  options: SessionOptions;

  /** Usage statistics */
  usage: SessionUsage;
}

/**
 * Session configuration options.
 */
export interface SessionOptions {
  /** System prompt for LLM */
  systemPrompt?: string;
  /** Temperature for generation */
  temperature?: number;
  /** Top-p for generation */
  top_p?: number;
}

/**
 * Session usage statistics.
 */
export interface SessionUsage {
  /** Number of prompts sent */
  promptCount: number;
  /** Number of tool calls made */
  toolCallCount: number;
  /** Approximate tokens used (if tracked) */
  tokensUsed?: number;
}

// =============================================================================
// Session Creation Types
// =============================================================================

/**
 * Options for creating an explicit session.
 */
export interface CreateSessionOptions {
  /** Human-readable name for display */
  name?: string;

  /** Reason for requesting these capabilities */
  reason?: string;

  /** Requested capabilities */
  capabilities: {
    /** LLM access */
    llm?: {
      provider?: string;
      model?: string;
    };
    /** Tool access - list of tool names to request */
    tools?: string[];
    /** Browser API access */
    browser?: ('read' | 'interact' | 'screenshot')[];
  };

  /** Session limits */
  limits?: {
    maxToolCalls?: number;
    /** Time-to-live in minutes */
    ttlMinutes?: number;
  };

  /** Session options (systemPrompt, temperature, etc.) */
  options?: SessionOptions;
}

/**
 * Result of creating a session.
 */
export interface CreateSessionResult {
  /** Whether creation succeeded */
  success: boolean;
  /** Session ID if successful */
  sessionId?: string;
  /** Granted capabilities (may be less than requested) */
  capabilities?: SessionCapabilities;
  /** Error if failed */
  error?: {
    code: 'PERMISSION_DENIED' | 'ORIGIN_DENIED' | 'INVALID_REQUEST';
    message: string;
  };
}

// =============================================================================
// Session Query Types
// =============================================================================

/**
 * Summary of a session for listing/display.
 */
export interface SessionSummary {
  sessionId: string;
  type: SessionType;
  origin: string;
  status: SessionStatus;
  name?: string;
  createdAt: number;
  lastActiveAt: number;
  capabilities: {
    hasLLM: boolean;
    toolCount: number;
    hasBrowserAccess: boolean;
  };
  usage: SessionUsage;
}

/**
 * Filter options for listing sessions.
 */
export interface ListSessionsOptions {
  /** Filter by origin */
  origin?: string;
  /** Filter by status */
  status?: SessionStatus;
  /** Filter by type */
  type?: SessionType;
  /** Include only active sessions (not terminated) */
  activeOnly?: boolean;
}

// =============================================================================
// Session Event Types
// =============================================================================

/**
 * Events emitted by the session registry.
 */
export type SessionEvent =
  | { type: 'session_created'; session: SessionSummary }
  | { type: 'session_updated'; session: SessionSummary }
  | { type: 'session_terminated'; sessionId: string; origin: string }
  | { type: 'session_capability_used'; sessionId: string; capability: 'llm' | 'tool' | 'browser'; detail?: string };

/**
 * Listener for session events.
 */
export type SessionEventListener = (event: SessionEvent) => void;

// =============================================================================
// Permission Bridge Types
// =============================================================================

/**
 * Maps permission scopes to session capabilities.
 * Used to check if origin has required permissions for requested capabilities.
 */
export const CAPABILITY_TO_SCOPES: Record<string, PermissionScope[]> = {
  'llm.allowed': ['model:prompt'],
  'tools.allowed': ['mcp:tools.call'],
  'tools.list': ['mcp:tools.list'],
  'browser.readActiveTab': ['browser:activeTab.read'],
  'browser.interact': ['browser:activeTab.interact'],
  'browser.screenshot': ['browser:activeTab.screenshot'],
};

/**
 * Default capabilities for implicit sessions (from ai.createTextSession).
 */
export function getDefaultImplicitCapabilities(): SessionCapabilities {
  return {
    llm: {
      allowed: true,
      // provider/model inherited from user's default
    },
    tools: {
      allowed: false,
      allowedTools: [],
    },
    browser: {
      readActiveTab: false,
      interact: false,
      screenshot: false,
    },
  };
}

/**
 * Default capabilities for explicit sessions with specific requests.
 */
export function buildCapabilitiesFromRequest(
  request: CreateSessionOptions['capabilities'],
  allowedTools: string[] = [],
): SessionCapabilities {
  return {
    llm: {
      allowed: request.llm !== undefined,
      provider: request.llm?.provider,
      model: request.llm?.model,
    },
    tools: {
      allowed: (request.tools?.length ?? 0) > 0,
      allowedTools: request.tools?.filter((t) => allowedTools.includes(t)) ?? [],
    },
    browser: {
      readActiveTab: request.browser?.includes('read') ?? false,
      interact: request.browser?.includes('interact') ?? false,
      screenshot: request.browser?.includes('screenshot') ?? false,
    },
  };
}
