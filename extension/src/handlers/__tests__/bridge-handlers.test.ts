/**
 * The bridge handlers serve bridge status to Harbor's own pages. None of them
 * forwards an arbitrary method to the native bridge: any extension context can
 * send runtime messages, including the content script on every site, so a
 * generic passthrough would skip every permission check.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

const bridgeRequest = vi.hoisted(() => vi.fn());
vi.mock('../../llm/bridge-client', () => ({
  getBridgeConnectionState: () => ({ connected: true, bridgeReady: true, error: null }),
  checkBridgeHealth: async () => undefined,
  bridgeRequest,
}));
vi.mock('../../llm/native-bridge', () => ({
  getConnectionState: () => ({ connected: true }),
  connectNativeBridge: vi.fn(),
}));

type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
) => boolean | void;

const listeners: Listener[] = [];

beforeAll(async () => {
  const chrome = (globalThis as unknown as { chrome: { runtime: { onMessage: { addListener: (l: Listener) => void } } } }).chrome;
  chrome.runtime.onMessage.addListener = (l: Listener) => {
    listeners.push(l);
  };
  const mod = await import('../bridge-handlers');
  mod.registerBridgeHandlers();
});

describe('bridge handlers', () => {
  it('have no generic passthrough to the native bridge', () => {
    const sendResponse = vi.fn();
    const sender = { tab: { id: 1 }, url: 'https://example.test/' } as chrome.runtime.MessageSender;
    const handled = listeners.map((l) =>
      l({ type: 'bridge_rpc', method: 'llm.chat', params: { messages: [] } }, sender, sendResponse),
    );

    expect(handled.some(Boolean)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(bridgeRequest).not.toHaveBeenCalled();
  });

  it('still answer bridge status requests', () => {
    const sendResponse = vi.fn();
    const handled = listeners.map((l) =>
      l({ type: 'bridge_get_status' }, {} as chrome.runtime.MessageSender, sendResponse),
    );

    expect(handled.some(Boolean)).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });
});
