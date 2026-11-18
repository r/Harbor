/**
 * Page chat is opened through agent.chat.open, which checks permissions and
 * uses the requesting tab. No other message injects the chat panel.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

type Listener = (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;

describe('page chat handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles the chat panel messages but nothing that opens it', async () => {
    const listeners: Listener[] = [];
    vi.spyOn(chrome.runtime.onMessage, 'addListener').mockImplementation((l) => {
      listeners.push(l as Listener);
    });
    const executeScript = vi.fn(async () => []);
    (chrome as unknown as { scripting: unknown }).scripting = { executeScript };

    vi.resetModules();
    const { registerPageChatHandlers } = await import('../page-chat-handlers');
    registerPageChatHandlers();

    const handles = (type: string): boolean =>
      listeners.some((l) => l({ type, tabId: 1 }, {}, () => {}) === true);

    expect(handles('page_chat_ping')).toBe(true);
    expect(handles('open_page_chat')).toBe(false);
    expect(executeScript).not.toHaveBeenCalled();
  });
});

vi.mock('../../llm/chat', () => ({ bridgeChat: vi.fn(async () => ({ content: 'MARKER-7f3a-reply' })) }));

describe('page chat logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not log the chat message or the reply', async () => {
    const listeners: Listener[] = [];
    vi.spyOn(chrome.runtime.onMessage, 'addListener').mockImplementation((l) => {
      listeners.push(l as Listener);
    });
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });

    vi.resetModules();
    const { registerPageChatHandlers } = await import('../page-chat-handlers');
    registerPageChatHandlers();

    const done = new Promise((resolve) => {
      for (const l of listeners) {
        l({ type: 'page_chat_message', chatId: 'c1', message: 'MARKER-7f3a-question' }, {}, resolve);
      }
    });
    await done;
    expect(lines.filter((l) => l.includes('MARKER-7f3a'))).toEqual([]);
  });
});
