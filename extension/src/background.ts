import browser from 'webextension-polyfill';
import { catalogManager } from './catalog/providers';

const NATIVE_HOST_NAME = 'com.harbor.bridge';

interface HarborMessage {
  type: string;
  request_id: string;
  [key: string]: unknown;
}

interface PongMessage extends HarborMessage {
  type: 'pong';
  bridge_version: string;
}

interface ErrorResponse {
  type: 'error';
  request_id: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

interface MCPServer {
  server_id: string;
  label: string;
  base_url: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error_message?: string | null;
}

interface AddServerResult extends HarborMessage {
  type: 'add_server_result';
  server: MCPServer;
}

interface ListServersResult extends HarborMessage {
  type: 'list_servers_result';
  servers: MCPServer[];
}

interface ConnectServerResult extends HarborMessage {
  type: 'connect_server_result';
  server: MCPServer;
  connection_info?: unknown;
}

interface DisconnectServerResult extends HarborMessage {
  type: 'disconnect_server_result';
  server: MCPServer;
}

interface ListToolsResult extends HarborMessage {
  type: 'list_tools_result';
  tools: unknown[];
  _todo?: string;
}

type BridgeResponse =
  | PongMessage
  | ErrorResponse
  | AddServerResult
  | ListServersResult
  | ConnectServerResult
  | DisconnectServerResult
  | ListToolsResult;

interface ConnectionState {
  connected: boolean;
  lastMessage: BridgeResponse | null;
  error: string | null;
}

interface PendingRequest {
  resolve: (response: BridgeResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

let port: browser.Runtime.Port | null = null;
let connectionState: ConnectionState = {
  connected: false,
  lastMessage: null,
  error: null,
};

const pendingRequests = new Map<string, PendingRequest>();
const REQUEST_TIMEOUT_MS = 30000;

function generateRequestId(): string {
  return crypto.randomUUID();
}

function updateState(updates: Partial<ConnectionState>): void {
  connectionState = { ...connectionState, ...updates };
  browser.storage.local.set({ connectionState });
  // Broadcast to any listening sidebars
  browser.runtime
    .sendMessage({ type: 'state_update', state: connectionState })
    .catch(() => {
      // No listeners, that's fine
    });
}

function handleNativeMessage(message: unknown): void {
  console.log('Received from native:', message);
  const response = message as BridgeResponse;

  updateState({
    connected: true,
    lastMessage: response,
    error: null,
  });

  // Resolve pending request if this is a response
  const requestId = response.request_id;
  if (requestId && pendingRequests.has(requestId)) {
    const pending = pendingRequests.get(requestId)!;
    clearTimeout(pending.timeout);
    pendingRequests.delete(requestId);
    pending.resolve(response);
  }

  // Broadcast the response to sidebars
  browser.runtime
    .sendMessage({ type: 'bridge_response', response })
    .catch(() => {});
}

function handleNativeDisconnect(): void {
  const error = browser.runtime.lastError?.message ?? 'Connection closed';
  console.error('Native port disconnected:', error);
  port = null;

  // Reject all pending requests
  for (const [requestId, pending] of pendingRequests.entries()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(`Connection lost: ${error}`));
    pendingRequests.delete(requestId);
  }

  updateState({
    connected: false,
    error,
  });
}

function connectToNative(): boolean {
  if (port) {
    return true;
  }

  try {
    port = browser.runtime.connectNative(NATIVE_HOST_NAME);
    port.onMessage.addListener(handleNativeMessage);
    port.onDisconnect.addListener(handleNativeDisconnect);
    updateState({ connected: true, error: null });
    return true;
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Failed to connect';
    console.error('Failed to connect to native host:', error);
    updateState({
      connected: false,
      error,
    });
    return false;
  }
}

async function sendToBridge(message: HarborMessage): Promise<BridgeResponse> {
  if (!port && !connectToNative()) {
    throw new Error('Not connected to native bridge');
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(message.request_id);
      reject(new Error('Request timed out'));
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(message.request_id, { resolve, reject, timeout });

    console.log('Sending to native:', message);
    port!.postMessage(message);
  });
}

function sendHello(): void {
  const message: HarborMessage = {
    type: 'hello',
    request_id: generateRequestId(),
  };
  sendToBridge(message).catch((err) => {
    console.error('Failed to send hello:', err);
  });
}

// Handle messages from sidebar
browser.runtime.onMessage.addListener(
  (message: unknown, _sender: browser.Runtime.MessageSender) => {
    const msg = message as { type: string; [key: string]: unknown };

    if (msg.type === 'get_state') {
      return Promise.resolve(connectionState);
    }

    if (msg.type === 'send_hello') {
      if (!port) {
        connectToNative();
      }
      sendHello();
      return Promise.resolve({ sent: true });
    }

    if (msg.type === 'reconnect') {
      if (port) {
        port.disconnect();
        port = null;
      }
      connectToNative();
      sendHello();
      return Promise.resolve({ reconnecting: true });
    }

    // Server management messages
    if (msg.type === 'add_server') {
      return sendToBridge({
        type: 'add_server',
        request_id: generateRequestId(),
        label: msg.label as string,
        base_url: msg.base_url as string,
      });
    }

    if (msg.type === 'remove_server') {
      return sendToBridge({
        type: 'remove_server',
        request_id: generateRequestId(),
        server_id: msg.server_id as string,
      });
    }

    if (msg.type === 'list_servers') {
      return sendToBridge({
        type: 'list_servers',
        request_id: generateRequestId(),
      });
    }

    if (msg.type === 'connect_server') {
      return sendToBridge({
        type: 'connect_server',
        request_id: generateRequestId(),
        server_id: msg.server_id as string,
      });
    }

    if (msg.type === 'disconnect_server') {
      return sendToBridge({
        type: 'disconnect_server',
        request_id: generateRequestId(),
        server_id: msg.server_id as string,
      });
    }

    if (msg.type === 'list_tools') {
      return sendToBridge({
        type: 'list_tools',
        request_id: generateRequestId(),
        server_id: msg.server_id as string,
      });
    }

    // Catalog messages
    if (msg.type === 'catalog_get') {
      const force = msg.force === true;
      console.log('[catalog] Getting catalog, force:', force);
      return catalogManager.getAll(force);
    }

    if (msg.type === 'catalog_refresh') {
      console.log('[catalog] Forcing refresh');
      return catalogManager.getAll(true);
    }

    if (msg.type === 'catalog_search') {
      const query = (msg.query as string) || '';
      const force = msg.force === true;
      console.log('[catalog] Searching:', query, 'force:', force);
      return catalogManager.search(query, force);
    }

    // Proxy fetch requests from sidebar (for CORS)
    if (msg.type === 'proxy_fetch') {
      console.log('[proxy_fetch] Received request for:', msg.url);
      return (async () => {
        try {
          console.log('[proxy_fetch] Starting fetch...');
          const response = await fetch(msg.url as string, {
            method: (msg.method as string) || 'GET',
            headers: (msg.headers as Record<string, string>) || {},
          });
          
          console.log('[proxy_fetch] Response status:', response.status);
          
          if (!response.ok) {
            console.log('[proxy_fetch] Response not ok:', response.statusText);
            return { 
              ok: false, 
              status: response.status, 
              error: response.statusText 
            };
          }
          
          const contentType = response.headers.get('content-type') || '';
          let data: string | object;
          
          if (contentType.includes('application/json')) {
            data = await response.json();
            console.log('[proxy_fetch] Parsed JSON, keys:', Object.keys(data as object));
          } else {
            data = await response.text();
            console.log('[proxy_fetch] Got text, length:', (data as string).length);
          }
          
          return { ok: true, status: response.status, data };
        } catch (err) {
          console.error('[proxy_fetch] Error:', err);
          return { 
            ok: false, 
            status: 0, 
            error: err instanceof Error ? err.message : 'Fetch failed' 
          };
        }
      })();
    }

    return Promise.resolve(undefined);
  }
);

// Connect on startup
connectToNative();
sendHello();

console.log('Harbor background script initialized');
