/**
 * Native Messaging Bridge Client
 * 
 * All communication with the native bridge happens through this module via stdio.
 * Supports RPC requests, streaming responses, and console log forwarding.
 */

import { browserAPI } from '../browser-compat';

const NATIVE_APP_ID = 'harbor_bridge';

// Message types from bridge
type IncomingMessage = 
  | { type: 'status'; status: string; message: string }
  | { type: 'rpc_response'; id: string; result?: unknown; error?: { code: number; message: string } }
  | { type: 'stream'; id: string; event: StreamEvent }
  | { type: 'console'; server_id: string; level: string; message: string };

type StreamEvent = {
  id: string;
  type: 'token' | 'done' | 'error';
  token?: string;
  finish_reason?: string;
  model?: string;
  error?: { code: number; message: string };
};

// Pending RPC requests
type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

type PendingStream = {
  onEvent: (event: StreamEvent) => void;
  onComplete: () => void;
  onError: (error: Error) => void;
};

let nativePort: ReturnType<typeof browserAPI.runtime.connectNative> | null = null;
let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 3;
const RECONNECT_DELAY = 2000;

// Pending RPC requests waiting for responses
const pendingRequests = new Map<string, PendingRequest>();
const pendingStreams = new Map<string, PendingStream>();

// Console log listeners
type ConsoleLogListener = (serverId: string, level: string, message: string) => void;
const consoleLogListeners: ConsoleLogListener[] = [];

export type ConnectionState = {
  connected: boolean;
  bridgeReady: boolean;
  error: string | null;
};

let connectionState: ConnectionState = {
  connected: false,
  bridgeReady: false,
  error: null,
};

const connectionListeners: Array<(state: ConnectionState) => void> = [];

export function getConnectionState(): ConnectionState {
  return { ...connectionState };
}

export function onConnectionStateChange(listener: (state: ConnectionState) => void): () => void {
  connectionListeners.push(listener);
  listener(connectionState);
  return () => {
    const idx = connectionListeners.indexOf(listener);
    if (idx >= 0) connectionListeners.splice(idx, 1);
  };
}

function notifyConnectionListeners(): void {
  for (const listener of connectionListeners) {
    listener(connectionState);
  }
}

function updateState(update: Partial<ConnectionState>): void {
  connectionState = { ...connectionState, ...update };
  notifyConnectionListeners();
}

/**
 * Add a listener for console logs from JS servers
 */
export function onConsoleLog(listener: ConsoleLogListener): () => void {
  consoleLogListeners.push(listener);
  return () => {
    const idx = consoleLogListeners.indexOf(listener);
    if (idx >= 0) consoleLogListeners.splice(idx, 1);
  };
}

/**
 * Handle an incoming message from the native bridge
 */
