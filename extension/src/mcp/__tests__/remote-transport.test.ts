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
});
