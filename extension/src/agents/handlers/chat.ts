/**
 * Chat handlers for page-embedded chat UI.
 */

import type { RequestContext, ResponseSender } from './router-types';
import { log, requireAction } from './helpers';
import { browserAPI } from '../../browser-compat';
import { closeAgentChatSession } from '../../handlers/page-chat-agent-sessions';

// =============================================================================
// State Management
// =============================================================================

// Active page chats
const activeChats = new Map<string, {
  chatId: string;
  tabId: number;
  origin: string;
  config: {
    initialMessage?: string;
    systemPrompt?: string;
    tools?: string[];
    style?: {
      theme?: 'light' | 'dark' | 'auto';
      accentColor?: string;
      position?: 'right' | 'left' | 'center';
    };
  };
  createdAt: number;
}>();

/**
 * The tab, origin and config of a chat opened with agent.chat.open, or
 * undefined if no such chat is open.
 */
export function getActiveChat(chatId: string) {
  return activeChats.get(chatId);
}

/**
 * Drops one open chat — a tab's own port disconnecting (a real navigation
 * or reload; handlers/page-chat-handlers.ts's `runtime.onConnect`
 * listener) ends that specific chat, not necessarily every chat in its
 * tab. Called alongside ending the chat's agent session
 * (handlers/page-chat-agent-sessions.ts), so there's one teardown path for
 * both. Doesn't message the tab (unlike `handleChatClose`): the content
 * script's old page is already gone. A later `page_chat_message` for a
 * dropped chat gets the same "This chat is not open on this page" refusal
 * a chat that was never opened gets.
 */
export function forgetChat(chatId: string): void {
  activeChats.delete(chatId);
}

/**
 * Drops every open chat whose tab is `tabId` — the tab closing outright.
 * Called from handlers/page-chat-handlers.ts's own `tabs.onRemoved`
 * listener, the backstop for `forgetChat`'s own port-disconnect signal
 * (a port can, in principle, fail to fire its disconnect event before the
 * tab itself is gone).
 */
export function forgetChatsForTab(tabId: number): void {
  for (const [id, chat] of activeChats) {
    if (chat.tabId === tabId) activeChats.delete(id);
  }
}

// =============================================================================
// Chat Handlers
// =============================================================================

/**
 * Handle agent.chat.canOpen - Check if chat can be opened.
 */
export function handleChatCanOpen(
  ctx: RequestContext,
  sender: ResponseSender,
): void {
  // Chat is available as long as we have the scripting permission
  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: 'readily',
  });
}

/**
 * Handle agent.chat.open - Open a chat interface on the page.
 */
export async function handleChatOpen(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const payload = ctx.payload as {
    initialMessage?: string;
    systemPrompt?: string;
    tools?: string[];
    sessionId?: string;
    style?: {
      theme?: 'light' | 'dark' | 'auto';
      accentColor?: string;
      position?: 'right' | 'left' | 'center';
    };
  } | undefined;

  if (!(await requireAction(ctx, sender, 'chat.open', {
    promptAsScope: 'chat:open',
    reason: 'Open the chat surface on this page',
  }))) {
    return;
  }

  // Get the tab ID
  const tabId = ctx.tabId;
  if (!tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: 'No tab ID available',
      },
    });
    return;
  }

  // An unguessable chat ID: page_chat_message, page_chat_closed and this
  // handler's own close-by-chatId path below all trust whoever names a
  // chatId to be the page that actually holds it, checked against the
  // sender's own tab/origin — a predictable id (the old `chat-<ms>-<n>`)
  // would let another site's page guess a live one and act on it before
  // that check ever ran.
  const chatId = crypto.randomUUID();

  // Store chat state
  activeChats.set(chatId, {
    chatId,
    tabId,
    origin: ctx.origin,
    config: {
      initialMessage: payload?.initialMessage,
      systemPrompt: payload?.systemPrompt,
      tools: payload?.tools,
      style: payload?.style,
    },
    createdAt: Date.now(),
  });

  try {
    // Inject config first
    await browserAPI.scripting.executeScript({
      target: { tabId },
      func: (config: unknown) => {
        (window as unknown as { __harborPageChatConfig: unknown }).__harborPageChatConfig = config;
      },
      args: [{
        chatId,
        initialMessage: payload?.initialMessage,
        systemPrompt: payload?.systemPrompt,
        tools: payload?.tools,
        style: payload?.style,
      }],
    });

    // Then inject page-chat.js
    await browserAPI.scripting.executeScript({
      target: { tabId },
      files: ['page-chat.js'],
    });

    log('Page chat injected into tab', tabId, 'with chatId', chatId);

    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: { success: true, chatId },
    });
  } catch (err) {
    log('Failed to inject page chat:', err);
    activeChats.delete(chatId);
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: `Failed to open chat: ${err instanceof Error ? err.message : 'Unknown error'}`,
      },
    });
  }
}

/**
 * Handle agent.chat.close - Close a chat interface.
 */
export async function handleChatClose(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const payload = ctx.payload as { chatId?: string } | undefined;
  const chatId = payload?.chatId;

  if (chatId) {
    // Close specific chat — only when it's this *caller's own* chat: the
    // origin that opened it, and (when the caller's own tab is known) the
    // tab it opened in. Without this, a site could close another site's
    // chat by guessing or otherwise learning its chatId; a mismatch is
    // treated exactly like a chatId that doesn't exist (same `ok: true`
    // response either way, so a probing site learns nothing from it).
    const chat = activeChats.get(chatId);
    if (chat && chat.origin === ctx.origin && (ctx.tabId === undefined || chat.tabId === ctx.tabId)) {
      try {
        await browserAPI.tabs.sendMessage(chat.tabId, {
          type: 'harbor_chat_close',
          chatId,
        });
      } catch {
        // Tab might be closed
      }
      activeChats.delete(chatId);
      // A no-op when this chat ran on the built-in model (no agent session
      // was ever opened for it).
      await closeAgentChatSession(chatId);
    }
  } else {
    // Close all chats for this origin
    for (const [id, chat] of activeChats) {
      if (chat.origin === ctx.origin) {
        try {
          await browserAPI.tabs.sendMessage(chat.tabId, {
            type: 'harbor_chat_close',
            chatId: id,
          });
        } catch {
          // Tab might be closed
        }
        activeChats.delete(id);
        await closeAgentChatSession(id);
      }
    }
  }

  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: { success: true },
  });
}
