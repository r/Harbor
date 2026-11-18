/**
 * In-process bridge from the page API to the rest of Harbor.
 *
 * Replaces the old Web Agents API's harbor-client.ts, which crossed an
 * extension boundary via chrome.runtime.sendMessage/connect to reach Harbor.
 * Everything here now runs inside Harbor's own background, so a page call
 * reaches exactly the handler a forwarded cross-extension call would have
 * reached — including the policy gate (gatePageCall/requireAction) and the
 * audit log, which record it the same way either way.
 *
 * This is the ONLY file under page-api/ allowed to import from outside
 * page-api/, browser-compat, or a type-only import (see
 * __tests__/import-boundary.test.ts). That keeps the rest of page-api/
 * swappable if the agent side (extension-api.ts, background-router.ts, ...)
 * changes shape later.
 */
import { routeExtensionApiMessage, streamLlmChat } from '../extension-api';
import { routeExternalMessage } from '../agents/background-router';
import { ErrorCodes } from './types';

// =============================================================================
// Types
// =============================================================================

export interface StreamEvent {
  type: 'token' | 'done' | 'error';
  token?: string;
  finish_reason?: string;
  model?: string;
  error?: { code: number; message: string };
}

/**
 * In-process dispatch doesn't need a real sender identity: the trust check
 * (isTrustedExtensionSender) only applies to the cross-extension listeners
 * in extension-api.ts, which this module bypasses entirely by calling the
 * router functions directly. Callers always pass the verified page origin
 * in the payload (see page-api/background.ts), exactly as a forwarded
 * cross-extension call does today.
 */
const PAGE_API_SENDER: { id?: string; url?: string; tab?: { id?: number } } = {};

// `llm.*`, `mcp.*`, `session.*`, `system.*` and `permissions.*` go through
// Harbor's extension-api router — the same gate (gatePageCall/requireAction)
// a forwarded Web Agents API call goes through today.
const EXTENSION_API_PREFIXES = ['llm.', 'mcp.', 'session.', 'system.', 'permissions.'];

function isExtensionApiType(type: string): boolean {
  return EXTENSION_API_PREFIXES.some((prefix) => type.startsWith(prefix));
}

function createError(message: string): Error & { code?: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = ErrorCodes.INTERNAL;
  return error;
}

// =============================================================================
// Request/Response
// =============================================================================

/** Default time limit for a call into the rest of Harbor. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Send a request to the rest of Harbor, in-process. Throws on failure, same
 * contract as the old cross-extension harborRequest, including its time
 * limit: 30 seconds unless the caller asks for longer (a permission prompt
 * waits on the user).
 */
export async function harborRequest<T = unknown>(
  type: string,
  payload?: unknown,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([dispatch<T>(type, payload), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function dispatch<T>(type: string, payload: unknown): Promise<T> {
  if (isExtensionApiType(type)) {
    const response = await routeExtensionApiMessage({ type, payload }, PAGE_API_SENDER);
    if (!response.ok) throw createError(response.error ?? 'Unknown error from Harbor');
    return response.result as T;
  }

  // agent.chat.*, agent.mcp.* and agents.* — the agent router's in-process
  // entry. routeExternalMessage itself does no sender-trust check (that
  // lives in extension-api.ts's onMessageExternal listener, which this call
  // bypasses); it only reads payload.origin/tabId, which background.ts
  // always sets from the connecting port's sender.
  return new Promise<T>((resolve, reject) => {
    routeExternalMessage(
      { type, payload },
      PAGE_API_SENDER as chrome.runtime.MessageSender,
      (response: { ok: boolean; result?: unknown; error?: string }) => {
        if (response.ok) resolve(response.result as T);
        else reject(createError(response.error ?? 'Unknown error from Harbor'));
      },
    );
  });
}

/**
 * Create a streaming request to the rest of Harbor. Only `llm.chatStream`
 * streams today. `requestId`, when given, becomes the audit record's
 * correlationId — pass the page's own request id for a readable activity
 * feed.
 */
export function harborStreamRequest(
  type: string,
  payload?: unknown,
  requestId?: string,
): { stream: AsyncIterable<StreamEvent>; cancel: () => void } {
  if (type !== 'llm.chatStream') {
    throw createError(`harborStreamRequest: unsupported streaming type "${type}"`);
  }

  const generator = streamLlmChat(payload, requestId);
  const stream: AsyncIterable<StreamEvent> = {
    [Symbol.asyncIterator]() {
      return generator as unknown as AsyncIterator<StreamEvent>;
    },
  };
  const cancel = () => {
    void generator.return(undefined);
  };
  return { stream, cancel };
}
