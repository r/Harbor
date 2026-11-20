/**
 * A fake MCP server for site-registration tests: stubs `fetch`,
 * `EventSource` and `WebSocket` well enough to answer the real MCP
 * handshake (`initialize`, `notifications/initialized`, `tools/list`,
 * `tools/call`) over any of the three transports `mcp/site-servers.ts`
 * supports, without a real network call.
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
}

export interface FakeMcpRequestLog {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: { id?: string; method?: string; params?: unknown };
}

export interface FakeMcpServerHandle {
  /** Every transport-level send, across fetch and the WebSocket, in order. */
  requests: FakeMcpRequestLog[];
  /** The `Mcp-Session-Id` the fake streamable-HTTP server minted on `initialize`, if any. */
  sessionId: string | null;
}

function jsonResponse(body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
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

/** Installs the fake server's globals and returns a handle to inspect what it saw. */
export function installFakeMcpServer(opts: FakeMcpServerOptions = {}): FakeMcpServerHandle {
  const handle: FakeMcpServerHandle = { requests: [], sessionId: null };

  // --- fetch: SSE's POST, streamable HTTP's POST/DELETE, and `notify()` on both ---
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headerEntries = init?.headers ? Object.fromEntries(new Headers(init.headers as HeadersInit).entries()) : {};
    let body: FakeMcpRequestLog['body'];
    try {
      body = init?.body ? (JSON.parse(init.body as string) as FakeMcpRequestLog['body']) : undefined;
    } catch {
      body = undefined;
    }
    handle.requests.push({ url: String(url), method, headers: headerEntries, body });

    if (method === 'DELETE') {
      return new Response(null, { status: 204 });
    }

    const id = body?.id;
    const rpcMethod = body?.method;

    if (!id) {
      // A notification (`notifications/initialized`): accepted, no body.
      return new Response(null, { status: 202 });
    }

    if (opts.failOn && rpcMethod === opts.failOn) {
      return jsonResponse({ jsonrpc: '2.0', id, error: { code: -32000, message: `${rpcMethod} failed` } });
    }

    const result = rpcResult(opts, rpcMethod, body?.params);
    const extraHeaders: Record<string, string> = {};
    if (rpcMethod === 'initialize' && !handle.sessionId) {
      handle.sessionId = `sess-${Math.random().toString(36).slice(2)}`;
      extraHeaders['Mcp-Session-Id'] = handle.sessionId;
    }
    return jsonResponse({ jsonrpc: '2.0', id, result }, extraHeaders);
  }));

  // --- EventSource: SSE's connection; responses arrive over fetch's POST above ---
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(public readonly url: string) {
      queueMicrotask(() => this.onopen?.());
    }
    addEventListener(): void {
      // No server-pushed events in this fake: every response comes back
      // directly in the POST response body (handleMessage's fallback path).
    }
    close(): void {}
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
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(data: string): void {
      const req = JSON.parse(data) as FakeMcpRequestLog['body'];
      handle.requests.push({ url: this.url, method: 'WS', headers: {}, body: req });
      if (!req?.id) return; // a notification; no response expected
      queueMicrotask(() => {
        if (opts.failOn && req.method === opts.failOn) {
          this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: `${req.method} failed` } }) });
          return;
        }
        const result = rpcResult(opts, req.method, req.params);
        this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) });
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
