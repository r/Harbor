/**
 * Page Chat Handlers
 * 
 * Handlers for the built-in page chat feature.
 */

import { bridgeChat } from '../llm/chat';
import { registerHandler, errorResponse } from './types';

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

    console.log('[Harbor] page_chat_message:', chatId, { messageLength: userMessage?.length ?? 0 });

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

        console.log('[Harbor] page_chat_message response:', chatId, { responseLength: responseText.length });

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
}
