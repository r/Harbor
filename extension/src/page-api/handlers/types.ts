/**
 * Shared handler types for the Web Agents API background script.
 */

import type { TransportResponse } from '../types';

// =============================================================================
// Request Context
// =============================================================================

/**
 * Context passed to every message handler.
 */
export interface RequestContext {
  /** Unique request ID for correlation */
  id: string;
  /** Message type (e.g., 'ai.createTextSession', 'agent.tools.list') */
  type: string;
  /** Request payload */
  payload: unknown;
  /** Origin of the requesting page */
  origin: string;
  /** Tab ID of the requesting page (if available) */
  tabId?: number;
  /** Firefox container ID - used to open new tabs in the same container */
  cookieStoreId?: string;
  /**
   * Aborts if the page's own request times out, or it posts an explicit
   * abort for this request id (background.ts's port listener sets this for
   * every request). Handlers pass it on their calls into the rest of Harbor
   * so a call the page stopped waiting for during Harbor's policy check
   * isn't performed. Handlers that keep background work running past a
   * single request/response round trip (the ACP backend's
   * `ai.createTextSession`/`session.prompt`) also read it so a page-side
   * timeout cancels that work, instead of leaving it running.
   */
  signal?: AbortSignal;
}

/**
 * Response returned by handlers.
 */
export type HandlerResponse = Promise<TransportResponse>;

/**
 * Handler function signature.
 */
export type MessageHandler = (ctx: RequestContext) => HandlerResponse;

/**
 * Handler registry type.
 */
export type HandlerRegistry = Map<string, MessageHandler>;

// =============================================================================
// Session State
// =============================================================================

export interface TextSessionState {
  sessionId: string;
  origin: string;
  options: Record<string, unknown>;
  history: Array<{ role: string; content: string }>;
  createdAt: number;
  /** Created by agent.sessions.create; Harbor's registry is the authority on it. */
  explicit?: boolean;
  /** An explicit session created with model access (`capabilities.llm`). */
  hasLLM?: boolean;
}

// =============================================================================
// Error Helpers
// =============================================================================

export function errorResponse(
  id: string,
  code: string,
  message: string
): TransportResponse {
  return { id, ok: false, error: { code, message } };
}

export function successResponse<T>(id: string, result: T): TransportResponse {
  return { id, ok: true, result };
}
