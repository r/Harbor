/**
 * `mcp/remote-transport.ts` — the SSE, WebSocket and streamable-HTTP
 * transports `mcp/site-servers.ts` connects a site's MCP server over.
 * Drives each transport directly against the fake MCP server
 * (`support/fake-mcp-server.ts`), which models what
 * `@modelcontextprotocol/sdk`'s own server transports actually put on
 * the wire — a mismatch here is exactly what broke `register()` against
 * a real server in Firefox (see the fake's own file header).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeMcpServer } from './support/fake-mcp-server';
import { McpSseTransport, McpStreamableHttpTransport, McpWebSocketTransport } from '../remote-transport';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('McpSseTransport', () => {
  it('resolves connect() only once the endpoint event (a plain URL string) arrives, then can send a request', async () => {
    const server = installFakeMcpServer({ tools: [{ name: 'search' }] });
    const transport = new McpSseTransport({ url: 'https://shop.example/mcp', transport: 'sse' });

    await transport.connect();
    expect(transport.isConnected()).toBe(true);

    const response = await transport.send({ jsonrpc: '2.0', id: 'r1', method: 'tools/list' });
    expect(response.result).toEqual({ tools: [{ name: 'search' }] });

    // The request went to the session endpoint the `endpoint` event named
    // (carrying the session id), never the bare SSE URL.
    const post = server.requests.find((r) => r.body?.method === 'tools/list');
    expect(post?.url).toContain('sessionId=');
    expect(post?.url).not.toBe('https://shop.example/mcp');
  });

  it('also tolerates a {endpoint: "..."} JSON form', async () => {
    // A server that sends JSON instead of the SDK's plain-string form —
    // tolerated, not required, per remote-transport.ts's own comment.
    class JsonEndpointEventSource {
      onopen: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      private listeners = new Map<string, Array<(e: { data: string }) => void>>();
      constructor(public readonly url: string) {
        queueMicrotask(() => {
          this.onopen?.();
          this.dispatch('endpoint', JSON.stringify({ endpoint: '/mcp?sessionId=json-form' }));
        });
      }
      addEventListener(type: string, cb: (e: { data: string }) => void): void {
        const arr = this.listeners.get(type) ?? [];
        arr.push(cb);
        this.listeners.set(type, arr);
      }
      dispatch(type: string, data: string): void {
        for (const cb of this.listeners.get(type) ?? []) cb({ data });
      }
      close(): void {}
    }
    vi.stubGlobal('EventSource', JsonEndpointEventSource);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Accepted', { status: 202 })));

    const transport = new McpSseTransport({ url: 'https://shop.example/mcp', transport: 'sse' });
    await transport.connect();
    expect(transport.isConnected()).toBe(true);
  });

  it('refuses an endpoint whose resolved origin differs from the connection origin, and closes the connection', async () => {
    let closed = false;
    class CrossOriginEndpointEventSource {
      onopen: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      private listeners = new Map<string, Array<(e: { data: string }) => void>>();
      constructor(public readonly url: string) {
        queueMicrotask(() => {
          this.onopen?.();
          // An absolute URL on a different origin than the connection itself.
          this.dispatch('endpoint', 'https://evil.example/mcp?sessionId=x');
        });
      }
      addEventListener(type: string, cb: (e: { data: string }) => void): void {
        const arr = this.listeners.get(type) ?? [];
        arr.push(cb);
        this.listeners.set(type, arr);
      }
      dispatch(type: string, data: string): void {
        for (const cb of this.listeners.get(type) ?? []) cb({ data });
      }
      close(): void { closed = true; }
    }
    vi.stubGlobal('EventSource', CrossOriginEndpointEventSource);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const transport = new McpSseTransport({ url: 'https://shop.example/mcp', transport: 'sse' });
    await expect(transport.connect()).rejects.toThrow(/origin/i);
    expect(closed).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends every request with redirect: "error", so a server cannot bounce Harbor\'s POSTs elsewhere', async () => {
    const server = installFakeMcpServer({ tools: [] });
    const transport = new McpSseTransport({ url: 'https://shop.example/mcp', transport: 'sse' });
    await transport.connect();
    await transport.send({ jsonrpc: '2.0', id: 'r1', method: 'tools/list' });
    await transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });

    expect(server.requests.length).toBeGreaterThan(0);
    for (const req of server.requests) {
      expect(req.redirect).toBe('error');
    }
  });

  it('with autoReconnect disabled, closes the EventSource on error and never reconnects', async () => {
    vi.useFakeTimers();
    const server = installFakeMcpServer({ tools: [] });
    const transport = new McpSseTransport({ url: 'https://shop.example/mcp', transport: 'sse', autoReconnect: false });

    await transport.connect();
    expect(server.sseConnections).toHaveLength(1);

    server.sseConnections[0].simulateError();
    // A real EventSource would otherwise keep retrying on its own even
    // though nothing here called close() — this fake can't model that
    // retry itself, but it can show the transport closed its side.
    await vi.advanceTimersByTimeAsync(31_000);

    expect(server.sseConnections[0].closed).toBe(true);
    expect(server.sseConnections).toHaveLength(1); // no reconnect attempt opened a second one
  });

  it('with autoReconnect enabled (the default), schedules its own reconnect after an error', async () => {
    vi.useFakeTimers();
    const server = installFakeMcpServer({ tools: [] });
    const transport = new McpSseTransport({ url: 'https://shop.example/mcp', transport: 'sse' });

    await transport.connect();
    expect(server.sseConnections).toHaveLength(1);

    server.sseConnections[0].simulateError();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(server.sseConnections.length).toBeGreaterThan(1);
  });

  it('disconnect() never reconnects, even past the backoff delay', async () => {
    vi.useFakeTimers();
    const server = installFakeMcpServer({ tools: [] });
    const transport = new McpSseTransport({ url: 'https://shop.example/mcp', transport: 'sse' });

    await transport.connect();
    transport.disconnect();
    await vi.advanceTimersByTimeAsync(31_000);

    expect(server.sseConnections).toHaveLength(1);
  });

  it('disconnect() while still connecting leaves the state disconnected, with no later state flip or settlement once the endpoint timeout would have fired', async () => {
    vi.useFakeTimers();
    // Never sends an `endpoint` event, so connect() is still waiting on it
    // when disconnect() runs — the endpoint timeout (this.timeout below)
    // would otherwise fire later and flip state back to 'error'.
    class NeverRespondingEventSource {
      onopen: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      closed = false;
      constructor(public readonly url: string) {}
      addEventListener(): void {}
      close(): void { this.closed = true; }
    }
    vi.stubGlobal('EventSource', NeverRespondingEventSource);

    const transport = new McpSseTransport({ url: 'https://shop.example/mcp', transport: 'sse', timeout: 5000 });
    const connectPromise = transport.connect();
    let settled = false;
    connectPromise.then(() => { settled = true; }, () => { settled = true; });

    transport.disconnect();
    expect(transport.getState()).toBe('disconnected');

    await vi.advanceTimersByTimeAsync(10_000); // well past the 5s endpoint timeout
    await Promise.resolve(); // flush any microtask the (cleared) timer would have queued

    expect(transport.getState()).toBe('disconnected');
    expect(settled).toBe(false); // no late reject/resolve from the abandoned attempt
  });
});

describe('McpWebSocketTransport', () => {
  it('connects, sends and receives', async () => {
    const server = installFakeMcpServer({ tools: [{ name: 'add_to_cart' }] });
    const transport = new McpWebSocketTransport({ url: 'https://shop.example/mcp-ws', transport: 'websocket' });

    await transport.connect();
    const response = await transport.send({ jsonrpc: '2.0', id: 'r1', method: 'tools/list' });
    expect(response.result).toEqual({ tools: [{ name: 'add_to_cart' }] });
    expect(server.webSocketOpenCount).toBe(1);
  });

  it('disconnect() never reconnects, even though WebSocket fires onclose for a close it asked for itself', async () => {
    vi.useFakeTimers();
    const server = installFakeMcpServer({ tools: [] });
    const transport = new McpWebSocketTransport({ url: 'https://shop.example/mcp-ws', transport: 'websocket' });

    await transport.connect();
    expect(server.webSocketOpenCount).toBe(1);

    transport.disconnect();
    await vi.advanceTimersByTimeAsync(31_000);

    expect(server.webSocketOpenCount).toBe(1);
  });

  it('an unexpected close (not from disconnect()) still reconnects when autoReconnect is on', async () => {
    vi.useFakeTimers();
    const server = installFakeMcpServer({ tools: [] });
    const transport = new McpWebSocketTransport({ url: 'https://shop.example/mcp-ws', transport: 'websocket' });

    await transport.connect();
    expect(server.webSocketOpenCount).toBe(1);

    server.webSocketConnections[0].simulateUnexpectedClose();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(server.webSocketOpenCount).toBeGreaterThan(1);
  });

  it('connect() times out (closing the socket, state error) if the WebSocket never fires any handler', async () => {
    vi.useFakeTimers();
    let closed = false;
    class NeverRespondingWebSocket {
      static readonly OPEN = 1;
      readyState = 0;
      onopen: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      constructor(public readonly url: string) {}
      close(): void { closed = true; this.readyState = 3; }
      send(): void { /* never reached in this test */ }
    }
    vi.stubGlobal('WebSocket', NeverRespondingWebSocket);

    const transport = new McpWebSocketTransport({ url: 'https://shop.example/mcp-ws', transport: 'websocket', timeout: 5000 });
    const connectPromise = transport.connect();

    const assertion = expect(connectPromise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;

    expect(closed).toBe(true);
    expect(transport.getState()).toBe('error');
  });
});

