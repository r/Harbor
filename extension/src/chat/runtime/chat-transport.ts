import { browserAPI } from '../../browser-compat';
import type { SourceTabReference } from '../contracts';
import {
  CHAT_TRANSPORT_PORT_NAME,
  type ChatTransportMessage,
  type ChatTransportResponse,
  type ChatTransportStreamEvent,
} from './transport-protocol';

type RuntimePort = ReturnType<typeof browserAPI.runtime.connect>;

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type PendingStream = {
  events: unknown[];
  waiters: Array<(result: IteratorResult<unknown>) => void>;
  done: boolean;
  error?: Error;
};

export type ChatTransport = {
  request<Result>(
    type: string,
    payload?: unknown,
    source?: SourceTabReference,
  ): Promise<Result>;
  stream<Event>(
    type: string,
    payload?: unknown,
    source?: SourceTabReference,
    signal?: AbortSignal,
  ): AsyncIterable<Event>;
  disconnect(): void;
};

export function createChatTransport(
  port: RuntimePort = browserAPI.runtime.connect({
    name: CHAT_TRANSPORT_PORT_NAME,
  }),
): ChatTransport {
  const pendingRequests = new Map<string, PendingRequest>();
  const pendingStreams = new Map<string, PendingStream>();

  port.onMessage.addListener((message: unknown) => {
    if (isTransportResponse(message)) {
      settleRequest(message);
      return;
    }
    if (isTransportStreamEvent(message)) {
      settleStream(message);
    }
  });

  port.onDisconnect.addListener(() => {
    const error = new Error('Harbor chat transport disconnected');
    for (const request of pendingRequests.values()) {
      clearTimeout(request.timeoutId);
      request.reject(error);
    }
    pendingRequests.clear();

    for (const stream of pendingStreams.values()) {
      stream.error = error;
      flushStream(stream);
    }
    pendingStreams.clear();
  });

  function settleRequest(message: ChatTransportResponse): void {
    const pending = pendingRequests.get(message.id);
    if (!pending) {
      const stream = pendingStreams.get(message.id);
      if (stream && !message.ok) {
        stream.error = createTransportError(message);
        stream.done = true;
        flushStream(stream);
        pendingStreams.delete(message.id);
      }
      return;
    }

    pendingRequests.delete(message.id);
    clearTimeout(pending.timeoutId);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(createTransportError(message));
    }
  }

  function settleStream(message: ChatTransportStreamEvent): void {
    const stream = pendingStreams.get(message.id);
    if (!stream) {
      return;
    }

    if (message.event !== undefined) {
      stream.events.push(message.event);
    }
    stream.done = message.done === true;
    flushStream(stream);
    if (stream.done && stream.events.length === 0) {
      pendingStreams.delete(message.id);
    }
  }

  return {
    request<Result>(
      type: string,
      payload?: unknown,
      source?: SourceTabReference,
    ): Promise<Result> {
      const id = crypto.randomUUID();
      return new Promise<Result>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error(`Harbor chat request timed out: ${type}`));
        }, 30_000);

        pendingRequests.set(id, {
          resolve,
          reject,
          timeoutId,
        });
        port.postMessage({ id, type, payload, source } satisfies ChatTransportMessage);
      });
    },

    stream<Event>(
      type: string,
      payload?: unknown,
      source?: SourceTabReference,
      signal?: AbortSignal,
    ): AsyncIterable<Event> {
      const id = crypto.randomUUID();
      const state: PendingStream = {
        events: [],
        waiters: [],
        done: false,
      };
      pendingStreams.set(id, state);
      port.postMessage({ id, type, payload, source } satisfies ChatTransportMessage);

      const abortStream = () => {
        if (state.done) {
          return;
        }
        state.error = Object.assign(new Error('Chat run cancelled'), {
          name: 'AbortError',
        });
        state.done = true;
        port.postMessage({ id, type: 'abort' } satisfies ChatTransportMessage);
        flushStream(state);
        pendingStreams.delete(id);
      };

      if (signal?.aborted) {
        abortStream();
      } else {
        signal?.addEventListener('abort', abortStream, { once: true });
      }

      return {
        [Symbol.asyncIterator](): AsyncIterator<Event> {
          return {
            next() {
              if (state.events.length > 0) {
                return Promise.resolve({
                  value: state.events.shift() as Event,
                  done: false,
                });
              }
              if (state.error) {
                return Promise.reject(state.error);
              }
              if (state.done) {
                pendingStreams.delete(id);
                return Promise.resolve({
                  value: undefined,
                  done: true,
                });
              }

              return new Promise<IteratorResult<Event>>((resolve, reject) => {
                state.waiters.push(result => {
                  if (state.error) {
                    reject(state.error);
                    return;
                  }
                  resolve(result as IteratorResult<Event>);
                });
              });
            },
          };
        },
      };
    },

    disconnect() {
      port.disconnect();
    },
  };
}

function flushStream(stream: PendingStream): void {
  while (stream.waiters.length > 0) {
    const resolve = stream.waiters.shift();
    if (!resolve) {
      return;
    }

    if (stream.events.length > 0) {
      resolve({
        value: stream.events.shift(),
        done: false,
      });
      continue;
    }

    if (stream.done || stream.error) {
      resolve({
        value: undefined,
        done: true,
      });
      continue;
    }

    stream.waiters.unshift(resolve);
    return;
  }
}

function createTransportError(message: ChatTransportResponse): Error {
  return Object.assign(
    new Error(message.error?.message || 'Harbor chat request failed'),
    { code: message.error?.code },
  );
}

function isTransportResponse(
  value: unknown,
): value is ChatTransportResponse {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { ok?: unknown }).ok === 'boolean',
  );
}

function isTransportStreamEvent(
  value: unknown,
): value is ChatTransportStreamEvent {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as { id?: unknown }).id === 'string'
    && 'event' in value,
  );
}
