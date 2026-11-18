/**
 * Chat API Handlers
 * 
 * Handles chat opening/closing for BYOC (Bring Your Own Chatbot).
 */

import { harborRequest } from '../harbor-client';
import type { RequestContext, HandlerResponse } from './types';
import { errorResponse, successResponse } from './types';

// =============================================================================
// Handlers
// =============================================================================

export async function handleChatCanOpen(ctx: RequestContext): HandlerResponse {
  try {
    const result = await harborRequest<{ available: boolean; reason?: string }>('agent.chat.canOpen', {
      origin: ctx.origin,
    });
    return successResponse(ctx.id, result);
  } catch (e) {
    return errorResponse(
      ctx.id,
      'ERR_CHAT',
      e instanceof Error ? e.message : 'Failed to check chat availability'
    );
  }
}

export async function handleChatOpen(ctx: RequestContext): HandlerResponse {
  const { systemPrompt, initialMessage, tools, style } = (ctx.payload || {}) as {
    systemPrompt?: string;
    initialMessage?: string;
    tools?: string[];
    style?: {
      theme?: 'light' | 'dark' | 'auto';
      accentColor?: string;
      position?: 'right' | 'left';
    };
  };

  try {
    const result = await harborRequest<{
      success: boolean;
      chatId?: string;
      error?: { code: string; message: string };
    }>('agent.chat.open', {
      origin: ctx.origin,
      tabId: ctx.tabId,
      systemPrompt,
      initialMessage,
      tools,
      style,
    });
    return successResponse(ctx.id, result);
  } catch (e) {
    return errorResponse(
      ctx.id,
      'ERR_CHAT_OPEN',
      e instanceof Error ? e.message : 'Failed to open chat'
    );
  }
}

export async function handleChatClose(ctx: RequestContext): HandlerResponse {
  const { chatId } = ctx.payload as { chatId: string };

  if (!chatId) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing chatId');
  }

  try {
    const result = await harborRequest<{ success: boolean }>('agent.chat.close', {
      origin: ctx.origin,
      chatId,
    });
    return successResponse(ctx.id, result);
  } catch (e) {
    return errorResponse(
      ctx.id,
      'ERR_CHAT_CLOSE',
      e instanceof Error ? e.message : 'Failed to close chat'
    );
  }
}