function handleMessage(message: IncomingMessage): void {
  switch (message.type) {
    case 'status':
      if (message.status === 'ready' || message.status === 'pong') {
        updateState({ connected: true, bridgeReady: true, error: null });
        connectionAttempts = 0;
      } else if (message.status === 'error') {
        updateState({ connected: true, bridgeReady: false, error: message.message });
      }
      break;

    case 'rpc_response': {
      const pending = pendingRequests.get(message.id);
      if (pending) {
        pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
      break;
    }

    case 'stream': {
      const stream = pendingStreams.get(message.id);
      if (stream) {
        stream.onEvent(message.event);
        if (message.event.type === 'done' || message.event.type === 'error') {
          pendingStreams.delete(message.id);
          if (message.event.type === 'error' && message.event.error) {
            stream.onError(new Error(message.event.error.message));
          } else {
            stream.onComplete();
          }
        }
      }
      break;
    }

    case 'console': {
      // Log to browser console
      const level = message.level as 'log' | 'warn' | 'error' | 'info' | 'debug';
      console[level]?.(`[JS:${message.server_id}]`, message.message);
      
      // Notify listeners
      for (const listener of consoleLogListeners) {
        try {
          listener(message.server_id, message.level, message.message);
        } catch (e) {
          console.error('[Harbor] Console log listener error:', e);
        }
      }
      break;
    }
  }
}

/**
 * Connect to the native bridge application.
 */
export function connectNativeBridge(): void {
  if (nativePort) {
    console.log('[Harbor] Native bridge already connected');
    return;
  }

  console.log('[Harbor] Connecting to native bridge...');
  connectionAttempts++;

  try {
    nativePort = browserAPI.runtime.connectNative(NATIVE_APP_ID);

    nativePort.onMessage.addListener((message: IncomingMessage) => {
      console.debug('[Harbor] Native message:', message.type);
      handleMessage(message);
    });

    nativePort.onDisconnect.addListener(() => {
      const error = browserAPI.runtime.lastError;
      const errorMessage = error?.message || 'Native bridge disconnected';
      
      console.log('[Harbor] Native bridge disconnected:', errorMessage);
      
      nativePort = null;
      
      // Reject all pending requests
      for (const [id, pending] of pendingRequests) {
        pending.reject(new Error('Bridge disconnected'));
        pendingRequests.delete(id);
      }
      for (const [id, stream] of pendingStreams) {
        stream.onError(new Error('Bridge disconnected'));
        pendingStreams.delete(id);
      }
      
      updateState({
        connected: false,
        bridgeReady: false,
        error: errorMessage,
      });

      if (connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
        console.log(`[Harbor] Reconnecting in ${RECONNECT_DELAY}ms (attempt ${connectionAttempts}/${MAX_CONNECTION_ATTEMPTS})...`);
        setTimeout(connectNativeBridge, RECONNECT_DELAY);
      } else {
        console.log('[Harbor] Max reconnection attempts reached.');
        updateState({
          error: 'Native bridge not installed. Run: cd bridge-rs && ./install.sh',
        });
      }
    });

    // Send initial ping
    sendMessage({ type: 'ping' });
    
    updateState({ connected: true, error: null });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Failed to connect to native bridge';
    console.error('[Harbor] Failed to connect to native bridge:', errorMessage);
    
    updateState({
      connected: false,
      bridgeReady: false,
      error: errorMessage,
    });
  }
}

/**
 * Send a raw message to the native bridge
 */
function sendMessage(message: Record<string, unknown>): void {
  if (!nativePort) {
    console.warn('[Harbor] Cannot send message: not connected');
    return;
  }

  try {
    nativePort.postMessage(message);
  } catch (err) {
    console.error('[Harbor] Failed to send message:', err);
  }
}

/**
 * Make an RPC request to the bridge
 */
export async function rpcRequest<T>(method: string, params?: unknown): Promise<T> {
  if (!nativePort || !connectionState.bridgeReady) {
    throw new Error('Bridge not connected');
  }

  const id = crypto.randomUUID();
  
  return new Promise<T>((resolve, reject) => {
    // Set up timeout (120 seconds for slow MCP tools like Gmail)
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('RPC request timed out'));
    }, 120000);

    pendingRequests.set(id, {
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result as T);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });

    sendMessage({
      type: 'rpc',
      id,
      method,
      params: params ?? {},
    });
  });
}

/**
 * Make a streaming RPC request to the bridge
 */
export function rpcStreamRequest(
  method: string,
  params: unknown,
  onEvent: (event: StreamEvent) => void,
): { cancel: () => void; done: Promise<void> } {
  if (!nativePort || !connectionState.bridgeReady) {
    const error = new Error('Bridge not connected');
    return {
      cancel: () => {},
      done: Promise.reject(error),
    };
  }

  const id = crypto.randomUUID();
  
  const done = new Promise<void>((resolve, reject) => {
    pendingStreams.set(id, {
      onEvent,
      onComplete: resolve,
      onError: reject,
    });
  });

  sendMessage({
    type: 'rpc',
    id,
    method,
    params: params ?? {},
  });

  return {
    cancel: () => {
      pendingStreams.delete(id);
      // Note: we don't have a way to cancel the stream on the bridge side yet
    },
    done,
  };
}

/**
 * Disconnect from the native bridge.
 */
export function disconnectNativeBridge(): void {
  if (nativePort) {
    nativePort.disconnect();
    nativePort = null;
  }
  updateState({
    connected: false,
    bridgeReady: false,
    error: null,
  });
}

/**
 * Check if the native bridge is ready.
 */
export function isNativeBridgeReady(): boolean {
  return connectionState.connected && connectionState.bridgeReady;
}
