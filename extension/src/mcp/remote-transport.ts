/**
 * Remote MCP Transport
 * 
 * Implements McpTransport for remote MCP servers using SSE (Server-Sent Events)
 * or WebSocket connections.
 */

import type { McpNotification, McpRequest, McpResponse } from './protocol';
import type { McpTransport } from './transport';
import type { RemoteTransport } from '../wasm/types';

type PendingRequest = {
  resolve: (response: McpResponse) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

/**
 * Every transport `createRemoteTransport`/`createSiteTransport` can build.
 * A superset of `../wasm/types.ts`'s `RemoteTransport` (installed servers'
 * manifest field, `'sse' | 'websocket'` only): streamable HTTP is site-only
 * today, so it's added here rather than widening that type.
 */
export type RemoteTransportKind = RemoteTransport | 'streamable-http';

export type RemoteTransportOptions = {
  /** URL of the remote MCP server */
  url: string;
  /** Transport type: 'sse', 'websocket' or 'streamable-http' */
  transport: RemoteTransportKind;
  /** Optional authorization header value */
  authHeader?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Max reconnect attempts (default: 5) */
  maxReconnectAttempts?: number;
};

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Transport for remote MCP servers using SSE (Server-Sent Events).
 */
export class McpSseTransport implements McpTransport {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly timeout: number;
  private readonly autoReconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private eventSource: EventSource | null = null;
  private state: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private sessionEndpoint: string | null = null;

  constructor(private readonly options: RemoteTransportOptions) {
    this.timeout = options.timeout ?? 30000;
    this.autoReconnect = options.autoReconnect ?? true;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
  }

  /**
   * Connect to the remote server.
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    this.state = 'connecting';
    
    return new Promise((resolve, reject) => {
      try {
        // For SSE, we connect to the server URL
        // The server should return a session endpoint for posting requests
        const url = new URL(this.options.url);
        
        this.eventSource = new EventSource(url.toString());
        
        this.eventSource.onopen = () => {
          console.log('[RemoteTransport] SSE connection opened:', url.toString());
          this.state = 'connected';
          this.reconnectAttempts = 0;
          resolve();
        };
        
        this.eventSource.onerror = (error) => {
          console.error('[RemoteTransport] SSE error:', error);
          if (this.state === 'connecting') {
            this.state = 'error';
            reject(new Error('Failed to connect to remote server'));
          } else {
            this.handleDisconnect();
          }
        };
        
        // Listen for the endpoint message that tells us where to POST requests
        this.eventSource.addEventListener('endpoint', (event: MessageEvent) => {
          const data = JSON.parse(event.data);
          this.sessionEndpoint = data.endpoint;
          console.log('[RemoteTransport] Received session endpoint:', this.sessionEndpoint);
        });
        
        // Listen for message events (responses from the server)
        this.eventSource.addEventListener('message', (event: MessageEvent) => {
          this.handleMessage(event.data);
        });
        
        // Some servers use a custom event type for responses
        this.eventSource.addEventListener('response', (event: MessageEvent) => {
          this.handleMessage(event.data);
        });
        
      } catch (error) {
        this.state = 'error';
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the remote server.
   */
  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.state = 'disconnected';
    this.sessionEndpoint = null;
    
    // Reject all pending requests
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Connection closed'));
      this.pending.delete(id);
    }
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Get connection state.
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Send a request to the remote server.
   */
  async send(request: McpRequest): Promise<McpResponse> {
    // Ensure we're connected
    if (this.state !== 'connected') {
      await this.connect();
    }

    // Determine the POST endpoint
    // If we have a session endpoint from the server, use that
    // Otherwise, fall back to the base URL
    const postUrl = this.sessionEndpoint || this.options.url;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(`Request timed out after ${this.timeout}ms`));
      }, this.timeout);

      this.pending.set(request.id, { resolve, reject, timeoutId });

      // Send the request via HTTP POST
      this.postRequest(postUrl, request).catch((error) => {
        this.pending.delete(request.id);
        clearTimeout(timeoutId);
        reject(error);
      });
    });
  }

  /**
   * POST a request to the server.
   */
  private async postRequest(url: string, request: McpRequest): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.options.authHeader) {
      headers['Authorization'] = this.options.authHeader;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }

    // For SSE, the response comes via the event stream, not the POST response
    // But some servers may return the response directly in the POST body
    const contentType = response.headers.get('Content-Type');
    if (contentType?.includes('application/json')) {
      const data = await response.json();
      if (data && typeof data === 'object' && 'jsonrpc' in data) {
        // Server returned the response directly
        this.handleMessage(JSON.stringify(data));
      }
    }
  }

  /**
   * Handle an incoming message from the event stream.
   */
  private handleMessage(data: string): void {
    let message: McpResponse;
    try {
      message = JSON.parse(data) as McpResponse;
    } catch (error) {
      console.error('[RemoteTransport] Failed to parse message:', error);
      return;
    }

    if (!message?.id) {
      // Notification or malformed message
      console.log('[RemoteTransport] Received notification:', message);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      console.warn('[RemoteTransport] Received response for unknown request:', message.id);
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pending.delete(message.id);
    pending.resolve(message);
  }

  /**
   * Handle disconnection.
   */
  private handleDisconnect(): void {
    this.state = 'disconnected';

    if (this.autoReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      console.log(`[RemoteTransport] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

      setTimeout(() => {
        this.connect().catch((error) => {
          console.error('[RemoteTransport] Reconnect failed:', error);
        });
      }, delay);
    }
  }

  /**
   * Send a one-way message (no response expected), e.g.
   * `notifications/initialized`. POSTed the same way a request is; any
   * body the server returns is ignored.
   */
  async notify(notification: McpNotification): Promise<void> {
    if (this.state !== 'connected') {
      await this.connect();
    }
    const postUrl = this.sessionEndpoint || this.options.url;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.options.authHeader) headers['Authorization'] = this.options.authHeader;
    await fetch(postUrl, { method: 'POST', headers, body: JSON.stringify(notification) });
  }
}

/**
 * Transport for remote MCP servers using WebSocket.
 */
export class McpWebSocketTransport implements McpTransport {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly timeout: number;
  private readonly autoReconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;

  constructor(private readonly options: RemoteTransportOptions) {
    this.timeout = options.timeout ?? 30000;
    this.autoReconnect = options.autoReconnect ?? true;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
  }

  /**
   * Connect to the remote server.
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    this.state = 'connecting';

    return new Promise((resolve, reject) => {
      try {
        // Convert http(s) URL to ws(s) if needed
        const url = new URL(this.options.url);
        if (url.protocol === 'http:') {
          url.protocol = 'ws:';
        } else if (url.protocol === 'https:') {
          url.protocol = 'wss:';
        }

        this.ws = new WebSocket(url.toString());

        this.ws.onopen = () => {
          console.log('[RemoteTransport] WebSocket connection opened:', url.toString());
          this.state = 'connected';
          this.reconnectAttempts = 0;
          resolve();
        };

        this.ws.onerror = (error) => {
          console.error('[RemoteTransport] WebSocket error:', error);
          if (this.state === 'connecting') {
            this.state = 'error';
            reject(new Error('Failed to connect to remote server'));
          }
        };

        this.ws.onclose = () => {
          console.log('[RemoteTransport] WebSocket closed');
          this.handleDisconnect();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

      } catch (error) {
        this.state = 'error';
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the remote server.
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.state = 'disconnected';

    // Reject all pending requests
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Connection closed'));
      this.pending.delete(id);
    }
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Get connection state.
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Send a request to the remote server.
   */
  async send(request: McpRequest): Promise<McpResponse> {
    // Ensure we're connected
    if (this.state !== 'connected') {
      await this.connect();
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(`Request timed out after ${this.timeout}ms`));
      }, this.timeout);

      this.pending.set(request.id, { resolve, reject, timeoutId });

      try {
        this.ws!.send(JSON.stringify(request));
      } catch (error) {
        this.pending.delete(request.id);
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  /**
   * Handle an incoming message.
   */
  private handleMessage(data: string): void {
    let message: McpResponse;
    try {
      message = JSON.parse(data) as McpResponse;
    } catch (error) {
      console.error('[RemoteTransport] Failed to parse message:', error);
      return;
    }

    if (!message?.id) {
      console.log('[RemoteTransport] Received notification:', message);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      console.warn('[RemoteTransport] Received response for unknown request:', message.id);
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pending.delete(message.id);
    pending.resolve(message);
  }

  /**
   * Handle disconnection.
   */
  private handleDisconnect(): void {
    this.state = 'disconnected';

    if (this.autoReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      console.log(`[RemoteTransport] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

      setTimeout(() => {
        this.connect().catch((error) => {
          console.error('[RemoteTransport] Reconnect failed:', error);
        });
      }, delay);
    }
  }

  /** Send a one-way message over the open socket. No response is awaited. */
  async notify(notification: McpNotification): Promise<void> {
    if (this.state !== 'connected') {
      await this.connect();
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(notification));
  }
}

/**
 * Transport for remote MCP servers using streamable HTTP (MCP spec
 * 2025-03-26+): every request is its own POST to the server's URL, with
 * `Accept: application/json, text/event-stream` so either response shape
 * is acceptable. A session id the server hands back on `initialize` (the
 * `Mcp-Session-Id` response header) is carried on every later request;
 * closing the transport best-effort DELETEs that session.
 *
 * Unlike the SSE/WebSocket transports above, there's no persistent
 * connection to "connect" — `isConnected()` is always `true` once
 * constructed, since whether a request succeeds is decided per call.
 */
export class McpStreamableHttpTransport implements McpTransport {
  private sessionId: string | null = null;

  constructor(private readonly options: RemoteTransportOptions) {}

  isConnected(): boolean {
    return true;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.options.authHeader) headers['Authorization'] = this.options.authHeader;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  async send(request: McpRequest): Promise<McpResponse> {
    const response = await fetch(this.options.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(request),
    });

    const sessionId = response.headers.get('Mcp-Session-Id');
    if (sessionId) this.sessionId = sessionId;

    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('text/event-stream')) {
      return this.readEventStreamResponse(response, request.id);
    }
    if (contentType.includes('application/json')) {
      return (await response.json()) as McpResponse;
    }
    if (response.status === 202) {
      // Accepted with no body — only valid for a notification, never a
      // request a caller is waiting on a result for.
      return { jsonrpc: '2.0', id: request.id, result: null };
    }
    throw new Error(`Unexpected streamable HTTP response content-type: "${contentType || '(none)'}"`);
  }

  async notify(notification: McpNotification): Promise<void> {
    const response = await fetch(this.options.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(notification),
    });
    const sessionId = response.headers.get('Mcp-Session-Id');
    if (sessionId) this.sessionId = sessionId;
    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Read a `text/event-stream` body for the one response this request is
   * waiting on. The stream can carry other servers' SSE framing (blank-line
   * delimited `data:` lines); messages for a different request id are
   * dropped rather than treated as an error, in case the server multiplexes.
   */
  private async readEventStreamResponse(response: Response, requestId: string): Promise<McpResponse> {
    if (!response.body) {
      throw new Error('Streamable HTTP response had no body to read as an event stream');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const message = parseSseDataLines(rawEvent);
          if (message && message.id === requestId) {
            return message;
          }
          boundary = buffer.indexOf('\n\n');
        }
        if (done) break;
      }
    } finally {
      try { reader.cancel(); } catch { /* best-effort */ }
    }
    throw new Error('Streamable HTTP event stream ended before this request\'s response arrived');
  }

  /** Best-effort: DELETE the session the server handed out, if any. */
  async disconnect(): Promise<void> {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = null;
    try {
      await fetch(this.options.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId } });
    } catch {
      // Nice-to-have only: the connection is being torn down either way.
    }
  }
}

