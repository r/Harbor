/**
 * Native Messaging Bridge Client
 * 
 * All communication with the native bridge happens through this module via stdio.
 * Supports RPC requests, streaming responses, and console log forwarding.
 * 
 * When the bridge sends host_request (MCP server wants browser to open a tab and
 * return content/cookies), we forward to Web Agents and send host_response back.
 * 
 * Safari uses HTTP to localhost (avoids sandbox restrictions).
 * Firefox/Chrome use connectNative() for a persistent port connection.
 */

import { browserAPI, isSafari } from '../browser-compat';
import { handleHostRequest } from '../handlers/host-request-handlers';

// Native app ID differs by browser:
// - Firefox/Chrome: 'harbor_bridge' (matches native messaging manifest name)
// - Safari: App bundle identifier (messages go to the containing app)
const NATIVE_APP_ID_DEFAULT = 'harbor_bridge';
const NATIVE_APP_ID_SAFARI = 'org.harbor';

// Safari detection - cached at module load time
const useSafariMode = isSafari();
const NATIVE_APP_ID = useSafariMode ? NATIVE_APP_ID_SAFARI : NATIVE_APP_ID_DEFAULT;

// HTTP server port for Safari communication
const SAFARI_HTTP_PORT = 8766;
const SAFARI_HTTP_BASE = `http://127.0.0.1:${SAFARI_HTTP_PORT}`;

/**
 * Safari-specific: Send RPC request via HTTP to harbor-bridge server.
 * This avoids sandbox restrictions with native messaging.
 */
async function safariHttpRequest<T>(method: string, params: unknown = {}): Promise<T> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  console.log('[Harbor:Safari] HTTP RPC request:', method, id);
  
  try {
    const response = await fetch(`${SAFARI_HTTP_BASE}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id,
        method,
        params,
      }),
    });
    
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${response.statusText} - ${text}`);
    }
    
    const data = await response.json();
    console.log('[Harbor:Safari] HTTP RPC response:', JSON.stringify(data).slice(0, 200));
    
    if (data && data.error) {
      const errorMsg = data.error.message || (typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
      throw new Error(errorMsg);
    }
    
    // Handle case where result might be undefined (some methods return void)
    return (data?.result ?? null) as T;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[Harbor:Safari] HTTP RPC error:', errorMsg);
    throw err instanceof Error ? err : new Error(errorMsg);
  }
}

/**
 * Safari-specific: Check if HTTP server is available
 */
async function safariCheckHttpServer(): Promise<boolean> {
  try {
    console.log('[Harbor:Safari] Checking HTTP server at', SAFARI_HTTP_BASE);
    const response = await fetch(`${SAFARI_HTTP_BASE}/health`, {
      method: 'GET',
    });
    console.log('[Harbor:Safari] Health check response:', response.ok, response.status);
    return response.ok;
  } catch (err) {
    console.error('[Harbor:Safari] Health check failed:', err);
    return false;
  }
}

/**
 * Safari-specific: Check connection and update state
 */
