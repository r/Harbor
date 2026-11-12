/**
 * Page Chat Handlers
 * 
 * Handlers for the built-in page chat feature.
 */

import { bridgeChat } from '../llm/chat';
import { registerHandler, errorResponse } from './types';
import { browserAPI } from '../browser-compat';

export function registerPageChatHandlers(): void {
  // Ping handler for connectivity check
  registerHandler('page_chat_ping', (_message, _sender, sendResponse) => {
    sendResponse({ ok: true });
    return true;
  });

  // Handle page chat messages
  registerHandler('page_chat_message', (message, _sender, sendResponse) => {
    const { chatId, message: userMessage, systemPrompt, tools, pageContext } = message as {
      chatId?: string;
      message?: string;
      systemPrompt?: string;
      tools?: string[];
      pageContext?: { url: string; title: string };
    };

    console.log('[Harbor] page_chat_message:', chatId, userMessage?.slice(0, 50));

    if (!userMessage) {
      sendResponse({ type: 'error', error: { message: 'Missing message' }, ok: false });
      return true;
    }

    (async () => {
      try {
        const messages = [
          { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
          { role: 'user', content: userMessage },
        ];

        const toolsUsed: Array<{ name: string }> = [];

        const result = await bridgeChat({
          messages,
          max_tokens: 2000,
        });

        const responseText = result.content;

        console.log('[Harbor] page_chat_message response:', responseText.slice(0, 100));

        sendResponse({
          type: 'page_chat_response',
          response: responseText,
          toolsUsed,
          ok: true,
        });
      } catch (err) {
        console.error('[Harbor] page_chat_message error:', err);
        sendResponse({
          type: 'error',
          error: { message: err instanceof Error ? err.message : 'Unknown error' },
          ok: false,
        });
      }
    })();

    return true;
  });

  // Open page chat in tab
  registerHandler('open_page_chat', (message, _sender, sendResponse) => {
    const tabId = message.tabId as number | undefined;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Missing tabId' });
      return true;
    }
    (async () => {
      try {
        await browserAPI.scripting.executeScript({
          target: { tabId },
          files: ['dist/page-chat.js'],
        });
        console.log('[Harbor] Page chat injected into tab', tabId);
        sendResponse({ ok: true });
      } catch (err) {
        console.error('[Harbor] Failed to inject page chat:', err);
        sendResponse(errorResponse(err));
      }
    })();
    return true;
  });
}