function parseSseDataLines(rawEvent: string): McpResponse | null {
  const dataLines = rawEvent
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart());
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join('\n')) as McpResponse;
  } catch {
    return null;
  }
}

/**
 * Create a remote transport based on the transport type. Used both for a
 * person's own installed servers (`'sse' | 'websocket'` only, via
 * `../wasm/types.ts`'s narrower `RemoteTransport`) and for site-registered
 * servers (`../mcp/site-servers.ts`), which can also ask for
 * `'streamable-http'`. Overloaded so an installed server's call site (whose
 * `transport` is the narrower `RemoteTransport`) keeps the two-member
 * return type it already has `.connect()`/`.disconnect()` on, rather than
 * every caller having to narrow out `McpStreamableHttpTransport` by hand.
 */
export function createRemoteTransport(
  options: RemoteTransportOptions & { transport: RemoteTransport },
): McpSseTransport | McpWebSocketTransport;
export function createRemoteTransport(
  options: RemoteTransportOptions,
): McpSseTransport | McpWebSocketTransport | McpStreamableHttpTransport;
export function createRemoteTransport(
  options: RemoteTransportOptions,
): McpSseTransport | McpWebSocketTransport | McpStreamableHttpTransport {
  if (options.transport === 'websocket') {
    return new McpWebSocketTransport(options);
  }
  if (options.transport === 'streamable-http') {
    return new McpStreamableHttpTransport(options);
  }
  return new McpSseTransport(options);
}
