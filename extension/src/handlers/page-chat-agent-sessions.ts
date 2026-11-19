/**
 * The agent session behind an open page chat (`agent.chat.open`'s
 * bring-your-chatbot chat), when the person has an ACP agent selected
 * (docs/ACP_BACKEND_DESIGN.md section 2).
 *
 * Each open chat (`chatId`) gets at most one `AcpTextSession`
 * (page-api/acp-text-session.ts), opened lazily on the chat's first
 * message and kept for every later message in that chat — exactly like a
 * `window.ai` text session's own session reuse, systemPrompt-once
 * labelling, mid-turn grant recheck, permission relay and per-site agent
 * cap. This reuses that class rather than a second implementation; the
 * only thing specific to page chat is how the session is keyed (`chatId`,
 * not a `window.ai` sessionId) and how it's torn down below.
 *
 * `page-api/acp-text-session-registry.ts` has no entry for these: a page
 * chat's agent session isn't a `window.ai` session, so
 * `destroyAllAcpTextSessions`/`cleanupAcpTextSessionsForTab` (background.ts)
 * never see it. This module keeps its own, much smaller, registry and its
 * own teardown for the same three events:
 *   - an explicit close (`agent.chat.close`, or the page-chat UI's own
 *     close button) — wired in agents/handlers/chat.ts and
 *     handlers/page-chat-handlers.ts;
 *   - the chat's tab closing or navigating away — wired below, in
 *     `registerPageChatHandlers()`;
 *   - a `harbor_agent_backend` switch — the same kind of "destroy every
 *     live session" teardown page-api/background.ts already does for
 *     window.ai text sessions, but over this module's own map.
 *
 * `AcpTextSession` is loaded with a dynamic `import()`, not a top-level
 * one, for the same reason handlers/ai-handlers.ts loads it lazily:
 * page-api/acp-text-session.ts pulls in page-api/acp-connection.ts ->
 * page-api/agent-question.ts, which registers a
 * `browserAPI.runtime.onMessage` listener as soon as it's imported. This
 * module is reached from handlers/page-chat-handlers.ts, part of the
 * handlers/ barrel many unrelated tests load through only a bare-bones
 * `chrome` stub — a static import here would saddle every one of them with
 * that side effect even when no message ever reaches an ACP agent.
 */
import type { AcpTextSession } from '../page-api/acp-text-session';

async function loadAcpTextSession() {
  return import('../page-api/acp-text-session');
}

interface Entry {
  tabId: number | undefined;
  /**
   * Aborts this entry's own `open()` immediately if it's still in flight —
   * `closeAgentChatSession` calls this *before* ever awaiting `session`,
   * so an agent that never answers `initialize` doesn't keep a close (or a
   * pending message's own wait on this same promise) hanging forever.
   * Inert once `open()` has already settled: `AbortController.abort()` on
   * a controller nothing is still listening to does nothing.
   */
  abort: AbortController;
  /**
   * Resolves to the opened session, or rejects if the open failed (or was
   * just aborted). The map holds this promise itself, not a session field
   * filled in later: the check-then-set below has to claim `chatId` with
   * nothing awaited in between, or two messages sent together (both
   * finding no entry) would each open their own session, leaking one and
   * its per-site cap slot. Creating this promise, and `sessions.set`ting
   * it, happen back to back with no `await` between them, so whichever
   * call runs first (concurrent calls still run one at a time up to their
   * first `await` — there is none here) wins the claim; a second call for
   * the same `chatId` finds this entry already in the map and shares it.
   */
  session: Promise<AcpTextSession>;
}

const sessions = new Map<string, Entry>();

/**
 * Returns `chatId`'s live agent session, opening one — in `origin`'s own
 * ACP workspace — on the first call for this chat. `systemPrompt`, when
 * given, is only ever sent on that session's first prompt (the session's
 * own doing, not this function's). A second call for a chat whose open is
 * still in flight gets the same promise, not a second session.
 *
 * Throws (with `.code` set, when known) if the open fails, including
 * because `closeAgentChatSession` cancelled it — nothing is left
 * registered in that case, so the chat's next message opens a fresh
 * session rather than reusing a dead one.
 */
export function ensureAgentChatSession(
  chatId: string,
  agentId: string,
  origin: string,
  tabId: number | undefined,
  systemPrompt: string | undefined,
): Promise<AcpTextSession> {
  const existing = sessions.get(chatId);
  if (existing) return existing.session;

  const abort = new AbortController();
  const session = (async () => {
    const { AcpTextSession } = await loadAcpTextSession();
    const instance = new AcpTextSession(agentId, origin, tabId, systemPrompt, 'page-chat');
    await instance.open(abort.signal);
    return instance;
  })();

  sessions.set(chatId, { tabId, abort, session });

  session.catch(() => {
    // A later call for this chatId may have already replaced or removed
    // this entry (an explicit close racing the open) — only remove it if
    // it's still this attempt's own entry.
    if (sessions.get(chatId)?.session === session) sessions.delete(chatId);
  });

  return session;
}

/**
 * Cancels any turn in progress, kills the agent process, and forgets
 * `chatId`'s session. Safe, and prompt, to call while the session is
 * still opening: `entry.abort.abort()` runs before anything here ever
 * awaits `entry.session`, so a still-opening `AcpTextSession` releases
 * this chat's per-site slot and closes the channel it had opened (its
 * own `open(signal)` already does this on abort, the same way it does for
 * an explicit `destroy()`) instead of this call — and a message that's
 * itself awaiting the very same `ensureAgentChatSession` promise — waiting
 * on an agent that may never answer `initialize` at all. A no-op when the
 * chat has no live agent session (the built-in backend, a chat that never
 * sent a message, or one whose open already failed and removed itself
 * above).
 */
export async function closeAgentChatSession(chatId: string): Promise<void> {
  const entry = sessions.get(chatId);
  if (!entry) return;
  sessions.delete(chatId);
  entry.abort.abort();
  try {
    const instance = await entry.session;
    await instance.destroy().catch(() => { /* best-effort */ });
  } catch {
    // The open itself failed, or was just aborted above — either way its
    // own cleanup (releasing the slot, closing the channel) already ran
    // inside `open()` itself; nothing further to destroy.
  }
}

/** Every chat's session whose tab is `tabId` — the tab closing, or navigating away (a fresh page can't reach the old chatId's session). */
export async function closeAgentChatSessionsForTab(tabId: number): Promise<void> {
  const chatIds = [...sessions.entries()].filter(([, e]) => e.tabId === tabId).map(([id]) => id);
  await Promise.all(chatIds.map((id) => closeAgentChatSession(id)));
}

/** Every live page-chat agent session, on every tab — for a `harbor_agent_backend` switch, which ends work on the backend being left, not just changes what the next message uses. */
export async function closeAllAgentChatSessions(): Promise<void> {
  const chatIds = [...sessions.keys()];
  await Promise.all(chatIds.map((id) => closeAgentChatSession(id)));
}

/** Test-only: forgets every session without destroying it, so a test that already asserted on `destroy()` isn't double-counted by a later `afterEach`. */
export function __resetAgentChatSessionsForTests(): void {
  sessions.clear();
}
