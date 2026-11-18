/**
 * In-process bridge from the page API to the rest of Harbor.
 *
 * Replaces the old Web Agents API's harbor-client.ts, which crossed an
 * extension boundary via chrome.runtime.sendMessage/connect to reach Harbor.
 * Everything here now runs inside Harbor's own background, so a page call
 * reaches the same handler through the same policy gate
 * (gatePageCall/requireAction) and the same audit log as any other call
 * into Harbor's agent router or extension API.
 *
 * This is the ONLY file under page-api/ allowed to import from outside
 * page-api/, browser-compat, or a type-only import (see
 * __tests__/import-boundary.test.ts). That keeps the rest of page-api/
 * swappable if the agent side (extension-api.ts, background-router.ts, ...)
 * changes shape later.
 */
import { routeExtensionApiMessage, streamLlmChat } from '../extension-api';
import { routeAgentMessage } from '../agents/background-router';
import { browserAPI } from '../browser-compat';
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
 * In-process dispatch doesn't need a real sender identity: Harbor accepts
 * no cross-extension messages, so there is no sender trust check left to
 * satisfy. Callers always pass the verified page origin in the payload
 * (see page-api/background.ts), which is what `gatePageCall`/`requireAction`
 * and `routeAgentMessage` actually check.
 *
 * `id` carries Harbor's own extension id purely so `routeExtensionApiMessage`'s
 * request log line has something to print.
 */
const PAGE_API_SENDER: { id?: string; url?: string; tab?: { id?: number } } = {
  id: browserAPI.runtime?.id,
};

// `llm.*`, `mcp.*`, `session.*`, `system.*` and `permissions.*` go through
// Harbor's extension-api router, gated by gatePageCall/requireAction.
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
  // entry. routeAgentMessage only reads payload.origin/tabId, which
  // background.ts always sets from the connecting port's sender, and
  // rejects a call with no origin.
  return new Promise<T>((resolve, reject) => {
    routeAgentMessage(
      { type, payload },
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
