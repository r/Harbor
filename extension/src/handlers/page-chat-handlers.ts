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
 *
 * When the person has an ACP agent selected (docs/ACP_BACKEND_DESIGN.md
 * section 2), the chat runs on that agent instead: each message is gated as
 * `model.prompt.agent` rather than a prompt to Harbor's own model, and is
 * sent through this chat's own agent session (handlers/page-chat-agent-
 * sessions.ts), opened lazily on the first message and reused after that.
 * With no agent selected, this is unchanged from before: `bridgeChat`
 * (`llm.chat`) answers every message, with no session kept between them.
 */

import { bridgeChat } from '../llm/chat';
import { modelForPrompt } from '../llm/prompt-model';
import { getActiveChat, forgetChat, forgetChatsForTab } from '../agents/handlers/chat';
import { requireAction } from '../agents/handlers/helpers';
import type { RequestContext, ResponseSender } from '../agents/handlers/router-types';
import { promptActionForModel } from '../policy/actions';
import { readAgentBackendSetting, AGENT_BACKEND_STORAGE_KEY } from '../page-api/agent-backend-setting';
import {
  ensureAgentChatSession,
  closeAgentChatSession,
  closeAgentChatSessionsForTab,
  closeAllAgentChatSessions,
} from './page-chat-agent-sessions';
import { browserAPI } from '../browser-compat';
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

/** Whether `chatId` is still open, in the same tab and origin it was opened in. */
function chatStillOpen(chatId: string, tabId: number, origin: string): boolean {
  const chat = getActiveChat(chatId);
  return !!chat && chat.tabId === tabId && chat.origin === origin;
}

type BackendSetting = Awaited<ReturnType<typeof readAgentBackendSetting>>;

