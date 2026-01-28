/**
 * Web Agent API Transport Layer
 *
 * Handles bidirectional message passing between:
 * - Injected script (web page context) <-> Content script
 * - Content script <-> Background script
 *
 * Supports both request/response and streaming patterns.
 */

import { browserAPI } from '../browser-compat';
import type {
  TransportRequest,
  TransportResponse,
  TransportStreamEvent,
  MessageType,
  RunEvent,
  StreamToken,
  ApiError,
} from './types';

const CHANNEL = 'harbor_web_agent';

// =============================================================================
// Injected Script Transport (Page -> Content Script)
// =============================================================================

type StreamCallback = (event: RunEvent | StreamToken, done: boolean) => void;

const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}>();

const streamListeners = new Map<string, StreamCallback>();

/**
 * Initialize the transport in the injected script context.
 * Sets up listener for responses from content script.
 */
export function initInjectedTransport(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;

    const data = event.data as {
      channel?: string;
      response?: TransportResponse;
      streamEvent?: TransportStreamEvent;
    };

    if (data?.channel !== CHANNEL) return;

    // Handle regular response
    if (data.response) {
      const pending = pendingRequests.get(data.response.id);
      if (pending) {
        pendingRequests.delete(data.response.id);
        if (data.response.ok) {
          pending.resolve(data.response.result);
        } else {
          const err = new Error(data.response.error?.message || 'Request failed');
          (err as Error & { code?: string }).code = data.response.error?.code;
          pending.reject(err);
        }
      }
    }

    // Handle stream event
    if (data.streamEvent) {
      const listener = streamListeners.get(data.streamEvent.id);
      if (listener) {
        listener(data.streamEvent.event, data.streamEvent.done || false);
        if (data.streamEvent.done) {
          streamListeners.delete(data.streamEvent.id);
        }
      }
    }
  });
}

/**
 * Send a request from injected script to background via content script.
 */
export function sendRequest<T>(type: MessageType, payload?: unknown): Promise<T> {
  const id = crypto.randomUUID();
  const request: TransportRequest = { id, type, payload };

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });

    window.postMessage({ channel: CHANNEL, request }, '*');

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }
    }, 30000);
  });
}

/**
 * Create an async iterable for streaming responses.
 * Used by agent.run() and session.promptStreaming().
 */
export function createStreamIterable<T extends RunEvent | StreamToken>(
  type: MessageType,
  payload?: unknown,
): AsyncIterable<T> {
  const id = crypto.randomUUID();
  const request: TransportRequest = { id, type, payload };

  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const queue: T[] = [];
      let resolveNext: ((result: IteratorResult<T>) => void) | null = null;
      let done = false;
      let error: Error | null = null;

      // Register stream listener before sending request
      streamListeners.set(id, (event, isDone) => {
        if (isDone) {
          done = true;
          streamListeners.delete(id);
        }

        // Check for error event
        if ('type' in event && event.type === 'error') {
          error = new Error((event as { error?: ApiError }).error?.message || 'Stream error');
          done = true;
        }

        if (resolveNext) {
          if (error) {
            // Don't resolve, let next() throw
          } else {
            resolveNext({ done: false, value: event as T });
            resolveNext = null;
          }
        } else {
          queue.push(event as T);
        }
      });

      // Send the request
      window.postMessage({ channel: CHANNEL, request }, '*');

      return {
        async next(): Promise<IteratorResult<T>> {
          if (error) {
            throw error;
          }

          if (queue.length > 0) {
            return { done: false, value: queue.shift()! };
          }

          if (done) {
            return { done: true, value: undefined };
          }

          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },

        async return(): Promise<IteratorResult<T>> {
          done = true;
          streamListeners.delete(id);
          // Send abort signal to background
          window.postMessage({
            channel: CHANNEL,
            abort: { id },
          }, '*');
          return { done: true, value: undefined };
        },
      };
    },
  };
}

// =============================================================================
// Content Script Transport (Content Script <-> Background)
// =============================================================================

type RuntimePort = ReturnType<typeof browserAPI.runtime.connect>;

let backgroundPort: RuntimePort | null = null;
const pendingBackgroundRequests = new Map<string, {
  sendResponse: (response: TransportResponse) => void;
}>();
const activeStreams = new Map<string, {
  sendEvent: (event: TransportStreamEvent) => void;
}>();

/**
 * Initialize the content script transport.
 * Bridges messages between page and background script.
 */