describe('McpStreamableHttpTransport', () => {
  it('sends MCP-Protocol-Version on every request after initialize negotiates it', async () => {
    const server = installFakeMcpServer({ tools: [{ name: 'checkout' }] });
    const transport = new McpStreamableHttpTransport({ url: 'https://shop.example/mcp-http', transport: 'streamable-http' });

    const init = await transport.send({ jsonrpc: '2.0', id: 'r1', method: 'initialize', params: {} });
    expect((init.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');

    await transport.send({ jsonrpc: '2.0', id: 'r2', method: 'tools/list' });

    const initRequest = server.requests.find((r) => r.body?.id === 'r1');
    const listRequest = server.requests.find((r) => r.body?.id === 'r2');
    expect(initRequest?.headers['mcp-protocol-version']).toBeUndefined();
    expect(listRequest?.headers['mcp-protocol-version']).toBe('2025-06-18');
  });

  it('reads an SSE-framed response body (the SDK default) as well as a plain JSON one', async () => {
    const server = installFakeMcpServer({ tools: [{ name: 'checkout' }], streamableHttpResponseMode: 'sse' });
    const transport = new McpStreamableHttpTransport({ url: 'https://shop.example/mcp-http', transport: 'streamable-http' });

    await transport.send({ jsonrpc: '2.0', id: 'r1', method: 'initialize', params: {} });
    const response = await transport.send({ jsonrpc: '2.0', id: 'r2', method: 'tools/list' });
    expect(response.result).toEqual({ tools: [{ name: 'checkout' }] });
    expect(server.sessionId).toBeTruthy();
  });

  it('a request after the session is established without the Mcp-Session-Id header is rejected, same as the real server', async () => {
    installFakeMcpServer({ tools: [] });
    const transport = new McpStreamableHttpTransport({ url: 'https://shop.example/mcp-http', transport: 'streamable-http' });
    await transport.send({ jsonrpc: '2.0', id: 'r1', method: 'initialize', params: {} });

    // Simulate "forgot the session id" by sending through a fresh
    // transport instance that never saw the first response's header. The
    // fake 400s that, same as the real server's `validateSession` would —
    // this transport surfaces any non-OK HTTP response as a rejection,
    // not a JSON-RPC error result.
    const forgetful = new McpStreamableHttpTransport({ url: 'https://shop.example/mcp-http', transport: 'streamable-http' });
    await expect(forgetful.send({ jsonrpc: '2.0', id: 'r2', method: 'tools/list' })).rejects.toThrow();
  });

  it('sends every request with redirect: "error"', async () => {
    const server = installFakeMcpServer({ tools: [] });
    const transport = new McpStreamableHttpTransport({ url: 'https://shop.example/mcp-http', transport: 'streamable-http' });
    await transport.send({ jsonrpc: '2.0', id: 'r1', method: 'initialize', params: {} });
    await transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });

    expect(server.requests.length).toBeGreaterThan(0);
    for (const req of server.requests) {
      expect(req.redirect).toBe('error');
    }
  });

  /**
   * A real `fetch()` rejects on its own once the `AbortSignal` passed to
   * it fires — this fake mock models that one behaviour (never resolving
   * otherwise), so the timeout under test is the only thing that can end
   * either call.
   */
  function neverRespondingFetch() {
    return vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        reject(err);
      });
    }));
  }

  it('times out a request that never gets a response, instead of hanging forever', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', neverRespondingFetch());

    const transport = new McpStreamableHttpTransport({ url: 'https://shop.example/mcp-http', transport: 'streamable-http', timeout: 5000 });
    const send = transport.send({ jsonrpc: '2.0', id: 'r1', method: 'initialize', params: {} });

    const assertion = expect(send).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
  });

  it('times out notify() the same way', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', neverRespondingFetch());

    const transport = new McpStreamableHttpTransport({ url: 'https://shop.example/mcp-http', transport: 'streamable-http', timeout: 5000 });
    const notify = transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const assertion = expect(notify).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
  });
});

