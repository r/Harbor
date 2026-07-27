import { describe, expect, it, vi } from 'vitest';
import {
  chatLaunchStorageKey,
  consumeSourceTabLaunchEnvelope,
  createSourceTabLaunchEnvelope,
  launchHarborChat,
  type ChatLaunchStorage,
} from './chat-launch';

function createStorage(): ChatLaunchStorage & {
  values: Record<string, unknown>;
} {
  const values: Record<string, unknown> = {};
  return {
    values,
    async get(key) {
      return key in values ? { [key]: values[key] } : {};
    },
    async set(entries) {
      Object.assign(values, entries);
    },
    async remove(key) {
      delete values[key];
    },
  };
}

describe('Harbor chat launch', () => {
  it('binds the chat launch to the active HTTP tab', async () => {
    const storage = createStorage();
    const openTab = vi.fn();

    await launchHarborChat({
      getChatUrl: () => 'chrome-extension://harbor/chat.html',
      queryActiveTab: async () => ({
        id: 42,
        windowId: 7,
        url: 'https://example.com/article?draft=1',
        title: 'Article',
      }),
      openTab,
      storage,
    }, {
      createId: () => 'launch-1',
      now: () => 1_000,
    });

    expect(openTab).toHaveBeenCalledWith(
      'chrome-extension://harbor/chat.html?launch=launch-1',
    );
    expect(storage.values[chatLaunchStorageKey('launch-1')]).toEqual({
      version: 1,
      launchId: 'launch-1',
      source: {
        tabId: 42,
        windowId: 7,
        url: 'https://example.com/article?draft=1',
        title: 'Article',
        origin: 'https://example.com',
      },
      createdAt: 1_000,
      expiresAt: 601_000,
    });
  });

  it('opens chat without context for restricted sources', async () => {
    const storage = createStorage();
    const openTab = vi.fn();

    await launchHarborChat({
      getChatUrl: () => 'moz-extension://harbor/chat.html',
      queryActiveTab: async () => ({
        id: 42,
        windowId: 7,
        url: 'about:preferences',
        title: 'Settings',
      }),
      openTab,
      storage,
    });

    expect(openTab).toHaveBeenCalledWith('moz-extension://harbor/chat.html');
    expect(storage.values).toEqual({});
  });

  it('consumes a valid envelope once', async () => {
    const storage = createStorage();
    const envelope = createSourceTabLaunchEnvelope(
      {
        id: 42,
        windowId: 7,
        url: 'https://example.com/article',
        title: 'Article',
      },
      () => 'launch-1',
      () => 1_000,
    );
    await storage.set({
      [chatLaunchStorageKey('launch-1')]: envelope,
    });

    await expect(consumeSourceTabLaunchEnvelope(
      storage,
      'launch-1',
      () => 2_000,
    )).resolves.toEqual(envelope);
    await expect(consumeSourceTabLaunchEnvelope(
      storage,
      'launch-1',
      () => 2_000,
    )).resolves.toBeNull();
  });

  it('rejects and removes expired envelopes', async () => {
    const storage = createStorage();
    const envelope = createSourceTabLaunchEnvelope(
      {
        id: 42,
        windowId: 7,
        url: 'https://example.com/article',
        title: 'Article',
      },
      () => 'launch-1',
      () => 1_000,
    );
    await storage.set({
      [chatLaunchStorageKey('launch-1')]: envelope,
    });

    await expect(consumeSourceTabLaunchEnvelope(
      storage,
      'launch-1',
      () => 700_000,
    )).resolves.toBeNull();
    expect(storage.values).toEqual({});
  });
});
