/**
 * A fake MCP server for site-registration tests: stubs `fetch`,
 * `EventSource` and `WebSocket` wire-faithfully enough to answer the real
 * MCP handshake (`initialize`, `notifications/initialized`, `tools/list`,
 * `tools/call`) over any of the three transports `mcp/site-servers.ts`
 * supports, without a real network call.
 *
 * "Wire-faithful" here means matching what
 * `@modelcontextprotocol/sdk`'s own server transports actually do on the
 * wire (confirmed by reading
 * `demo/web-agents/bring-your-chatbot/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/{sse,webStandardStreamableHttp}.js`),
 * not just whatever shape made the client code pass:
 *
 *   - SSE (`SSEServerTransport`): the initial GET opens an `EventSource`;
 *     the server's first event is `event: endpoint` with a *plain relative
 *     URL string* as `data` (not JSON), carrying `?sessionId=<id>`. Every
 *     later request is POSTed to that exact URL. The POST response is
 *     *always* `202 Accepted` with a plain-text body, whether the message
 *     was a request or a notification — the real JSON-RPC response (if
 *     any) arrives later as an `event: message` on the *original*
 *     EventSource, not in the POST response. A POST with no matching
 *     session, or to the bare SSE URL with no `sessionId` at all, fails.
 *   - Streamable HTTP (`StreamableHTTPServerTransport`): every request is
 *     its own POST. A request-only message (no `id`) gets `202` with *no
 *     body at all*. A message with requests gets back either
 *     `application/json` or (the SDK's own default) `text/event-stream`
 *     framed as `event: message\ndata: ...\n\n` — this fake defaults to
 *     the SSE-framed form for the same reason the SDK does, and can be
 *     switched to the JSON form via `streamableHttpResponseMode: 'json'`.
 *     Once a `Mcp-Session-Id` is minted (on `initialize`), every later
 *     request must carry it back, or the fake 400s, the same way
 *     `validateSession` does.
 *
 * Use `vi.unstubAllGlobals()` in `afterEach` to remove these.
 */
import { vi } from 'vitest';

export interface FakeMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface FakeMcpServerOptions {
  tools?: FakeMcpTool[];
  /** Answers a `tools/call`. Defaults to `{ ok: true, name, args }`. */
  onToolCall?: (name: string, args: Record<string, unknown>) => unknown;
  /** Make this MCP method's response an error, to exercise a failed connect. */
  failOn?: 'initialize' | 'tools/list';
  /**
   * How a streamable-HTTP request-response is framed. The real SDK
   * defaults to SSE framing (`'sse'`) and only returns a plain
   * `application/json` body when the server opts into
   * `enableJsonResponse` — defaulting to `'sse'` here too, so a client
   * that only ever handled the JSON form doesn't go untested.
   */
  streamableHttpResponseMode?: 'sse' | 'json';
  /**
   * Delays the response to this one MCP method until the test calls
   * `handle.release()` — lets a test act (close a tab, abort a signal)
   * while a request is still genuinely in flight, not just scheduled on
   * a microtask queue that's already drained by the time the test gets
   * control back.
   */
  holdResponseTo?: 'initialize' | 'tools/list';
}

export interface FakeMcpRequestLog {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: { id?: string; method?: string; params?: unknown };
  /** `fetch`'s own `redirect` option, e.g. `'error'` so a server can't bounce a request elsewhere. `undefined` for a WebSocket send, which has no such concept. */
  redirect?: string;
}

/** One SSE connection the fake has opened (`new EventSource(...)`). */
export interface FakeSseConnection {
  readonly sessionId: string;
  readonly closed: boolean;
  /**
   * Simulates a network-level error, as a real `EventSource` would fire
   * on `onerror` — it does *not* close the connection itself. A real
   * browser `EventSource` keeps trying to reconnect after this unless
   * application code calls `close()`; this fake's `addEventListener`
   * plumbing doesn't model the reconnect itself (there is nothing to
   * reconnect to that behaves differently), but `closed` lets a test
   * assert whether the transport under test called `close()` in response.
   */
  simulateError(): void;
}

