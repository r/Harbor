import { describe, expect, it, vi } from 'vitest';
import {
  isTrustedChatPage,
  resolveChatTransportIdentity,
} from './transport-context';

const CHAT_PAGE_URL = 'moz-extension://harbor/chat.html';

describe('isTrustedChatPage', () => {
  it('accepts the Harbor chat page with launch parameters', () => {
    expect(
      isTrustedChatPage(
        `${CHAT_PAGE_URL}?launch=opaque-id`,
        CHAT_PAGE_URL,
      ),
    ).toBe(true);
  });

  it('rejects other extension pages', () => {
    expect(
      isTrustedChatPage(
        'moz-extension://harbor/sidebar.html',
        CHAT_PAGE_URL,
      ),
    ).toBe(false);
  });
});

describe('resolveChatTransportIdentity', () => {
  it('uses the chat page identity when no source page is attached', async () => {
    const getTab = vi.fn();

    await expect(
      resolveChatTransportIdentity(undefined, CHAT_PAGE_URL, 42, getTab),
    ).resolves.toEqual({
      origin: 'moz-extension://harbor',
      tabId: 42,
    });
    expect(getTab).not.toHaveBeenCalled();
  });

  it('binds requests to the exact source tab', async () => {
    const source = {
      tabId: 7,
      windowId: 3,
      url: 'https://example.com/article',
      title: 'Article',
      origin: 'https://example.com',
    };

    await expect(
      resolveChatTransportIdentity(
        source,
        CHAT_PAGE_URL,
        42,
        async () => ({
          id: 7,
          windowId: 3,
          url: 'https://example.com/article',
        }),
      ),
    ).resolves.toEqual({
      origin: 'https://example.com',
      tabId: 7,
    });
  });

  it('rejects a source tab that navigated after launch', async () => {
    const source = {
      tabId: 7,
      windowId: 3,
      url: 'https://example.com/article',
      title: 'Article',
      origin: 'https://example.com',
    };

    await expect(
      resolveChatTransportIdentity(
        source,
        CHAT_PAGE_URL,
        42,
        async () => ({
          id: 7,
          windowId: 3,
          url: 'https://example.com/other',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'ERR_SOURCE_TAB_STALE',
    });
  });
});
