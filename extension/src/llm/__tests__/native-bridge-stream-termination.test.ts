import { beforeEach, describe, expect, it, vi } from 'vitest';

// native-bridge.ts's `handleMessage` decides when a bridge stream has
// ended once for every streaming RPC, llm.chat_stream's token/done/error
// convention and acp.open's open/message/exit convention alike (see
// page-api/harbor-core.ts's AcpBridgeEvent and bridge-rs/README.md "ACP
// agents"). An acp stream's recoverable per-line errors (a dropped
// oversized line, a broken stdin write) must not end it the way a `done`
// or a fatal `error` does, or a live channel's later `message`/`exit`
// events would never reach its caller.

const port = vi.hoisted(() => ({
  onMessage: null as null | ((message: unknown) => void),
  postMessage: vi.fn(),
}));

vi.mock('../../browser-compat', () => ({
  isSafari: () => false,
  browserAPI: {
    runtime: {
      connectNative: () => ({
        onMessage: { addListener: (l: (message: unknown) => void) => { port.onMessage = l; } },
        onDisconnect: { addListener: () => {} },
        postMessage: port.postMessage,
        disconnect: () => {},
      }),
    },
  },
}));

async function connectedBridge() {
  vi.resetModules();
  port.onMessage = null;
  port.postMessage.mockClear();
  const bridge = await import('../native-bridge');
  bridge.connectNativeBridge();
  port.onMessage!({ type: 'status', status: 'ready', message: '' });
  return bridge;
}

function openedStreamId(method: string): string {
  const call = port.postMessage.mock.calls.find(([m]) => (m as { method?: string }).method === method);
  if (!call) throw new Error(`no postMessage call for ${method}`);
  return (call[0] as { id: string }).id;
}

beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));

describe('native-bridge stream termination', () => {
  it('keeps an acp.open stream open across a non-fatal error, delivering message and exit after it', async () => {
    const bridge = await connectedBridge();
    const events: Array<{ type: string }> = [];
    const { done } = bridge.rpcStreamRequest('acp.open', { agentId: 'a', workspace: 'w' }, (e) => events.push(e));
    const id = openedStreamId('acp.open');

    port.onMessage!({ type: 'stream', id, event: { type: 'open', channel: 'ch-1' } });
    // A dropped oversized line, or a broken stdin write: recoverable, no `fatal`.
    port.onMessage!({ type: 'stream', id, event: { type: 'error', message: 'dropped oversized line' } });
    port.onMessage!({ type: 'stream', id, event: { type: 'message', message: { jsonrpc: '2.0', method: 'x' } } });

    expect(events.map((e) => e.type)).toEqual(['open', 'error', 'message']);

    port.onMessage!({ type: 'stream', id, event: { type: 'exit', code: 0 } });
    await done;

    expect(events.map((e) => e.type)).toEqual(['open', 'error', 'message', 'exit']);
  });

  it('ends the stream on a fatal acp error, and ignores anything sent for it afterward', async () => {
    const bridge = await connectedBridge();
    const events: Array<{ type: string }> = [];
    const { done } = bridge.rpcStreamRequest('acp.open', { agentId: 'a', workspace: 'w' }, (e) => events.push(e));
    const id = openedStreamId('acp.open');

    port.onMessage!({ type: 'stream', id, event: { type: 'error', fatal: true, message: 'unknown agent' } });
    await expect(done).rejects.toThrow('unknown agent');

    const countAfterFatal = events.length;
    port.onMessage!({ type: 'stream', id, event: { type: 'message', message: { jsonrpc: '2.0', method: 'y' } } });
    expect(events).toHaveLength(countAfterFatal);
  });

  it('ends an llm.chat_stream stream on "done", unaffected by the acp termination rule', async () => {
    const bridge = await connectedBridge();
    const events: Array<{ type: string }> = [];
    const { done } = bridge.rpcStreamRequest('llm.chat_stream', { messages: [] }, (e) => events.push(e));
    const id = openedStreamId('llm.chat_stream');

    port.onMessage!({ type: 'stream', id, event: { type: 'token', token: 'hi' } });
    port.onMessage!({ type: 'stream', id, event: { type: 'done' } });
    await done;

    expect(events.map((e) => e.type)).toEqual(['token', 'done']);
  });
});
