/**
 * Harbor Page API - window.ai text sessions on the ACP agent backend
 *
 * When `harbor_agent_backend` names an ACP agent (agent-backend-selection.ts),
 * a `window.ai` text session (`ai.createTextSession` / `ai.languageModel.create`)
 * runs on that agent instead of Harbor's own `llm.chat`. See
 * docs/ACP_BACKEND_DESIGN.md section 2's `window.ai` bullets.
 *
 * One ACP session per text session, opened once at `createTextSession` and
 * kept until `destroy()`, a tab closing, its port disconnecting (navigation
 * or reload), or handlers/ai-handlers.ts's own expiry/cleanup path removes
 * the session — this module only owns the live agent process and
 * connection; ai-handlers.ts/background.ts still own the `TextSessionState`
 * entry, the origin and feature-flag checks (`resolveTextSession`), and
 * delivering events to the page.
 *
 * This reuses acp-connection.ts's shared pieces (opening the channel,
 * `initialize`/`session/new`, the scrubber, the provenance/prompt builder,
 * the permission relay, and the stop-reason mapping) rather than
 * duplicating acp-backend.ts's `agent.run` implementation. The things this
 * needs that `agent.run` doesn't: a connection kept open across many
 * `session/prompt` calls, with only one prompt in flight at a time (others
 * queue); `systemPrompt` sent on the first of them only; and every failure
 * path — including one that lands before a session, or even a channel,
 * exists — settling with a coded error instead of hanging, and killing the
 * agent process rather than leaking it.
 *
 * Only `agent_message_chunk` text reaches the page: `window.ai` has no
 * vocabulary for the agent's thinking or tool calls, so `session/update`
 * notifications for those are dropped rather than relayed. `tool_call` and
 * `tool_call_update`, though, still re-check the site's `model:prompt`
 * grant mid-turn and cancel on a revoked one, exactly as `agent.run` does —
 * a long turn can outlive the grant it started with. The agent's own
 * `session/request_permission` questions go through the same dialog as
 * `agent.run` (askAgentQuestion, via acp-connection.ts's
 * `answerPermissionRequest`), since that's the agent asking, not Harbor
 * gating.
 */
import {
  client,
  AGENT_METHODS,
  CLIENT_METHODS,
  type ClientApp,
  type ClientContext,
} from '@agentclientprotocol/sdk';

import { acpClose, acpOpenStream } from './harbor-core';
import { hasPermission } from './handlers/permission-handlers';
import { PER_SITE_AGENT_LIMIT, tryAcquireAgentSlot, releaseAgentSlot } from './acp-agent-limits';
import type { StreamToken } from './types';
import {
  ACP_TURN_TIMEOUT_MS,
  agentBusyEvent,
  agentFailedEvent,
  answerPermissionRequest,
  bridgeToSdkStream,
  buildPathScrubber,
  buildPromptBlocks,
  cancelReasonEvent,
  combineAbortSignals,
  initializeAcpSession,
  openAcpChannel,
  provenanceMeta,
  stopReasonOutcome,
  type CancelReason,
} from './acp-connection';

/** State for whichever `session/prompt` call is currently running, read by the handlers `open()` registers once for the life of the connection. */
interface PendingTurn {
  cancelReason: CancelReason | null;
  terminalSent: boolean;
  requestAbort: AbortController;
  runEnded: AbortController;
  onMessageChunk: (text: string) => void;
  /** Sends `session/cancel` once for this turn and aborts its request; used by this turn's own timeout/page-abort, and by the mid-turn grant recheck below. */
  triggerCancel: (reason: CancelReason) => void;
}

function toThrownError(event: StreamToken): Error & { code?: string } {
  const message = event.type === 'error' ? event.error?.message ?? 'The agent failed to start' : 'The agent failed to start';
  const err = new Error(message) as Error & { code?: string };
  if (event.type === 'error' && event.error?.code) err.code = event.error.code;
  return err;
}

/**
 * One ACP-backed text session: a single long-lived agent process and ACP
 * session, prompted one turn at a time.
 */
