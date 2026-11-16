/**
 * Shared handler types for the Web Agents API background script.
 */

import type { TransportResponse, PermissionScope, PermissionGrantType } from '../types';

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
// Permission Types (for handlers)
// =============================================================================

export interface StoredPermissions {
  scopes: Record<PermissionScope, { type: PermissionGrantType; expiresAt?: number; grantedAt: number }>;
  allowedTools?: string[];
}

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
