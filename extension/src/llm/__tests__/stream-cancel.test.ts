import { beforeEach, describe, expect, it, vi } from 'vitest';

// When a page stops reading a streaming prompt, Harbor stops the model's
// stream in the bridge (llm.cancel_stream), not just its own listener, and
// a stream waiting for its next token ends as soon as it's cancelled.

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

const sent = (method: string) =>
  port.postMessage.mock.calls.map(([m]) => m as { method?: string; id?: string; params?: { id?: string } })
    .filter((m) => m.method === method);

const streamId = () => sent('llm.chat_stream')[0].id!;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('cancelling a chat stream', () => {
  it('asks the bridge to stop a stream that is still running', async () => {
    const bridge = await connectedBridge();
    const { cancel, done } = bridge.rpcStreamRequest('llm.chat_stream', { messages: [] }, () => {});
    done.catch(() => {});
    const id = streamId();
    port.onMessage!({ type: 'stream', id, event: { type: 'token', token: 'Hel' } });

    cancel();

    expect(sent('llm.cancel_stream').map((m) => m.params)).toEqual([{ id }]);
  });

  it("doesn't ask the bridge to stop a stream that already finished", async () => {
    const bridge = await connectedBridge();
    const { cancel, done } = bridge.rpcStreamRequest('llm.chat_stream', { messages: [] }, () => {});
    const id = streamId();
    port.onMessage!({ type: 'stream', id, event: { type: 'done', finish_reason: 'stop' } });
    await done;

    cancel();

    expect(sent('llm.cancel_stream')).toHaveLength(0);
  });

  it('ends a stream waiting for its next token as soon as its signal aborts, and stops it in the bridge', async () => {
    const bridge = await connectedBridge();
    const { bridgeStreamRequest } = await import('../bridge-client');
    const controller = new AbortController();
    const events: string[] = [];
    const reading = (async () => {
      for await (const event of bridgeStreamRequest('llm.chat_stream', { messages: [] }, controller.signal)) {
        events.push(event.type);
        if (event.type === 'token') controller.abort(); // the page stopped reading
      }
    })();
    await vi.waitFor(() => expect(sent('llm.chat_stream')).toHaveLength(1));
    const id = streamId();
    port.onMessage!({ type: 'stream', id, event: { type: 'token', token: 'Hel' } });

    // No further event arrives from the model, yet the read ends.
    await reading;
    expect(events).toEqual(['token']);
    expect(sent('llm.cancel_stream').map((m) => m.params)).toEqual([{ id }]);
    void bridge;
  });

  it('never starts a stream whose signal already aborted', async () => {
    await connectedBridge();
    const { bridgeStreamRequest } = await import('../bridge-client');
    const controller = new AbortController();
    controller.abort();
    const events: string[] = [];
    for await (const event of bridgeStreamRequest('llm.chat_stream', { messages: [] }, controller.signal)) events.push(event.type);
    expect(events).toEqual([]);
    expect(sent('llm.chat_stream')).toHaveLength(0);
  });

  it("doesn't ask the bridge to stop a chat stream that ended with an error", async () => {
    const bridge = await connectedBridge();
    const { cancel, done } = bridge.rpcStreamRequest('llm.chat_stream', { messages: [] }, () => {});
    done.catch(() => {});
    const id = streamId();
    // The bridge ends a chat stream after an error event; it carries no `fatal` flag.
    port.onMessage!({ type: 'stream', id, event: { type: 'error', error: { code: -1, message: 'rate limited' } } });

    cancel();

    expect(sent('llm.cancel_stream')).toHaveLength(0);
  });

  it("doesn't ask a disconnected bridge to stop anything", async () => {
    const bridge = await connectedBridge();
    const { cancel, done } = bridge.rpcStreamRequest('llm.chat_stream', { messages: [] }, () => {});
    done.catch(() => {});
    bridge.disconnectNativeBridge();

    expect(() => cancel()).not.toThrow();
    expect(sent('llm.cancel_stream')).toHaveLength(0);
  });

  it('never sends llm.cancel_stream for an acp.open stream', async () => {
    const bridge = await connectedBridge();
    const { cancel, done } = bridge.rpcStreamRequest('acp.open', { agentId: 'a', workspace: 'w' }, () => {});
    done.catch(() => {});
    cancel();
    expect(sent('llm.cancel_stream')).toHaveLength(0);
  });

  it("stops listening to the caller's signal once the stream ends", async () => {
    await connectedBridge();
    const { bridgeStreamRequest } = await import('../bridge-client');
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const reading = (async () => {
      for await (const _event of bridgeStreamRequest('llm.chat_stream', { messages: [] }, controller.signal)) { /* drain */ }
    })();
    await vi.waitFor(() => expect(sent('llm.chat_stream')).toHaveLength(1));
    port.onMessage!({ type: 'stream', id: streamId(), event: { type: 'done', finish_reason: 'stop' } });
    await reading;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