async function checkSafariConnection(): Promise<void> {
  try {
    const available = await safariCheckHttpServer();
    if (!available) {
      console.log('[Harbor:Safari] Bridge not available');
      updateState({
        connected: false,
        bridgeReady: false,
        error: 'Harbor.app not running',
      });
      return;
    }
    
    // If already connected and ready, skip RPC check (health endpoint worked)
    if (connectionState.connected && connectionState.bridgeReady) {
      return;
    }
    
    console.log('[Harbor:Safari] HTTP server available, testing RPC...');
    const response = await safariHttpRequest<{ status: string }>('system.health', {});
    console.log('[Harbor:Safari] Health check response:', response);
    
    const wasDisconnected = !connectionState.connected;
    updateState({ connected: true, bridgeReady: true, error: null });
    
    if (wasDisconnected) {
      console.log('[Harbor:Safari] Bridge connected!');
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[Harbor:Safari] Connection check failed:', errorMsg);
    
    updateState({
      connected: false,
      bridgeReady: false,
      error: `Safari: ${errorMsg}`,
    });
  }
}

// Message types from bridge
export type HostRequestContext = { origin?: string; tabId?: number };

export type HostRequestMessage = {
  type: 'host_request';
  id: string;
  method: string;
  params: Record<string, unknown>;
  context?: HostRequestContext;
};

type IncomingMessage =
  | { type: 'status'; status: string; message: string }
  | { type: 'rpc_response'; id: string; result?: unknown; error?: { code: number; message: string } }
  | { type: 'stream'; id: string; event: StreamEvent }
  | { type: 'console'; server_id: string; level: string; message: string }
  | HostRequestMessage;

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
  // Log all incoming messages for debugging (except high-frequency ones)
  if (message.type !== 'console' && !(message.type === 'stream' && (message as { event?: { type: string } }).event?.type === 'token')) {
    console.log('[Harbor:NativeBridge] Received message:', {
      type: message.type,
      id: (message as { id?: string }).id,
      eventType: (message as { event?: { type: string } }).event?.type,
    });
  }
  
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
      console.log('[Harbor:NativeBridge] RPC response:', {
        id: message.id,
        hasError: !!message.error,
        hasPendingRequest: pendingRequests.has(message.id),
        hasPendingStream: pendingStreams.has(message.id),
      });
      const pending = pendingRequests.get(message.id);
      if (pending) {
        pendingRequests.delete(message.id);
        if (message.error) {
          console.log('[Harbor:NativeBridge] RPC error:', message.error);
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      } else if (pendingStreams.has(message.id)) {
        // The bridge returned an rpc_response for a streaming request - this might indicate an error
        console.log('[Harbor:NativeBridge] Got rpc_response for stream request:', message.id, 'error:', message.error);
        const stream = pendingStreams.get(message.id);
        if (stream && message.error) {
          pendingStreams.delete(message.id);
          stream.onError(new Error(message.error.message));
        }
      }
      break;
    }

    case 'stream': {
      console.log('[Harbor:NativeBridge] Stream event received:', {
        id: message.id,
        eventType: message.event?.type,
        hasToken: !!message.event?.token,
        hasPendingStream: pendingStreams.has(message.id),
      });
      const stream = pendingStreams.get(message.id);
      if (stream) {
        stream.onEvent(message.event);
        if (message.event.type === 'done' || message.event.type === 'error') {
          console.log('[Harbor:NativeBridge] Stream completed:', message.id, message.event.type);
          pendingStreams.delete(message.id);
          if (message.event.type === 'error' && message.event.error) {
            stream.onError(new Error(message.event.error.message));
          } else {
            stream.onComplete();
          }
        }
      } else {
        console.log('[Harbor:NativeBridge] No pending stream found for id:', message.id);
      }
      break;
    }

    case 'host_request': {
      // MCP server (in bridge) asked host to open a tab / get content / get cookies.
      // Forward to Web Agents and send host_response back to the bridge.
      (async () => {
        const req = message;
        try {
          const result = await handleHostRequest(req);
          sendMessage({ type: 'host_response', id: req.id, result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn('[Harbor:NativeBridge] host_request failed:', req.method, msg);
          sendMessage({
            type: 'host_response',
            id: req.id,
            error: { code: -32000, message: msg },
          });
        }
      })();
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

// Safari: Polling interval for reconnection
let safariPollInterval: ReturnType<typeof setInterval> | null = null;
const SAFARI_POLL_INTERVAL = 3000;

/**
 * Connect to the native bridge application.
 * Safari uses HTTP to localhost (avoids sandbox), others use connectNative (persistent port).
 */
export function connectNativeBridge(): void {
  if (useSafariMode) {
    // Safari: Test connection via HTTP to harbor-bridge server
    console.log('[Harbor:Safari] Testing HTTP connection to harbor-bridge...');
    
    // Start polling if not already polling
    if (!safariPollInterval) {
      safariPollInterval = setInterval(checkSafariConnection, SAFARI_POLL_INTERVAL);
    }
    
    checkSafariConnection();
    return;
  }
  
  // Firefox/Chrome: Use persistent port connection
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
  // Safari: Use HTTP for each request
  if (useSafariMode) {
    if (!connectionState.bridgeReady) {
      throw new Error('Bridge not connected. Make sure Harbor.app is running.');
    }
    
    return safariHttpRequest<T>(method, params ?? {});
  }
  
  // Firefox/Chrome: Use persistent port
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
 * 
 * Note: Safari uses HTTP which doesn't support true streaming.
 * For Safari, this falls back to a non-streaming request that returns all at once.
 */
export function rpcStreamRequest(
  method: string,
  params: unknown,
  onEvent: (event: StreamEvent) => void,
): { cancel: () => void; done: Promise<void> } {
  // Safari: Fall back to non-streaming HTTP request
  if (useSafariMode) {
    if (!connectionState.bridgeReady) {
      const error = new Error('Bridge not connected. Make sure Harbor.app is running.');
      return {
        cancel: () => {},
        done: Promise.reject(error),
      };
    }
    
    const id = crypto.randomUUID();
    let cancelled = false;
    
    const done = (async () => {
      try {
        // Safari streaming: Request with safari_no_stream flag, bridge buffers and returns complete
        const response = await safariHttpRequest<{
          content?: string;
          model?: string;
          finish_reason?: string;
        }>(method, { ...(params as object), safari_no_stream: true });
        
        if (cancelled) return;
        
        // Emit the complete content as a single token event
        if (response?.content) {
          onEvent({
            id,
            type: 'token',
            token: response.content,
          });
        }
        
        // Emit done event
        onEvent({
          id,
          type: 'done',
          finish_reason: response?.finish_reason || 'stop',
          model: response?.model,
        });
      } catch (err) {
        if (!cancelled) {
          onEvent({
            id,
            type: 'error',
            error: { code: -1, message: err instanceof Error ? err.message : String(err) },
          });
          throw err;
        }
      }
    })();
    
    return {
      cancel: () => { cancelled = true; },
      done,
    };
  }
  
  // Firefox/Chrome: Use persistent port with streaming
  if (!nativePort || !connectionState.bridgeReady) {
    const error = new Error('Bridge not connected');
    return {
      cancel: () => {},
      done: Promise.reject(error),
    };
  }

  const id = crypto.randomUUID();
  
  console.log('[Harbor:NativeBridge] rpcStreamRequest starting:', {
    id,
    method,
    paramsKeys: params ? Object.keys(params as Record<string, unknown>) : [],
    bridgeReady: connectionState.bridgeReady,
  });
  
  const done = new Promise<void>((resolve, reject) => {
    pendingStreams.set(id, {
      onEvent,
      onComplete: resolve,
      onError: reject,
    });
    console.log('[Harbor:NativeBridge] Registered pending stream:', id, 'total pending:', pendingStreams.size);
  });

  sendMessage({
    type: 'rpc',
    id,
    method,
    params: params ?? {},
  });
  
  console.log('[Harbor:NativeBridge] Sent RPC message for stream:', id);

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