export class AcpTextSession {
  private ctx: ClientContext | null = null;
  private acpSessionId: string | null = null;
  private scrub: (text: string) => string = (text) => text;
  private channel: string | null = null;
  private closed = false;
  private firstPromptSent = false;
  private queue: Promise<unknown> = Promise.resolve();
  private currentTurn: PendingTurn | null = null;
  private cancelCurrentTurn: (() => void) | null = null;
  private connectionClosed: Promise<void> = Promise.resolve();
  private requestClose: (() => void) | null = null;
  /** Cancels `initialize`/`session/new` if `destroy()`, or `open()`'s own caller-given signal, lands while they're still running. */
  private readonly openAbort = new AbortController();
  /** Whether this session currently holds one of `this.origin`'s per-site agent slots — acquired at the top of `open()`, released on `open()`'s own failure or in `destroy()`, never both. */
  private slotHeld = false;

  constructor(
    private readonly agentId: string,
    private readonly origin: string,
    private readonly tabId: number | undefined,
    private readonly systemPrompt: string | undefined,
  ) {}

  /**
   * Opens the bridge channel, runs `initialize`/`session/new`, and keeps the
   * connection open for later `prompt()`/`promptStreaming()` calls. Every
   * failure path — a channel that never opens, `initialize`/`session/new`
   * rejecting, an unsupported protocol version, or the agent exiting mid-
   * handshake — settles this (never hangs) and kills the agent process if a
   * channel was ever opened. Throws (with `.code` set, when known) on any
   * failure — the caller (this module's `createAcpTextSession`) turns that
   * into the `ai.createTextSession` error response. `signal`, when given,
   * aborts the open the same way `destroy()` would (the page's own
   * create-request timeout, or the tab/port going away while this is still
   * in flight).
   */
  async open(signal?: AbortSignal): Promise<void> {
    // Checked, and reserved, before `acp.open` is ever called — a session
    // past this site's own cap (counted together with its agent.run runs)
    // never reaches the bridge at all.
    if (!tryAcquireAgentSlot(this.origin)) {
      throw toThrownError(agentBusyEvent(`This site already has ${PER_SITE_AGENT_LIMIT} agents running`));
    }
    this.slotHeld = true;

    const onExternalAbort = () => this.openAbort.abort();
    if (signal) {
      if (signal.aborted) this.openAbort.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const isAborted = () => this.closed || this.openAbort.signal.aborted;

    try {
      const { stream: bridgeEvents, cancel: cancelBridgeStream } = acpOpenStream(this.agentId, this.origin);

      const opened = await openAcpChannel(bridgeEvents, isAborted, (ch) => { this.channel = ch; });
      if (opened.kind !== 'ready') {
        cancelBridgeStream();
        if (this.channel) await acpClose(this.channel).catch(() => { /* best-effort */ });
        this.releaseSlot();
        throw toThrownError(opened.kind === 'failed' ? opened.error : cancelReasonEvent('aborted'));
      }
      this.channel = opened.channel;
      this.scrub = buildPathScrubber(opened.cwd);

      const app = client({ name: 'harbor' });
      this.attachHandlers(app);

      const stream = bridgeToSdkStream(opened.channel, bridgeEvents);

      let readyResolve!: (result: { ok: true } | { ok: false; error: StreamToken }) => void;
      const ready = new Promise<{ ok: true } | { ok: false; error: StreamToken }>((resolve) => { readyResolve = resolve; });
      const closeRequested = new Promise<void>((resolve) => { this.requestClose = resolve; });

      const connectionDone = app.connectWith(stream, async (ctx) => {
        this.ctx = ctx;
        // Any failure here — initialize/session-new rejecting because the
        // agent errored or the connection died mid-handshake, not just an
        // unsupported protocol version — must still resolve `ready`, or
        // `open()` hangs forever (nothing else ever settles it).
        try {
          const initialized = await initializeAcpSession(ctx, opened.cwd, this.openAbort.signal);
          if (!initialized.ok) {
            readyResolve({ ok: false, error: initialized.error });
            return;
          }
          this.acpSessionId = initialized.sessionId;
        } catch (e) {
          // `this.openAbort` aborting is what made `initialize`/`session/new`
          // reject here (`stopWaitingOnCancel`) — that's this backend's own
          // cancellation, same as a page abort anywhere else, not a genuine
          // agent failure, so it's reported as ERR_ABORTED, not
          // ERR_AGENT_FAILED's generic "the agent failed to start".
          if (this.openAbort.signal.aborted) {
            readyResolve({ ok: false, error: cancelReasonEvent('aborted') });
          } else {
            readyResolve({ ok: false, error: agentFailedEvent(this.scrub(e instanceof Error ? e.message : 'The agent failed to start')) });
          }
          return;
        }
        readyResolve({ ok: true });
        // Keeps the connection open for every later prompt, until destroy()
        // resolves this (or the connection ends on its own, e.g. the agent's
        // process exits — `runUntil` then rejects this promise on its own,
        // which the `.catch` below turns into cleanup, not an unhandled
        // rejection).
        await closeRequested;
      });

      this.connectionClosed = connectionDone.then(
        () => { cancelBridgeStream(); },
        () => { cancelBridgeStream(); },
      );

      const result = await ready;
      if (!result.ok) {
        this.requestClose?.();
        await this.connectionClosed;
        if (this.channel) await acpClose(this.channel).catch(() => { /* best-effort */ });
        this.releaseSlot();
        throw toThrownError(result.error);
      }
    } finally {
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /** Frees this session's per-site agent slot, if it's still holding one. Idempotent. */
  private releaseSlot(): void {
    if (!this.slotHeld) return;
    this.slotHeld = false;
    releaseAgentSlot(this.origin);
  }

  /** Sends one `session/prompt`, returning the full response text. Queued: see `enqueue`. `signal` cancels this specific turn (a page-side abort or request timeout), the same as `destroy()` cancels whichever turn is current. */
  async prompt(input: string, signal?: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; error: StreamToken }> {
    return this.enqueue(() => this.runOneTurn(input, () => { /* no incremental delivery for the non-streaming call */ }, signal));
  }

  /** Sends one `session/prompt`, delivering each scrubbed `agent_message_chunk` to `onChunk` as it arrives. Queued: see `enqueue`. `signal` cancels this specific turn. */
  async promptStreaming(
    input: string,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<{ ok: true; text: string } | { ok: false; error: StreamToken }> {
    return this.enqueue(() => this.runOneTurn(input, onChunk, signal));
  }

  /**
   * Cancels any turn in progress (`session/cancel`, and the in-flight
   * `prompt()`/`promptStreaming()` call resolves with `ERR_ABORTED`), ends
   * the ACP connection, and kills the agent process. Idempotent.
   */
  async destroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.openAbort.abort();
    this.cancelCurrentTurn?.();
    this.requestClose?.();
    await this.connectionClosed.catch(() => { /* already reported to whichever turn was running */ });
    if (this.channel) await acpClose(this.channel).catch(() => { /* best-effort */ });
    this.releaseSlot();
  }

  /**
   * One turn at a time per session, in arrival order — matching the
   * built-in text session's own (racy, non-serializing) permissiveness
   * about concurrent `prompt()`/`promptStreaming()` calls from the page's
   * point of view (neither rejects a second call while one is running), but
   * an ACP session can only have one `session/prompt` in flight, so this
   * backend queues instead of sending both at once.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** `session/update` and `session/request_permission`, registered once for the connection's whole lifetime; both read `this.currentTurn`, swapped in at the start of each queued turn. */
  private attachHandlers(app: ClientApp): void {
    const toolNames = new Map<string, string>();

    app.onNotification(CLIENT_METHODS.session_update, async (ctx) => {
      const update = ctx.params.update;
      const turn = this.currentTurn;
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
          if (update.content.type === 'text') turn?.onMessageChunk(update.content.text);
          return;
        case 'tool_call':
        case 'tool_call_update': {
          // window.ai has no events for tool calls, so nothing is relayed
          // to the page here — but a turn can run for minutes while the
          // agent uses its own tools, and the site's grant can be revoked
          // during that time, same as `agent.run`'s own mid-turn recheck.
          if (!turn || turn.cancelReason) return;
          if (update.sessionUpdate === 'tool_call') {
            toolNames.set(update.toolCallId, update.title || update.kind || update.toolCallId);
          }
          if (!await hasPermission(this.origin, 'model:prompt', this.tabId)) {
            turn.triggerCancel('permission-denied');
          }
          return;
        }
        default:
          // Thinking, plans, usage and the rest are dropped at first (see
          // docs/ACP_BACKEND_DESIGN.md section 2).
          return;
      }
    });

    app.onRequest(CLIENT_METHODS.session_request_permission, async (ctx) => {
      const turn = this.currentTurn;
      // The turn can already be over by the time this arrives (the agent's
      // own request can race session/prompt's response) — never open a
      // dialog for a question nobody's waiting on.
      if (!turn || turn.terminalSent) return { outcome: { outcome: 'cancelled' } };

      const { toolCall, options } = ctx.params;
      return answerPermissionRequest(
        () => turn.cancelReason !== null,
        {
          origin: this.origin,
          agentName: this.agentId,
          toolCall: {
            title: toolCall.title ?? '',
            kind: toolCall.kind ?? undefined,
            rawInput: toolCall.rawInput,
            locations: toolCall.locations?.map((l) => ({ path: l.path, line: l.line ?? undefined })),
          },
          options,
        },
        combineAbortSignals([turn.requestAbort.signal, ctx.signal, turn.runEnded.signal]),
      );
    });
  }

  private async runOneTurn(
    input: string,
    onChunk: (text: string) => void,
    pageSignal?: AbortSignal,
  ): Promise<{ ok: true; text: string } | { ok: false; error: StreamToken }> {
    if (this.closed || !this.ctx || !this.acpSessionId) {
      return { ok: false, error: agentFailedEvent('The agent session is no longer available') };
    }
    const ctx = this.ctx;
    const sessionId = this.acpSessionId;

    let accumulatedText = '';
    const requestAbort = new AbortController();
    const turn: PendingTurn = {
      cancelReason: null,
      terminalSent: false,
      requestAbort,
      runEnded: new AbortController(),
      onMessageChunk: (text) => {
        accumulatedText += text;
        onChunk(this.scrub(text));
      },
      triggerCancel: (reason) => {
        if (turn.cancelReason) return;
        turn.cancelReason = reason;
        ctx.notify(AGENT_METHODS.session_cancel, { sessionId }).catch(() => { /* best-effort */ });
        requestAbort.abort();
      },
    };

    this.currentTurn = turn;
    this.cancelCurrentTurn = () => turn.triggerCancel('aborted');
    const timeoutHandle = setTimeout(() => turn.triggerCancel('timeout'), ACP_TURN_TIMEOUT_MS);
    // The page breaking its own for-await loop on promptStreaming (the
    // content script's {type:'abort', id} on the port), or the page's own
    // client-side request timeout on a non-streaming prompt() — either way,
    // treated exactly like this turn's own timeout: session/cancel, and the
    // page sees ERR_ABORTED.
    const onPageAbort = () => turn.triggerCancel('aborted');
    pageSignal?.addEventListener('abort', onPageAbort);
    if (pageSignal?.aborted) turn.triggerCancel('aborted');

    try {
      const prompt = buildPromptBlocks(this.origin, input, this.firstPromptSent ? undefined : this.systemPrompt);
      // Set before the request settles, not after: the systemPrompt was
      // included in *this* prompt's blocks regardless of how the turn ends,
      // so a failed first turn still doesn't get it resent on the next one.
      this.firstPromptSent = true;

      const result = await ctx.request(
        AGENT_METHODS.session_prompt,
        { sessionId, prompt, _meta: provenanceMeta(this.origin) },
        { cancellationSignal: turn.requestAbort.signal, stopWaitingOnCancel: true },
      );
      turn.terminalSent = true;
      turn.runEnded.abort();

      const outcome = stopReasonOutcome(result.stopReason, turn.cancelReason);
      if (!outcome.ok) return { ok: false, error: outcome.error };
      return { ok: true, text: this.scrub(accumulatedText) };
    } catch (e) {
      turn.terminalSent = true;
      turn.runEnded.abort();
      if (turn.cancelReason) return { ok: false, error: cancelReasonEvent(turn.cancelReason) };
      return { ok: false, error: agentFailedEvent(this.scrub(e instanceof Error ? e.message : 'Agent run failed')) };
    } finally {
      clearTimeout(timeoutHandle);
      pageSignal?.removeEventListener('abort', onPageAbort);
      if (this.currentTurn === turn) this.currentTurn = null;
      if (this.cancelCurrentTurn) this.cancelCurrentTurn = null;
    }
  }
}

// =============================================================================
// Registry — one AcpTextSession instance per window.ai sessionId backed by
// this backend. Membership itself (`isAcpTextSession`) lives in the
// lightweight acp-text-session-registry.ts, which ai-handlers.ts/
// background.ts can check without loading this heavier module (the ACP SDK,
// and agent-question.ts's module-level listener registration) for a session
// on the built-in backend.
// =============================================================================

import {
  registerAcpTextSession, unregisterAcpTextSession, acpTextSessionIdsForTab,
  registerPendingOpen, setPendingOpenAbort, clearPendingOpen, isPendingOpenCancelled, cancelPendingOpensForTab,
} from './acp-text-session-registry';
export { isAcpTextSession } from './acp-text-session-registry';

const sessions = new Map<string, AcpTextSession>();

/**
 * Opens an ACP-backed text session and registers it under `sessionId`
 * (ai-handlers.ts's own id for the session). Throws on failure — the
 * caller turns that into `ai.createTextSession`'s error response; nothing
 * is registered when this throws, so `isAcpTextSession(sessionId)` stays
 * `false`.
 *
 * Registers the open as "pending" for `tabId` before awaiting it, so a tab
 * closing (or its port disconnecting) while the agent is still starting —
 * `cleanupAcpTextSessionsForTab`, below — can mark it cancelled; once
 * `open()` settles, this checks that flag and tears the session down
 * immediately (killing the agent process) instead of registering it. The
 * page's own `signal`, when given (its create-request timeout), cancels the
 * open the same way.
 */
export async function createAcpTextSession(
  sessionId: string,
  agentId: string,
  origin: string,
  tabId: number | undefined,
  systemPrompt: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  registerPendingOpen(sessionId, tabId);
  // `cancelPendingOpensForTab` (the tab closing, or its port disconnecting
  // without a `session.destroy` — handleTabRemoved's own cleanup) needs a
  // way to interrupt this open even if the agent never answers on its own
  // (hanging at `initialize`, say): this controller is that way, combined
  // with the caller's own `signal` so either can end the open.
  const tabAbort = new AbortController();
  setPendingOpenAbort(sessionId, () => tabAbort.abort());
  const openSignal = signal ? combineAbortSignals([signal, tabAbort.signal]) : tabAbort.signal;

  const session = new AcpTextSession(agentId, origin, tabId, systemPrompt);
  try {
    await session.open(openSignal);
  } catch (e) {
    clearPendingOpen(sessionId);
    throw e;
  }
  if (isPendingOpenCancelled(sessionId)) {
    clearPendingOpen(sessionId);
    await session.destroy().catch(() => { /* best-effort */ });
    const err = new Error('The page is no longer there') as Error & { code?: string };
    err.code = 'ERR_ABORTED';
    throw err;
  }
  clearPendingOpen(sessionId);
  sessions.set(sessionId, session);
  registerAcpTextSession(sessionId, tabId);
}

export async function promptAcpTextSession(
  sessionId: string,
  input: string,
  signal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; error: StreamToken }> {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: agentFailedEvent('Session not found') };
  return session.prompt(input, signal);
}

export async function promptStreamingAcpTextSession(
  sessionId: string,
  input: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; error: StreamToken }> {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: agentFailedEvent('Session not found') };
  return session.promptStreaming(input, onChunk, signal);
}