export interface FakeMcpServerHandle {
  /** Every transport-level send, across fetch and the WebSocket, in order. */
  requests: FakeMcpRequestLog[];
  /** The `Mcp-Session-Id` the fake streamable-HTTP server minted on `initialize`, if any. */
  sessionId: string | null;
  /** Every SSE connection this fake has opened, in order (including closed ones). */
  sseConnections: FakeSseConnection[];
  /** How many `new WebSocket(...)` this fake has seen — a reconnect shows up as a second one. */
  webSocketOpenCount: number;
  /** Every WebSocket this fake has opened, in order. */
  webSocketConnections: FakeWsConnection[];
  /** Releases the response `holdResponseTo` is holding back. A no-op if nothing is held, or already released. */
  release(): void;
}

/** One WebSocket connection the fake has opened (`new WebSocket(...)`). */
export interface FakeWsConnection {
  /** A real network blip, not a `close()` call from the transport under test. */
  simulateUnexpectedClose(): void;
}

function jsonResponse(body: unknown, extraHeaders: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

/** `event: message\ndata: ...\n\n` — the same framing both server transports use for a pushed response. */
function sseFramedResponse(message: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', ...extraHeaders },
  });
}

function rpcResult(opts: FakeMcpServerOptions, method: string | undefined, params: unknown): unknown {
  if (method === 'tools/call') {
    const p = params as { name: string; arguments?: Record<string, unknown> };
    return opts.onToolCall?.(p.name, p.arguments ?? {}) ?? { ok: true, name: p.name, args: p.arguments };
  }
  if (method === 'tools/list') {
    return { tools: opts.tools ?? [] };
  }
  if (method === 'initialize') {
    return { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-mcp', version: '1.0' } };
  }
  return {};
}

function rpcMessage(opts: FakeMcpServerOptions, body: FakeMcpRequestLog['body']): { jsonrpc: '2.0'; id: string; result?: unknown; error?: { code: number; message: string } } {
  const id = body?.id ?? '';
  if (opts.failOn && body?.method === opts.failOn) {
    return { jsonrpc: '2.0', id, error: { code: -32000, message: `${body?.method} failed` } };
  }
  return { jsonrpc: '2.0', id, result: rpcResult(opts, body?.method, body?.params) };
}

function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Installs the fake server's globals and returns a handle to inspect what it saw. */
export function installFakeMcpServer(opts: FakeMcpServerOptions = {}): FakeMcpServerHandle {
  let releaseHeld: (() => void) | null = null;
  const heldGate: Promise<void> | null = opts.holdResponseTo
    ? new Promise<void>((resolve) => { releaseHeld = resolve; })
    : null;
  /** Awaited before responding to `opts.holdResponseTo`; resolves immediately for every other method. */
  async function waitIfHeld(method: string | undefined): Promise<void> {
    if (heldGate && method === opts.holdResponseTo) await heldGate;
  }

  const handle: FakeMcpServerHandle = {
    requests: [],
    sessionId: null,
    sseConnections: [],
    webSocketOpenCount: 0,
    webSocketConnections: [],
    release: () => releaseHeld?.(),
  };

  // --- SSE's own HTTP endpoint (the base URL every EventSource opened against) ---
  const sseBaseUrls = new Set<string>();
  const sseBySession = new Map<string, FakeEventSource>();

  function handleSsePost(sessionId: string, method: string, body: FakeMcpRequestLog['body']): Response {
    if (method !== 'POST') return new Response('Not found', { status: 404 });
    const sse = sseBySession.get(sessionId);
    if (!sse) return new Response('Session not found', { status: 404 });
    if (!body?.method) return new Response('Invalid message', { status: 400 });

    // The real SSEServerTransport.handlePostMessage *always* 202s the POST
    // itself (a plain "Accepted" body, not JSON) whether the message was a
    // notification or a request. A request's real JSON-RPC response (if
    // any) is pushed later, over the SSE stream this session already has
    // open — never in this POST's own response.
    if (body.id) {
      waitIfHeld(body.method).then(() => sse.dispatch('message', JSON.stringify(rpcMessage(opts, body))));
    }
    return new Response('Accepted', { status: 202 });
  }

  // --- Streamable HTTP's own HTTP endpoint ---
  async function handleStreamableHttpRequest(method: string, headers: Record<string, string>, body: FakeMcpRequestLog['body']): Promise<Response> {
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (method !== 'POST') return new Response('Not found', { status: 404 });

    const rpcMethod = body?.method;

    // Mirrors `validateSession`: once a session exists, every later
    // request (anything but `initialize`) must carry it back.
    if (handle.sessionId && rpcMethod !== 'initialize' && headers['mcp-session-id'] !== handle.sessionId) {
      return jsonResponse({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' } }, {}, 400);
    }

    if (!body?.id) {
      // Request-only messages get 202 with *no body at all* — not even a
      // JSON envelope.
      return new Response(null, { status: 202 });
    }

    await waitIfHeld(rpcMethod);

    if (rpcMethod === 'initialize' && !handle.sessionId) {
      handle.sessionId = `sess-${Math.random().toString(36).slice(2)}`;
    }
    const extraHeaders: Record<string, string> = handle.sessionId ? { 'Mcp-Session-Id': handle.sessionId } : {};

    const message = rpcMessage(opts, body);
    return (opts.streamableHttpResponseMode ?? 'sse') === 'json'
      ? jsonResponse(message, extraHeaders)
      : sseFramedResponse(message, extraHeaders);
  }

  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headerEntries = init?.headers ? Object.fromEntries(new Headers(init.headers as HeadersInit).entries()) : {};
    let body: FakeMcpRequestLog['body'];
    try {
      body = init?.body ? (JSON.parse(init.body as string) as FakeMcpRequestLog['body']) : undefined;
    } catch {
      body = undefined;
    }
    handle.requests.push({ url: String(url), method, headers: headerEntries, body, redirect: init?.redirect });

    const parsed = safeParseUrl(String(url));
    const sessionIdParam = parsed?.searchParams.get('sessionId') ?? null;
    const bareUrl = parsed ? `${parsed.origin}${parsed.pathname}` : String(url).split('?')[0];

    if (sessionIdParam !== null) {
      return handleSsePost(sessionIdParam, method, body);
    }
    if (method === 'POST' && sseBaseUrls.has(bareUrl)) {
      // A POST to the bare SSE URL, with no session — the client never
      // learned (or forgot) the real `endpoint` the server told it to use.
      return new Response('Bad Request: no session', { status: 400 });
    }

    return handleStreamableHttpRequest(method, headerEntries, body);
  }));

  // --- EventSource: SSE's own connection. The `endpoint` event is a plain
  // relative URL string (not JSON) carrying the session id; every later
  // response arrives as a `message` event on this same connection. ---
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    readyState = 0;
    closed = false;
    readonly sessionId = `sess-${Math.random().toString(36).slice(2)}`;
    private readonly listeners = new Map<string, Array<(e: { data: string }) => void>>();

    constructor(public readonly url: string) {
      const self = this;
      sseBaseUrls.add(url);
      sseBySession.set(this.sessionId, this);
      handle.sseConnections.push({
        sessionId: this.sessionId,
        get closed() { return self.closed; },
        simulateError: () => self.onerror?.(new Event('error')),
      });
      queueMicrotask(() => {
        if (this.closed) return;
        this.readyState = 1;
        this.onopen?.();
        this.dispatch('endpoint', `/mcp?sessionId=${this.sessionId}`);
      });
    }

    addEventListener(type: string, cb: (e: { data: string }) => void): void {
      const arr = this.listeners.get(type) ?? [];
      arr.push(cb);
      this.listeners.set(type, arr);
    }

    dispatch(type: string, data: string): void {
      if (this.closed) return;
      for (const cb of this.listeners.get(type) ?? []) cb({ data });
    }

    close(): void {
      this.closed = true;
      this.readyState = 2;
      sseBySession.delete(this.sessionId);
    }
  }
  vi.stubGlobal('EventSource', FakeEventSource);

  // --- WebSocket ---
  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(public readonly url: string) {
      handle.webSocketOpenCount++;
      handle.webSocketConnections.push({
        // A real network blip: the socket closes with no `close()` call
        // from the transport under test, same as `this.onclose?.()` below
        // but without `close()` having set `readyState = 3` first.
        simulateUnexpectedClose: () => this.onclose?.(),
      });
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(data: string): void {
      const req = JSON.parse(data) as FakeMcpRequestLog['body'];
      handle.requests.push({ url: this.url, method: 'WS', headers: {}, body: req });
      if (!req?.id) return; // a notification; no response expected
      waitIfHeld(req.method).then(() => {
        this.onmessage?.({ data: JSON.stringify(rpcMessage(opts, req)) });
      });
    }
    close(): void {
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.());
    }
  }
  vi.stubGlobal('WebSocket', FakeWebSocket);

  return handle;
}
