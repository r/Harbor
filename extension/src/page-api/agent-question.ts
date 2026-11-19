/**
 * Harbor Page API - Relaying an ACP agent's own permission question
 *
 * When the user's ACP agent sends `session/request_permission`
 * (acp-backend.ts), Harbor doesn't decide the answer itself — it shows the
 * agent's own question to the person, in a dedicated popup window
 * (`agent-question.html` / `src/agent-question.ts`), and passes their
 * choice back unchanged. See docs/ACP_BACKEND_DESIGN.md section 3
 * ("Relaying permission requests").
 *
 * This is deliberately a separate flow from the site-grant prompt
 * (policy/permissions.ts's `showPermissionPrompt` / permission-prompt.ts):
 * that prompt is Harbor asking the person whether a *site* may use their
 * agent at all; this one is the agent itself asking a question while it
 * works, which Harbor only relays. They share no window, state or message
 * type, so the sender checks below can be exact: nothing is accepted from
 * the site-grant prompt's page, or any other extension page.
 *
 * One question = one popup window = one opaque random id, so several runs
 * can ask the person something at the same time. The window fetches its
 * question from here (`agent_question_get`) rather than the id carrying the
 * payload in the URL — the agent's `rawInput` can be arbitrarily large, and
 * URLs end up in window titles and history.
 */
import { browserAPI } from '../browser-compat';

/**
 * A liveness timeout, well below the 10-minute overall run timeout
 * (`ACP_RUN_TIMEOUT_MS` in acp-backend.ts): if the person never answers,
 * the run's own timeout would eventually cancel everything anyway, but
 * this ends the single stuck question (and closes its window) much
 * sooner, with the same reject-first answer as closing the window.
 */
export const AGENT_QUESTION_TIMEOUT_MS = 5 * 60 * 1000;

export interface AgentQuestionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface AgentQuestionToolCall {
  title: string;
  kind?: string;
  rawInput?: unknown;
  locations?: Array<{ path: string; line?: number }>;
}

export interface AgentQuestionRequest {
  origin: string;
  agentName: string;
  toolCall: AgentQuestionToolCall;
  options: AgentQuestionOption[];
}

export type AgentQuestionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

interface PendingQuestion {
  request: AgentQuestionRequest;
  /** Precomputed once, from the agent's own options: see `rejectOutcomeFor`. */
  rejectOutcome: AgentQuestionOutcome;
  resolve: (outcome: AgentQuestionOutcome) => void;
  windowId: number | null;
  timeoutHandle: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  onAbort: () => void;
  settled: boolean;
}

const pending = new Map<string, PendingQuestion>();

/**
 * The agent's own reject option: `reject_once` first, then `reject_always`
 * — never `cancelled` when the agent offered either, so the agent still
 * gets a real answer from its own menu, not just "nobody answered". Only
 * when the agent offered no reject option at all (every option is some
 * flavour of allow) does Harbor fall back to `cancelled`, since approving
 * anything on the person's behalf is never the default.
 */
function rejectOutcomeFor(options: readonly AgentQuestionOption[]): AgentQuestionOutcome {
  const once = options.find((o) => o.kind === 'reject_once');
  if (once) return { outcome: 'selected', optionId: once.optionId };
  const always = options.find((o) => o.kind === 'reject_always');
  if (always) return { outcome: 'selected', optionId: always.optionId };
  return { outcome: 'cancelled' };
}

/** Settles a pending question exactly once, and closes its window. */
function finish(id: string, outcome: AgentQuestionOutcome): void {
  const q = pending.get(id);
  if (!q || q.settled) return;
  q.settled = true;
  pending.delete(id);
  clearTimeout(q.timeoutHandle);
  q.signal.removeEventListener('abort', q.onAbort);
  q.resolve(outcome);
  if (q.windowId !== null) {
    browserAPI.windows.remove(q.windowId).catch(() => { /* already closed */ });
  }
}

function questionUrl(id: string): string {
  return browserAPI.runtime.getURL(`agent-question.html?id=${id}`);
}