/** Cancels any running turn, closes the agent process, and forgets the session. */
export async function destroyAcpTextSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  unregisterAcpTextSession(sessionId);
  await session.destroy();
}

/**
 * Destroys every ACP-backed text session that belongs to `tabId` — its tab
 * closing, or its port disconnecting (a navigation or reload starts a new
 * port on the same tab id, so this runs from both signals in
 * background.ts) — the same cleanup `destroyAcpTextSession` does for an
 * explicit `session.destroy`. Also cancels any session still opening for
 * this tab (`createAcpTextSession` finishes the job once `open()` settles).
 * `onForgotten` lets the caller forget each session's `TextSessionState`
 * entry too (ai-handlers.ts's own map), without this module importing it
 * directly.
 */
export async function cleanupAcpTextSessionsForTab(
  tabId: number,
  onForgotten: (sessionId: string) => void,
): Promise<void> {
  cancelPendingOpensForTab(tabId);
  const sessionIds = acpTextSessionIdsForTab(tabId);
  await Promise.all(sessionIds.map(async (sessionId) => {
    const session = sessions.get(sessionId);
    sessions.delete(sessionId);
    unregisterAcpTextSession(sessionId);
    onForgotten(sessionId);
    await session?.destroy().catch(() => { /* best-effort */ });
  }));
}