export function initContentScriptTransport(): void {
  // Connect to background script
  backgroundPort = browserAPI.runtime.connect({ name: 'web-agent-transport' });

  // Handle messages from background
  backgroundPort.onMessage.addListener((message: TransportResponse | TransportStreamEvent) => {
    if ('ok' in message) {
      // Regular response
      const pending = pendingBackgroundRequests.get(message.id);
      if (pending) {
        pendingBackgroundRequests.delete(message.id);
        pending.sendResponse(message);
      }
    } else if ('event' in message) {
      // Stream event
      const stream = activeStreams.get(message.id);
      if (stream) {
        stream.sendEvent(message);
        if (message.done) {
          activeStreams.delete(message.id);
        }
      }
    }
  });

  backgroundPort.onDisconnect.addListener(() => {
    backgroundPort = null;
    // Reject all pending requests
    for (const [id, pending] of pendingBackgroundRequests) {
      pending.sendResponse({
        id,
        ok: false,
        error: { code: 'ERR_INTERNAL', message: 'Background connection lost' },
      });
    }
    pendingBackgroundRequests.clear();
    activeStreams.clear();
  });

  // Listen for messages from page
  window.addEventListener('message', async (event: MessageEvent) => {
    if (event.source !== window) return;

    const data = event.data as {
      channel?: string;
      request?: TransportRequest;
      abort?: { id: string };
    };

    if (data?.channel !== CHANNEL) return;

    // Handle abort signal
    if (data.abort) {
      backgroundPort?.postMessage({ type: 'abort', id: data.abort.id });
      activeStreams.delete(data.abort.id);
      return;
    }

    if (!data.request) return;

    const request = data.request;
    const isStreamingRequest = request.type === 'agent.run' || request.type === 'session.promptStreaming';

    if (!backgroundPort) {
      // Try to reconnect
      backgroundPort = browserAPI.runtime.connect({ name: 'web-agent-transport' });
    }

    if (isStreamingRequest) {
      // Set up stream forwarding
      activeStreams.set(request.id, {
        sendEvent: (streamEvent) => {
          window.postMessage({ channel: CHANNEL, streamEvent }, '*');
        },
      });
    } else {
      // Set up response forwarding
      pendingBackgroundRequests.set(request.id, {
        sendResponse: (response) => {
          window.postMessage({ channel: CHANNEL, response }, '*');
        },
      });
    }

    // Forward to background with origin
    backgroundPort.postMessage({
      ...request,
      origin: window.location.origin,
    });
  });
}

// =============================================================================
// Background Script Transport Helpers
// =============================================================================

export interface BackgroundRequestContext {
  id: string;
  type: MessageType;
  payload: unknown;
  origin: string;
  tabId?: number;
}

export type BackgroundHandler = (
  ctx: BackgroundRequestContext,
) => Promise<unknown> | AsyncIterable<RunEvent | StreamToken>;

export type BackgroundStreamHandler = (
  ctx: BackgroundRequestContext,
  emit: (event: RunEvent | StreamToken) => void,
  signal: AbortSignal,
) => Promise<void>;

/**
 * Create a handler map for background script message routing.
 */
export function createBackgroundRouter(
  handlers: Record<MessageType, BackgroundHandler>,
) {
  const abortControllers = new Map<string, AbortController>();

  return {
    handleConnection(port: RuntimePort) {
      const tabId = port.sender?.tab?.id;

      port.onMessage.addListener(async (message: TransportRequest & { origin?: string; type?: string | 'abort' }) => {
        // Handle abort
        if ((message.type as string) === 'abort') {
          const controller = abortControllers.get(message.id);
          if (controller) {
            controller.abort();
            abortControllers.delete(message.id);
          }
          return;
        }

        const ctx: BackgroundRequestContext = {
          id: message.id,
          type: message.type as MessageType,
          payload: message.payload,
          origin: message.origin || 'unknown',
          tabId,
        };

        const handler = handlers[ctx.type];
        if (!handler) {
          port.postMessage({
            id: ctx.id,
            ok: false,
            error: { code: 'ERR_NOT_IMPLEMENTED', message: `Unknown method: ${ctx.type}` },
          } satisfies TransportResponse);
          return;
        }

        try {
          const result = await handler(ctx);

          // Check if it's an async iterable (streaming)
          if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
            const controller = new AbortController();
            abortControllers.set(ctx.id, controller);

            try {
              for await (const event of result as AsyncIterable<RunEvent | StreamToken>) {
                if (controller.signal.aborted) break;

                const isDone = 'type' in event && (event.type === 'final' || event.type === 'error' || event.type === 'done');
                port.postMessage({
                  id: ctx.id,
                  event,
                  done: isDone,
                } satisfies TransportStreamEvent);

                if (isDone) break;
              }
            } finally {
              abortControllers.delete(ctx.id);
            }
          } else {
            // Regular promise
            const value = await result;
            port.postMessage({
              id: ctx.id,
              ok: true,
              result: value,
            } satisfies TransportResponse);
          }
        } catch (err) {
          const error = err as Error & { code?: string };
          port.postMessage({
            id: ctx.id,
            ok: false,
            error: {
              code: (error.code as ApiError['code']) || 'ERR_INTERNAL',
              message: error.message || 'Unknown error',
            },
          } satisfies TransportResponse);
        }
      });

      port.onDisconnect.addListener(() => {
        // Abort all streams for this port
        // In practice, we'd need to track which streams belong to which port
      });
    },
  };
}
