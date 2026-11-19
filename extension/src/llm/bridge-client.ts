/**
 * Bridge Client - Wrapper around native messaging bridge
 * 
 * This module provides a simplified interface for making RPC calls to the bridge.
 * All communication goes through the native messaging bridge (stdio).
 */

import {
  connectNativeBridge,
  getConnectionState,
  isNativeBridgeReady,
  onConnectionStateChange,
  rpcRequest,
  rpcStreamRequest,
  type ConnectionState,
} from './native-bridge';

// Re-export types
export type BridgeConnectionState = ConnectionState;

export type StreamEvent = {
  id: string;
  type: 'token' | 'done' | 'error';
  token?: string;
  finish_reason?: string;
  model?: string;
  error?: { code: number; message: string };
};

/**
 * Get the current bridge connection state
 */
export function getBridgeConnectionState(): BridgeConnectionState {
  return getConnectionState();
}

/**
 * Check bridge health by making a simple request
 */
export async function checkBridgeHealth(): Promise<boolean> {
  try {
    const result = await bridgeRequest<{ status: string }>('system.health');
    return result.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * Initialize the bridge client (connects to native bridge)
 */
export function initializeBridgeClient(): void {
  console.log('[Harbor] Initializing bridge client via native messaging');
  connectNativeBridge();
  
  // Log connection state changes
  onConnectionStateChange((state) => {
    console.log('[Harbor] Bridge connection state:', state.bridgeReady ? 'ready' : 'not ready');
  });
}

/**
 * Make an RPC request to the bridge
 */
export async function bridgeRequest<T>(method: string, params?: unknown): Promise<T> {
  if (!isNativeBridgeReady()) {
    throw new Error('Bridge not connected. Ensure native bridge is installed and running.');
  }

  return rpcRequest<T>(method, params);
}

/**
 * Make a streaming RPC request to the bridge
 * Returns an async generator that yields stream events
 */
export async function* bridgeStreamRequest(
  method: string,
  params?: unknown,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  // A caller that has already stopped listening never starts the stream.
  if (signal?.aborted) return;

  console.log('[Harbor:BridgeClient] bridgeStreamRequest called', {
    method,
    paramsKeys: params ? Object.keys(params as Record<string, unknown>) : [],
    bridgeReady: isNativeBridgeReady(),
  });
  
  if (!isNativeBridgeReady()) {
    console.error('[Harbor:BridgeClient] Bridge not ready for streaming');
    throw new Error('Bridge not connected. Ensure native bridge is installed and running.');
  }

  // Create a queue to buffer events
  const eventQueue: StreamEvent[] = [];
  let resolveWaiting: ((event: StreamEvent | null) => void) | null = null;
  let done = false;
  let error: Error | null = null;
  let tokenCount = 0;

  console.log('[Harbor:BridgeClient] Starting rpcStreamRequest');
  
  const { cancel, done: streamDone } = rpcStreamRequest(
    method,
    params,
    (event) => {
      if (event.type === 'token') {
        tokenCount++;
      } else {
        console.log('[Harbor:BridgeClient] Stream event:', event.type, 'tokenCount so far:', tokenCount);
      }
      
      if (resolveWaiting) {
        resolveWaiting(event);
        resolveWaiting = null;
      } else {
        eventQueue.push(event);
      }
    },
  );

  // The caller stopped listening: stop the stream in the bridge and end the
  // read now, even if it's waiting for the model's next event.
  const onAbort = () => {
    done = true;
    cancel();
    if (resolveWaiting) {
      resolveWaiting(null);
      resolveWaiting = null;
    }
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  // Handle completion
  streamDone
    .then(() => {
      console.log('[Harbor:BridgeClient] streamDone resolved', { tokenCount });
      done = true;
      if (resolveWaiting) {
        resolveWaiting(null);
        resolveWaiting = null;
      }
    })
    .catch((e) => {
      console.error('[Harbor:BridgeClient] streamDone error:', e);
      error = e;
      done = true;
      if (resolveWaiting) {
        resolveWaiting(null);
        resolveWaiting = null;
      }
    });

  try {
    while (true) {
      if (signal?.aborted) break;
      // Check for queued events first
      if (eventQueue.length > 0) {
        const event = eventQueue.shift()!;
        yield event;
        if (event.type === 'done' || event.type === 'error') {
          console.log('[Harbor:BridgeClient] Yielded terminal event', { type: event.type, tokenCount });
          break;
        }
        continue;
      }

      // Check if done
      if (done) {
        if (error) {
          console.error('[Harbor:BridgeClient] Stream completed with error:', error);
          throw error;
        }
        console.log('[Harbor:BridgeClient] Stream completed normally', { tokenCount });
        break;
      }

      // Wait for next event
      const event = await new Promise<StreamEvent | null>((resolve) => {
        resolveWaiting = resolve;
      });

      if (event === null) {
        if (error) {
          console.error('[Harbor:BridgeClient] Null event with error:', error);
          throw error;
        }
        console.log('[Harbor:BridgeClient] Null event, stream ending', { tokenCount });
        break;
      }

      yield event;
      if (event.type === 'done' || event.type === 'error') {
        console.log('[Harbor:BridgeClient] Yielded terminal event', { type: event.type, tokenCount });
        break;
      }
    }
  } finally {
    console.log('[Harbor:BridgeClient] bridgeStreamRequest cleanup', { tokenCount });
    signal?.removeEventListener('abort', onAbort);
    cancel();
  }
}
