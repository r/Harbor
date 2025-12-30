/**
 * Chat Session - manages conversation state.
 * 
 * Each session tracks:
 * - Conversation messages
 * - Enabled MCP servers
 * - Session metadata
 */

import { ChatMessage } from '../llm/index.js';

/**
 * A chat session.
 */
export interface ChatSession {
  /** Unique session ID */
  id: string;
  
  /** Human-readable name */
  name: string;
  
  /** Conversation messages */
  messages: ChatMessage[];
  
  /** IDs of MCP servers enabled for this session */
  enabledServers: string[];
  
  /** System prompt for this session */
  systemPrompt?: string;
  
  /** When the session was created */
  createdAt: number;
  
  /** When the session was last updated */
  updatedAt: number;
  
  /** Session configuration */
  config: SessionConfig;
}

/**
 * Session configuration options.
 */
export interface SessionConfig {
  /** Maximum iterations for the agent loop */
  maxIterations: number;
  
  /** LLM model to use (or default) */
  model?: string;
  
  /** Temperature for LLM */
  temperature?: number;
  
  /** Max tokens per response */
  maxTokens?: number;
  
  /** Whether to use the tool router for smart server selection */
  useToolRouter?: boolean;
}

/**
 * Default session configuration.
 */
export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  maxIterations: 10,
  temperature: 0.7,
  maxTokens: 2048,
  useToolRouter: true, // On by default
};

/**
 * Generate a unique session ID.
 */
export function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a new chat session.
 */
export function createSession(
  enabledServers: string[] = [],
  options: Partial<{
    name: string;
    systemPrompt: string;
    config: Partial<SessionConfig>;
  }> = {}
): ChatSession {
  return {
    id: generateSessionId(),
    name: options.name || `Chat ${new Date().toLocaleTimeString()}`,
    messages: [],
    enabledServers,
    systemPrompt: options.systemPrompt,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    config: {
      ...DEFAULT_SESSION_CONFIG,
      ...options.config,
    },
  };
}

/**
 * Add a message to a session.
 */
export function addMessage(session: ChatSession, message: ChatMessage): void {
  session.messages.push(message);
  session.updatedAt = Date.now();
}

/**
 * Get the last N messages from a session.
 */
export function getRecentMessages(session: ChatSession, count: number): ChatMessage[] {
  return session.messages.slice(-count);
}

/**
 * Clear all messages from a session.
 */
export function clearMessages(session: ChatSession): void {
  session.messages = [];
  session.updatedAt = Date.now();
}

/**
 * Clone a session (for forking conversations).
 */
export function cloneSession(session: ChatSession): ChatSession {
  return {
    ...session,
    id: generateSessionId(),
    name: `${session.name} (copy)`,
    messages: [...session.messages],
    enabledServers: [...session.enabledServers],
    config: { ...session.config },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Serialize a session for storage.
 */
export function serializeSession(session: ChatSession): string {
  return JSON.stringify(session);
}

/**
 * Deserialize a session from storage.
 */
export function deserializeSession(data: string): ChatSession {
  return JSON.parse(data);
}

