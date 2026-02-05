/**
 * Chat handlers for page-embedded chat UI.
 */

import type { RequestContext, ResponseSender } from './router-types';
import { log } from './helpers';
import { browserAPI } from '../../browser-compat';
import { checkPermissions } from '../../policy/permissions';

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

// Chat ID counter
let chatIdCounter = 0;

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

  // Check permission
  const hasPermission = await checkPermissions(ctx.origin, ['chat:open']);
  if (!hasPermission) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Permission "chat:open" is required. Call agent.requestPermissions() first.',
      },
    });
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

  // Generate chat ID
  const chatId = `chat-${Date.now()}-${++chatIdCounter}`;

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
      files: ['dist/page-chat.js'],
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
    // Close specific chat
    const chat = activeChats.get(chatId);
    if (chat) {
      try {
        await browserAPI.tabs.sendMessage(chat.tabId, {
          type: 'harbor_chat_close',
          chatId,
        });
      } catch {
        // Tab might be closed
      }
      activeChats.delete(chatId);
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
      }
    }
  }

  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: { success: true },
  });
}
