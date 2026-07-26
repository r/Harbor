import { describe, expect, it, vi } from 'vitest';
import { chatLaunchStorageKey, type ChatLaunchStorage } from './chat-launch';
import { launchSidebarChat } from './sidebar-chat-launcher';

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

describe('launchSidebarChat', () => {
  it('opens production chat with the active page launch envelope', async () => {
    const storage = createStorage();
    const query = vi.fn().mockResolvedValue([{
      id: 42,
      windowId: 7,
      url: 'https://example.com/article',
      title: 'Article',
    }]);
    const create = vi.fn().mockResolvedValue(undefined);

    await launchSidebarChat({
      runtime: {
        getURL: path => `moz-extension://harbor/${path}`,
      },
      storage: { local: storage },
      tabs: { query, create },
    }, {
      createId: () => 'launch-1',
      now: () => 1_000,
    });

    expect(query).toHaveBeenCalledWith({
      active: true,
      currentWindow: true,
    });
    expect(create).toHaveBeenCalledWith({
      url: 'moz-extension://harbor/chat.html?launch=launch-1',
    });
    expect(storage.values[chatLaunchStorageKey('launch-1')]).toEqual({
      version: 1,
      launchId: 'launch-1',
      source: {
        tabId: 42,
        windowId: 7,
        url: 'https://example.com/article',
        title: 'Article',
        origin: 'https://example.com',
      },
      createdAt: 1_000,
      expiresAt: 601_000,
    });
  });

  it('opens production chat without context when no tab is active', async () => {
    const create = vi.fn().mockResolvedValue(undefined);

    await launchSidebarChat({
      runtime: {
        getURL: path => `moz-extension://harbor/${path}`,
      },
      storage: { local: createStorage() },
      tabs: {
        query: vi.fn().mockResolvedValue([]),
        create,
      },
    });

    expect(create).toHaveBeenCalledWith({
      url: 'moz-extension://harbor/chat.html',
    });
  });
});
