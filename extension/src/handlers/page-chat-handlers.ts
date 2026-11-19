/**
 * Page Chat Handlers
 *
 * Handlers for the chat a page opens with agent.chat.open.
 *
 * Messages typed into that chat are the page's prompts: the page chose the
 * system prompt and tools, and page script can reach the chat's input. So
 * each message runs only in the tab and origin that opened the chat, and goes
 * through the policy engine under that origin, the way `llm.chat` does. The
 * decision is audited, and a refusal never reaches the model.
 */

import { bridgeChat } from '../llm/chat';
import { modelForPrompt } from '../llm/prompt-model';
import { getActiveChat } from '../agents/handlers/chat';
import { requireAction } from '../agents/handlers/helpers';
import type { RequestContext, ResponseSender } from '../agents/handlers/router-types';
import { promptActionForModel } from '../policy/actions';
import { registerHandler } from './types';

type ChatReply = (response: Record<string, unknown> & { ok: boolean }) => void;

function refuse(sendResponse: ChatReply, message: string, code = 'ERR_PERMISSION_DENIED'): void {
  sendResponse({ type: 'error', error: { message, code }, ok: false });
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function registerPageChatHandlers(): void {
  // Ping handler for connectivity check
  registerHandler('page_chat_ping', (_message, _sender, sendResponse) => {
    sendResponse({ ok: true });
    return true;
  });

  // Handle page chat messages
  registerHandler('page_chat_message', (message, sender, sendResponse) => {
    const { chatId, message: userMessage, systemPrompt } = message as {
      chatId?: string;
      message?: string;
      systemPrompt?: string;
    };

    console.log('[Harbor] page_chat_message:', chatId, { messageLength: userMessage?.length ?? 0 });

    if (!userMessage) {
      refuse(sendResponse, 'Missing message', 'ERR_INVALID_REQUEST');
      return true;
    }

    // The chat must be open, in the tab that sent this, on the origin that
    // opened it. The browser sets `sender`; the page can't.
    const chat = typeof chatId === 'string' ? getActiveChat(chatId) : undefined;
    const tabId = sender.tab?.id;
    const origin = originOf(sender.url);
    if (!chat || tabId === undefined || !origin || chat.tabId !== tabId || chat.origin !== origin) {
      refuse(sendResponse, 'This chat is not open on this page');
      return true;
    }

    (async () => {
      try {
        const ctx: RequestContext = {
          id: crypto.randomUUID(),
          type: 'llm.chat' as RequestContext['type'],
          payload: undefined,
          origin,
          tabId,
        };
        let refusal = 'Permission denied';
        let refusalCode = 'ERR_PERMISSION_DENIED';
        const policySender: ResponseSender = {
          sendResponse: (response) => {
            const err = (response as { error?: { code?: string; message?: string } }).error;
            refusal = err?.message ?? refusal;
            refusalCode = err?.code ?? refusalCode;
          },
          sendStreamEvent: () => {},
        };
        // The chat names no model, so it runs on the bridge's default.
        const action = promptActionForModel(await modelForPrompt(undefined));
        if (!(await requireAction(ctx, policySender, action, {
          reason: 'Send a message from this page\'s chat to your model',
        }))) {
          refuse(sendResponse, refusal, refusalCode);
          return;
        }

        const result = await bridgeChat({
          messages: [
            { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
            { role: 'user', content: userMessage },
          ],
          max_tokens: 2000,
        });

        console.log('[Harbor] page_chat_message response:', chatId, { responseLength: result.content.length });

        sendResponse({
          type: 'page_chat_response',
          response: result.content,
          toolsUsed: [],
          ok: true,
        });
      } catch (err) {
        console.error('[Harbor] page_chat_message error:', err);
        refuse(sendResponse, err instanceof Error ? err.message : 'Unknown error', 'ERR_INTERNAL');
      }
    })();

    return true;
  });
}