/**
 * Harbor must not write what a site's own server sends to the console —
 * same invariant as page-api/__tests__/no-payload-logs.test.ts, here for
 * an unsolicited (no matching pending request) notification a server
 * pushes, which both SSE and WebSocket log.
 */
describe('logging a server-pushed notification never includes its body', () => {
  const SECRET = 'MARKER-notif-7f3a';

  function captureConsole(): { logged: string[]; restore: () => void } {
    const logged: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      }),
    );
    return { logged, restore: () => spies.forEach((s) => s.mockRestore()) };
  }

  it('over SSE', async () => {
    const server = installFakeMcpServer({ tools: [] });
    const transport = new McpSseTransport({ url: 'https://shop.example/mcp', transport: 'sse' });
    await transport.connect();

    const { logged, restore } = captureConsole();
    server.sseConnections[0].pushNotification({ jsonrpc: '2.0', method: 'notifications/secret_update', params: { value: SECRET } });
    restore();

    expect(logged.some((line) => line.includes(SECRET))).toBe(false);
  });

  it('over WebSocket', async () => {
    const server = installFakeMcpServer({ tools: [] });
    const transport = new McpWebSocketTransport({ url: 'https://shop.example/mcp-ws', transport: 'websocket' });
    await transport.connect();

    const { logged, restore } = captureConsole();
    server.webSocketConnections[0].pushNotification({ jsonrpc: '2.0', method: 'notifications/secret_update', params: { value: SECRET } });
    restore();

    expect(logged.some((line) => line.includes(SECRET))).toBe(false);
  });
});
