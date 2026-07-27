import { describe, expect, it, vi } from 'vitest';
import { createChatTransport } from './chat-transport';

type Listener = (message?: unknown) => void;

function createPort() {
  let messageListener: Listener = () => {};
  let disconnectListener: Listener = () => {};
  const port = {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener(listener: Listener) {
        messageListener = listener;
      },
    },
    onDisconnect: {
      addListener(listener: Listener) {
        disconnectListener = listener;
      },
    },
  };

  return {
    port,
    emitMessage(message: unknown) {
      messageListener(message);
    },
    disconnect() {
      disconnectListener();
    },
  };
}

describe('createChatTransport', () => {
  it('resolves request responses by id', async () => {
    const runtime = createPort();
    const transport = createChatTransport(runtime.port as never);
    const request = transport.request<string>('session.prompt', {
      input: 'Hello',
    });
    const sent = runtime.port.postMessage.mock.calls[0][0];

    runtime.emitMessage({
      id: sent.id,
      ok: true,
      result: 'Hi',
    });

    await expect(request).resolves.toBe('Hi');
  });

  it('delivers streamed events in order', async () => {
    const runtime = createPort();
    const transport = createChatTransport(runtime.port as never);
    const events = transport.stream<{ type: string }>('agent.run');
    const sent = runtime.port.postMessage.mock.calls[0][0];
    const iterator = events[Symbol.asyncIterator]();

    runtime.emitMessage({
      id: sent.id,
      event: { type: 'status' },
    });
    runtime.emitMessage({
      id: sent.id,
      event: { type: 'final' },
      done: true,
    });

    await expect(iterator.next()).resolves.toEqual({
      value: { type: 'status' },
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: { type: 'final' },
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it('rejects pending requests when the port disconnects', async () => {
    const runtime = createPort();
    const transport = createChatTransport(runtime.port as never);
    const request = transport.request('agent.permissions.list');

    runtime.disconnect();

    await expect(request).rejects.toThrow(
      'Harbor chat transport disconnected',
    );
  });
});
