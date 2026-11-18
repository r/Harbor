import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '../bridge-client';

// Safari reaches the bridge over HTTP, which has no streaming method. A
// streamed chat must become one `llm.chat` call whose reply arrives as a
// single token.
vi.mock('../../browser-compat', () => ({
  isSafari: () => true,
  browserAPI: { runtime: {} },
}));

type RpcBody = { method: string; params: Record<string, unknown> };

const completion = {
  model: 'ollama:test',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
};

let rpcCalls: RpcBody[];

function stubBridge(chat: (body: RpcBody) => unknown) {
  rpcCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.endsWith('/health')) return new Response('{}', { status: 200 });
    const body = JSON.parse(init!.body!) as RpcBody & { id: string };
    rpcCalls.push(body);
    if (body.method === 'system.health') {
      return Response.json({ id: body.id, result: { status: 'ok' } });
    }
    return Response.json({ id: body.id, ...(chat(body) as object) });
  }));
}

async function connectedBridge() {
  vi.resetModules();
  const bridge = await import('../native-bridge');
  bridge.connectNativeBridge();
  await vi.waitFor(() => expect(bridge.isNativeBridgeReady()).toBe(true));
  return bridge;
}

async function collect(bridge: typeof import('../native-bridge'), params: unknown) {
  const events: StreamEvent[] = [];
  const { done } = bridge.rpcStreamRequest('llm.chat_stream', params, (e) => events.push(e));
  await done.catch(() => {});
  return events;
}

beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));
afterEach(async () => {
  (await import('../native-bridge')).disconnectNativeBridge();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Safari streaming over the HTTP bridge', () => {
  it('sends llm.chat without streaming and yields the reply as one token', async () => {
    stubBridge((body) => body.method === 'llm.chat'
      ? { result: completion }
      : { error: { code: -32601, message: `Unknown method: ${body.method}` } });
    const bridge = await connectedBridge();

    const events = await collect(bridge, { messages: [{ role: 'user', content: 'ping' }] });

    const chat = rpcCalls.find((c) => c.method !== 'system.health');
    expect(chat).toMatchObject({ method: 'llm.chat', params: { safari_no_stream: true } });
    expect(events.map((e) => e.type)).toEqual(['token', 'done']);
    expect(events[0].token).toBe('pong');
    expect(events[1]).toMatchObject({ finish_reason: 'stop', model: 'ollama:test' });
  });

  it('reports a bridge error as an error event', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubBridge(() => ({ error: { code: -1, message: 'Provider unavailable' } }));
    const bridge = await connectedBridge();

    const events = await collect(bridge, { messages: [{ role: 'user', content: 'ping' }] });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { message: expect.stringContaining('Provider unavailable') } });
  });
});