/** Whether two backend settings name the same backend (including both `null`, the built-in model). */
function sameBackend(a: BackendSetting, b: BackendSetting): boolean {
  if (a === null || b === null) return a === b;
  return a.type === b.type && a.agentId === b.agentId;
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
        const backendSetting = await readAgentBackendSetting();

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

        if (backendSetting) {
          // The site's origin is the principal, exactly as for the
          // built-in path below — only the typed action (and so the
          // audit record, the consent copy, and which grant applies)
          // differs: a prompt that reaches the person's own agent is
          // its own action, not a prompt to Harbor's own model.
          //
          // This creates its own audit record under `model.prompt.agent`,
          // and `session.prompt()` below creates a second one of its own
          // (AcpTextSession's own per-turn `requireAgentPromptAction` —
          // page-api/acp-text-session.ts). That's intentional, not an
          // oversight: it's the same shape a `window.ai` text session
          // already has, just with its first half audited too. A
          // `window.ai` prompt's own first check (`resolveTextSession`'s
          // `hasPermission`) is a raw grant read with no audit trail of
          // its own, so its *one* audited record comes entirely from the
          // per-turn check; page chat's own gate, unlike that one, can
          // itself show the consent dialog on a site's first message (it
          // has no separate `requestPermissions()` step to do that
          // instead), so it has to go through `requireAction` — and so be
          // audited — to do that. Making the per-turn check skip its own
          // audit for *this* caller only would need threading a flag
          // through the shared `AcpTextSession` that `window.ai` and
          // `agent.run` don't have a use for, and risks quietly weakening
          // the "every turn is audited" guarantee that's the whole point
          // of `model.prompt.agent` (ACP_BACKEND_DESIGN.md decision 6) for
          // those two callers. Two consistent records for one message
          // beats a shared code path that might audit zero.
          if (!(await requireAction(ctx, policySender, 'model.prompt.agent', {
            reason: 'Send a message from this page\'s chat to your agent',
          }))) {
            refuse(sendResponse, refusal, refusalCode);
            return;
          }

          // The check above can wait on a consent prompt for minutes —
          // long enough for the chat to close, navigate to another
          // document, or the backend to switch out from under it. Refuse
          // rather than open (or reuse) a session for a chat that, by the
          // time the person actually answered, is no longer the live one.
          const currentBackend = await readAgentBackendSetting();
          if (!chatStillOpen(chatId!, tabId, origin) || !sameBackend(currentBackend, backendSetting)) {
            refuse(sendResponse, 'This chat is not open on this page');
            return;
          }

          let session: Awaited<ReturnType<typeof ensureAgentChatSession>>;
          try {
            session = await ensureAgentChatSession(chatId!, backendSetting.agentId, origin, tabId, systemPrompt);
          } catch (e) {
            const code = (e as { code?: string }).code ?? 'ERR_AGENT_FAILED';
            refuse(sendResponse, e instanceof Error ? e.message : 'The agent failed to start', code);
            return;
          }

          // The same race can land while the agent itself was starting
          // (ensureAgentChatSession's own `open()` can take a while) — if
          // it did, this may have just opened a brand-new session for a
          // chat that's already gone (the close/navigate/backend-switch
          // teardown ran before this session existed to be torn down by
          // it); close it now rather than leave it, and its per-site cap
          // slot, live with nothing left able to reach it.
          if (!chatStillOpen(chatId!, tabId, origin) || !sameBackend(await readAgentBackendSetting(), backendSetting)) {
            await closeAgentChatSession(chatId!);
            refuse(sendResponse, 'This chat is not open on this page');
            return;
          }

          const result = await session.prompt(userMessage);
          if (!result.ok) {
            refuse(sendResponse, result.error.error?.message ?? 'Agent run failed', result.error.error?.code ?? 'ERR_AGENT_FAILED');
            return;
          }

          console.log('[Harbor] page_chat_message response:', chatId, { responseLength: result.text.length });
          sendResponse({
            type: 'page_chat_response',
            response: result.text,
            toolsUsed: [],
            ok: true,
          });
          return;
        }

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

  // The page-chat UI's own close button (page-chat.ts) has no other way to
  // reach the background: closing it tears down the DOM locally, but the
  // chat's agent session (if any) would otherwise outlive it until an
  // explicit agent.chat.close() or a tab/navigation event. Validated the
  // same way as page_chat_message: only the tab and origin that opened
  // this chat may close its session.
  registerHandler('page_chat_closed', (message, sender, sendResponse) => {
    const { chatId } = message as { chatId?: string };
    const chat = typeof chatId === 'string' ? getActiveChat(chatId) : undefined;
    const tabId = sender.tab?.id;
    const origin = originOf(sender.url);
    (async () => {
      if (chat && tabId !== undefined && origin && chat.tabId === tabId && chat.origin === origin) {
        await closeAgentChatSession(chatId!);
      }
      sendResponse({ ok: true });
    })();
    return true;
  });

  // A chat — its registry entry (agents/handlers/chat.ts) and its agent
  // session alike — ends with its document: a real navigation or reload,
  // or the tab closing outright. A new page has no way to reach the old
  // chatId's panel or session, and letting either answer whatever loads
  // next would be wrong: the session would hand its reply to a UI that's
  // gone, and the registry entry would let a forged `page_chat_message`
  // for that chatId keep working from whatever page loads next in the
  // same tab.
  //
  // Navigation is detected by a port, not `tabs.onUpdated`'s `url` field:
  // Firefox and Chrome both report that field for a same-document hash or
  // `pushState` change too (clicking a `href="#"` link, say), which isn't
  // a navigation at all and shouldn't end the chat — `tabs.onUpdated` was
  // tried first and dropped for exactly this false positive. page-chat.ts
  // opens a port named `harbor-page-chat:<chatId>` as soon as its BYOC
  // chat exists, and keeps it open for as long as that document does; the
  // port disconnects exactly when the document really goes away (a
  // reload, a real navigation, or the tab closing), the same signal a
  // `window.ai` session's own port already relies on
  // (page-api/background.ts). `tabs.onRemoved` stays as a backstop for
  // the tab-closing case, in case a port's disconnect event is ever slow
  // to arrive relative to the tab actually going away.
  const forgetChatAndSession = async (chatId: string): Promise<void> => {
    forgetChat(chatId);
    await closeAgentChatSession(chatId);
  };
  if (browserAPI.runtime.onConnect) {
    browserAPI.runtime.onConnect.addListener((port) => {
      const match = /^harbor-page-chat:(.+)$/.exec(port.name ?? '');
      if (!match) return;
      const chatId = match[1];
      // Only this chat's own tab and origin may drive its teardown — a
      // port named after a chatId it doesn't actually own (another site's
      // page, or a different tab) is otherwise ignored.
      const portTabId = port.sender?.tab?.id;
      const portOrigin = originOf(port.sender?.url);
      if (!chatStillOpen(chatId, portTabId ?? -1, portOrigin ?? '')) return;
      port.onDisconnect.addListener(() => {
        void forgetChatAndSession(chatId);
      });
    });
  }
  // Guarded, like page-api/background.ts's own storage.onChanged listener,
  // for a test harness (or a future browser target) that stubs `tabs`
  // with no `onRemoved` at all. An async listener (not a fire-and-forget
  // `void` call inside a sync one), the same shape page-api/background.ts's
  // own `tabs.onRemoved` listener already uses: the browser doesn't wait
  // for it either way, but it lets a test await the listener's own return
  // value instead of polling.
  if (browserAPI.tabs?.onRemoved) {
    browserAPI.tabs.onRemoved.addListener(async (tabId: number) => {
      forgetChatsForTab(tabId);
      await closeAgentChatSessionsForTab(tabId);
    });
  }

  // Switching `harbor_agent_backend` ends work already running on the
  // backend being left, not just changes what the next message uses — the
  // same kind of teardown page-api/background.ts does for window.ai text
  // sessions, but over this module's own sessions.
  if (browserAPI.storage?.onChanged) {
    browserAPI.storage.onChanged.addListener(async (changes: Record<string, unknown>, area: string) => {
      if (area !== 'local' || !(AGENT_BACKEND_STORAGE_KEY in changes)) return;
      await closeAllAgentChatSessions();
    });
  }
}
