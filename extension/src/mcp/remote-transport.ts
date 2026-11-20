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
 * Every transport `createRemoteTransport` can build. A superset of
 * `../wasm/types.ts`'s `RemoteTransport` (installed servers' manifest
 * field, `'sse' | 'websocket'` only): streamable HTTP is site-only today,
 * so it's added here rather than widening that type.
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
  /** In flight while `connect()` is waiting on the `endpoint` event; reused by concurrent callers. */
  private connectPromise: Promise<void> | null = null;
  /** Set by `disconnect()` so a disconnect already in progress doesn't schedule a reconnect once its `onerror`/`onclose` fires. */
  private intentionalDisconnect = false;

  constructor(private readonly options: RemoteTransportOptions) {
    this.timeout = options.timeout ?? 30000;
    this.autoReconnect = options.autoReconnect ?? true;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
  }

  /**
   * Connect to the remote server. Resolves only once the server's
   * `endpoint` event has arrived — the SSE server transport in
   * `@modelcontextprotocol/sdk` (and the spec it implements) sends that
   * before anything can be POSTed, so a caller that only waited for
   * `onopen` could (and did, against the real SDK) send its first
   * request to the bare SSE URL with no session, which the server has no
   * way to answer.
   */
  async connect(): Promise<void> {
    if (this.state === 'connected') return;
    if (this.state === 'connecting' && this.connectPromise) return this.connectPromise;

    this.state = 'connecting';
    this.intentionalDisconnect = false;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      try {
        const url = new URL(this.options.url);

        this.eventSource = new EventSource(url.toString());

        // The server has up to `this.timeout` to send its `endpoint`
        // event once the connection opens; nothing can be sent before it.
        const endpointTimeout = setTimeout(() => {
          this.state = 'error';
          this.eventSource?.close();
          this.eventSource = null;
          reject(new Error("Timed out waiting for the server's SSE endpoint event"));
        }, this.timeout);

        this.eventSource.onopen = () => {
          console.log('[RemoteTransport] SSE connection opened');
          // Not resolved yet: still waiting on the `endpoint` event below.
        };

        this.eventSource.onerror = (error) => {
          console.error('[RemoteTransport] SSE error:', error);
          if (this.state === 'connecting') {
            clearTimeout(endpointTimeout);
            this.state = 'error';
            this.eventSource?.close();
            this.eventSource = null;
            reject(new Error('Failed to connect to remote server'));
            return;
          }
          // A native EventSource keeps trying to reconnect on its own
          // after an error unless something calls close() — when we
          // don't want that (no auto-reconnect, or our own attempts are
          // exhausted), stop it here rather than let two reconnect
          // mechanisms race.
          if (!this.autoReconnect) {
            this.eventSource?.close();
            this.eventSource = null;
          }
          this.handleDisconnect();
        };

        // The endpoint event tells us where to POST requests. The real
        // SSE server transport sends a plain relative (or absolute) URL
        // string as `data`, not JSON — `data: /mcp?sessionId=<id>`. A
        // `{endpoint: "..."}` JSON form is tolerated too, in case a
        // server sends that instead.
        this.eventSource.addEventListener('endpoint', (event: MessageEvent) => {
          const endpoint = this.parseEndpointEvent(event.data);
          if (!endpoint) {
            console.error('[RemoteTransport] Could not parse the SSE endpoint event');
            return;
          }
          // Matches the SDK's own SSE client (client/sse.js): a server
          // naming an endpoint on a different origin than the connection
          // itself could redirect Harbor's later POSTs anywhere, so this
          // is a failed connect, not a connect that happens to use a
          // surprising URL.
          let endpointOrigin: string;
          try {
            endpointOrigin = new URL(endpoint).origin;
          } catch {
            endpointOrigin = '';
          }
          if (endpointOrigin !== url.origin) {
            const error = new Error(`Endpoint origin does not match connection origin: ${endpointOrigin}`);
            console.error('[RemoteTransport]', error.message);
            if (this.state === 'connecting') {
              clearTimeout(endpointTimeout);
              this.state = 'error';
              this.eventSource?.close();
              this.eventSource = null;
              reject(error);
            }
            return;
          }
          this.sessionEndpoint = endpoint;
          console.log('[RemoteTransport] Received the SSE session endpoint');
          if (this.state === 'connecting') {
            clearTimeout(endpointTimeout);
            this.state = 'connected';
            this.reconnectAttempts = 0;
            resolve();
          }
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
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  /**
   * The `endpoint` event's `data`: a plain relative-or-absolute URL
   * string per the SSE server transport's real wire format, resolved
   * against this transport's own URL. A `{endpoint: "..."}` JSON form is
   * also accepted, for a server that sends that instead.
   */
  private parseEndpointEvent(data: string): string | null {
    let candidate = data;
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object' && typeof (parsed as { endpoint?: unknown }).endpoint === 'string') {
        candidate = (parsed as { endpoint: string }).endpoint;
      }
    } catch {
      // Not JSON — the common case: a plain URL string.
    }
    try {
      return new URL(candidate, this.options.url).toString();
    } catch {
      return null;
    }
  }

  /**
   * Disconnect from the remote server.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
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
      // Never follow a redirect: a server naming its endpoint shouldn't
      // also get to bounce individual requests somewhere else.
      redirect: 'error',
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
   * Handle disconnection. Never reconnects after `disconnect()` was the
   * cause (`intentionalDisconnect`) — a site server, in particular, is
   * meant to stay gone once Harbor drops it, not reappear a few seconds
   * later because the browser's own `EventSource` (or our own backoff)
   * tried again.
   */
  private handleDisconnect(): void {
    this.state = 'disconnected';
    if (this.intentionalDisconnect) return;

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
    await fetch(postUrl, { method: 'POST', headers, redirect: 'error', body: JSON.stringify(notification) });
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
  /** Set by `disconnect()` so its own `onclose` doesn't schedule a reconnect — a WebSocket always fires `onclose`, even for a close *we* asked for. */
  private intentionalDisconnect = false;

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
    this.intentionalDisconnect = false;

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
          // Not `url.toString()` — a site's own server URL can carry a
          // query string. See page-api/__tests__/no-payload-logs.test.ts.
          console.log('[RemoteTransport] WebSocket connection opened');
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
    this.intentionalDisconnect = true;
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
   * Handle disconnection. A WebSocket fires `onclose` even for a close
   * *we* asked for (`disconnect()`), so without the
   * `intentionalDisconnect` check below, Harbor dropping a site server
   * (a tab closing, a cross-origin navigation, `unregister()`) would
   * still reconnect to it a few seconds later.
   */
  private handleDisconnect(): void {
    this.state = 'disconnected';
    if (this.intentionalDisconnect) return;

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
  /**
   * The protocol version `initialize`'s own JSON-RPC result negotiated,
   * carried as `MCP-Protocol-Version` on every later request — the
   * server is lenient about a missing header (it falls back to whatever
   * it negotiated), but sending it is what the spec and
   * `WebStandardStreamableHTTPServerTransport.validateProtocolVersion`
   * actually expect "for all requests after initialization".
   */
  private protocolVersion: string | null = null;
  private readonly timeout: number;

  constructor(private readonly options: RemoteTransportOptions) {
    this.timeout = options.timeout ?? 30000;
  }

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
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
    return headers;
  }

  /**
   * Runs `run` with a timeout: unlike the SSE/WebSocket transports, there
   * is no persistent connection whose own error/close events can tell us
   * a request is never coming back, so every POST gets its own
   * `AbortController`, aborted after `this.timeout` — without it, a
   * request to a server that accepts the connection but never answers
   * would hang forever.
   */
  private async withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await run(controller.signal);
    } catch (e) {
      if (controller.signal.aborted) {
        throw new Error(`Request timed out after ${this.timeout}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async send(request: McpRequest): Promise<McpResponse> {
    return this.withTimeout(async (signal) => {
      const response = await fetch(this.options.url, {
        method: 'POST',
        headers: this.headers(),
        // Never follow a redirect: a server shouldn't get to bounce an
        // individual request somewhere else.
        redirect: 'error',
        body: JSON.stringify(request),
        signal,
      });

      const sessionId = response.headers.get('Mcp-Session-Id');
      if (sessionId) this.sessionId = sessionId;

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get('Content-Type') || '';
      let result: McpResponse;
      if (contentType.includes('text/event-stream')) {
        result = await this.readEventStreamResponse(response, request.id, signal);
      } else if (contentType.includes('application/json')) {
        result = (await response.json()) as McpResponse;
      } else if (response.status === 202) {
        // Accepted with no body — only valid for a notification, never a
        // request a caller is waiting on a result for.
        result = { jsonrpc: '2.0', id: request.id, result: null };
      } else {
        throw new Error(`Unexpected streamable HTTP response content-type: "${contentType || '(none)'}"`);
      }

      if (request.method === 'initialize' && !result.error) {
        const negotiated = (result.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        if (typeof negotiated === 'string') this.protocolVersion = negotiated;
      }
      return result;
    });
  }

  async notify(notification: McpNotification): Promise<void> {
    await this.withTimeout(async (signal) => {
      const response = await fetch(this.options.url, {
        method: 'POST',
        headers: this.headers(),
        redirect: 'error',
        body: JSON.stringify(notification),
        signal,
      });
      const sessionId = response.headers.get('Mcp-Session-Id');
      if (sessionId) this.sessionId = sessionId;
      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
      }
    });
  }

  /**
   * Read a `text/event-stream` body for the one response this request is
   * waiting on. The stream can carry other servers' SSE framing (blank-line
   * delimited `data:` lines); messages for a different request id are
   * dropped rather than treated as an error, in case the server multiplexes.
   */
  private async readEventStreamResponse(response: Response, requestId: string, signal: AbortSignal): Promise<McpResponse> {
    if (!response.body) {
      throw new Error('Streamable HTTP response had no body to read as an event stream');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        if (signal.aborted) throw new Error('aborted');
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
    const protocolVersion = this.protocolVersion;
    this.sessionId = null;
    try {
      const headers: Record<string, string> = { 'Mcp-Session-Id': sessionId };
      if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
      await fetch(this.options.url, { method: 'DELETE', headers, redirect: 'error' });
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