/**
 * Shows the agent's own question to the person in a new popup window, and
 * resolves with their choice, passed back unchanged as `optionId`.
 *
 * `signal` is the run's own cancellation (the page's abort, a tab closing,
 * a revoked grant, or the run's overall timeout — whichever triggered
 * `acp-backend.ts`'s `triggerCancel`). If it aborts while this question is
 * still open, the question is answered with the agent's reject option (via
 * `rejectOutcomeFor`) — same as a liveness timeout or the person closing
 * the window — and the window closes. This is the one seam the backend's
 * tests mock to drive "the person answered", "they closed the window", "it
 * timed out" and "the run got cancelled while it was open" without a real
 * window.
 */
export function askAgentQuestion(request: AgentQuestionRequest, signal: AbortSignal): Promise<AgentQuestionOutcome> {
  const rejectOutcome = rejectOutcomeFor(request.options);

  if (signal.aborted) {
    return Promise.resolve({ outcome: 'cancelled' });
  }

  const id = crypto.randomUUID();

  return new Promise<AgentQuestionOutcome>((resolve) => {
    const onAbort = () => finish(id, { outcome: 'cancelled' });
    const timeoutHandle = setTimeout(() => finish(id, rejectOutcome), AGENT_QUESTION_TIMEOUT_MS);

    pending.set(id, {
      request, rejectOutcome, resolve, windowId: null, timeoutHandle, signal, onAbort, settled: false,
    });
    signal.addEventListener('abort', onAbort);

    Promise.resolve(browserAPI.windows.create({
      url: questionUrl(id),
      type: 'popup',
      width: 480,
      height: 600,
      focused: true,
    }))
      .then((win) => {
        const q = pending.get(id);
        if (!q) return; // already settled (closed/timed out/cancelled before the window finished opening)
        const windowId = (win as { id?: number } | undefined)?.id;
        if (typeof windowId === 'number') {
          q.windowId = windowId;
        } else {
          finish(id, rejectOutcome);
        }
      })
      .catch(() => finish(id, rejectOutcome));
  });
}

// =============================================================================
// This page's messages, validated on receipt
// =============================================================================

/**
 * Accepts a message only from the one page this flow trusts: the extension
 * running `agent-question.html` itself. A content script's `sender.url` is
 * the site's own URL, and nothing with a non-extension URL ever matches —
 * `sender.id` alone wouldn't tell them apart, since a content script's
 * sender also carries this extension's id.
 */
function isAgentQuestionPage(sender: { id?: string; url?: string }): boolean {
  return sender.id === browserAPI.runtime.id
    && typeof sender.url === 'string'
    && sender.url.startsWith(browserAPI.runtime.getURL('agent-question.html'));
}

function handleAgentQuestionGet(id: unknown, sendResponse: (response: unknown) => void): void {
  const q = typeof id === 'string' ? pending.get(id) : undefined;
  sendResponse(q ? { ok: true, request: q.request } : { ok: false });
}

/**
 * Answers only when the id is still pending and the optionId is one of
 * the options Harbor showed for it — never an id that's already settled,
 * and never an optionId the agent didn't actually offer. Anything else is
 * ignored: no response, no effect on the pending question.
 */
function handleAgentQuestionAnswer(id: unknown, optionId: unknown, sendResponse: (response: unknown) => void): void {
  const q = typeof id === 'string' ? pending.get(id) : undefined;
  if (!q) return;
  if (typeof optionId !== 'string' || !q.request.options.some((o) => o.optionId === optionId)) return;
  finish(id as string, { outcome: 'selected', optionId });
  sendResponse({ ok: true });
}

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const msg = message as { type?: string; id?: unknown; optionId?: unknown } | undefined;
  if (msg?.type !== 'agent_question_get' && msg?.type !== 'agent_question_answer') {
    return undefined; // not ours
  }
  if (!isAgentQuestionPage(sender)) {
    return undefined; // ignored: not the agent-question page
  }

  if (msg.type === 'agent_question_get') {
    handleAgentQuestionGet(msg.id, sendResponse);
  } else {
    handleAgentQuestionAnswer(msg.id, msg.optionId, sendResponse);
  }
  return true;
});

// If the person closes the window without clicking anything, that's the
// same as picking the agent's own reject option (or `cancelled`, if it
// offered none) — never silence, which would leave the agent's request
// hanging, and never approval, which nobody chose.
browserAPI.windows?.onRemoved?.addListener((windowId) => {
  for (const [id, q] of pending) {
    if (q.windowId === windowId) {
      finish(id, q.rejectOutcome);
      return;
    }
  }
});
