/**
 * Harbor Page API - window.ai text sessions on the ACP agent backend
 *
 * When `harbor_agent_backend` names an ACP agent (agent-backend-selection.ts),
 * a `window.ai` text session (`ai.createTextSession` / `ai.languageModel.create`)
 * runs on that agent instead of Harbor's own `llm.chat`. See
 * docs/ACP_BACKEND_DESIGN.md section 2's `window.ai` bullets.
 *
 * One ACP session per text session, opened once at `createTextSession` and
 * kept until `destroy()`, a tab closing, or handlers/ai-handlers.ts's own
 * expiry/cleanup path removes the session — this module only owns the live
 * agent process and connection; ai-handlers.ts/background.ts still own the
 * `TextSessionState` entry, the origin and feature-flag checks
 * (`resolveTextSession`), and delivering events to the page.
 *
 * This reuses acp-connection.ts's shared pieces (opening the channel,
 * `initialize`/`session/new`, the scrubber, the provenance/prompt builder,
 * the permission relay, and the stop-reason mapping) rather than
 * duplicating acp-backend.ts's `agent.run` implementation. The one thing
 * this needs that `agent.run` doesn't: a connection kept open across many
 * `session/prompt` calls, with only one prompt in flight at a time, and
 * `systemPrompt` sent on the first of them only.
 *
 * Only `agent_message_chunk` text reaches the page: `window.ai` has no
 * vocabulary for the agent's thinking or tool calls, so `session/update`
 * notifications for those are dropped here (not relayed, and not re-checked
 * against the site's grant mid-turn — the one check this backend makes is
 * `resolveTextSession`'s existing `model:prompt` check, run again for every
 * `session.prompt`/`session.promptStreaming` request before it reaches this
 * module at all). The agent's own `session/request_permission` questions
 * still go through the same dialog as `agent.run` (askAgentQuestion, via
 * acp-connection.ts's `answerPermissionRequest`), since that's the agent
 * asking, not Harbor gating.
 */
import {
  client,
  AGENT_METHODS,
  CLIENT_METHODS,
  type ClientApp,
  type ClientContext,
} from '@agentclientprotocol/sdk';

import { acpClose, acpOpenStream } from './harbor-core';
import type { StreamToken } from './types';
import {
  ACP_TURN_TIMEOUT_MS,
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
  private cancelBridgeStream: (() => void) | null = null;
  /** Cancels `initialize`/`session/new` if `destroy()` lands while `open()` is still running them. */
  private readonly openAbort = new AbortController();

  constructor(
    private readonly agentId: string,
    private readonly origin: string,
    private readonly systemPrompt: string | undefined,
  ) {}

  /**
   * Opens the bridge channel, runs `initialize`/`session/new`, and keeps the
   * connection open for later `prompt()`/`promptStreaming()` calls. Throws
   * (with `.code` set, when known) on any failure — the caller
   * (acp-text-session.ts's `createAcpTextSession`) turns that into the
   * `ai.createTextSession` error response.
   */
  async open(): Promise<void> {
    const { stream: bridgeEvents, cancel: cancelBridgeStream } = acpOpenStream(this.agentId, this.origin);
    this.cancelBridgeStream = cancelBridgeStream;

    const opened = await openAcpChannel(bridgeEvents, () => this.closed, (ch) => { this.channel = ch; });
    if (opened.kind !== 'ready') {
      cancelBridgeStream();
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
      const initialized = await initializeAcpSession(ctx, opened.cwd, this.openAbort.signal);
      if (!initialized.ok) {
        readyResolve({ ok: false, error: initialized.error });
        return;
      }
      this.acpSessionId = initialized.sessionId;
      readyResolve({ ok: true });
      // Keeps the connection open for every later prompt, until destroy()
      // resolves this (or the connection ends on its own, e.g. the agent's
      // process exits — `runUntil` then rejects this promise on its own).
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
      throw toThrownError(result.error);
    }
  }

  /** Sends one `session/prompt`, returning the full response text. Queued: see `enqueue`. */
  async prompt(input: string): Promise<{ ok: true; text: string } | { ok: false; error: StreamToken }> {
    return this.enqueue(() => this.runOneTurn(input, () => { /* no incremental delivery for the non-streaming call */ }));
  }

  /** Sends one `session/prompt`, delivering each scrubbed `agent_message_chunk` to `onChunk` as it arrives. Queued: see `enqueue`. */
  async promptStreaming(
    input: string,
    onChunk: (text: string) => void,
  ): Promise<{ ok: true; text: string } | { ok: false; error: StreamToken }> {
    return this.enqueue(() => this.runOneTurn(input, onChunk));
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
    app.onNotification(CLIENT_METHODS.session_update, async (ctx) => {
      const update = ctx.params.update;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        this.currentTurn?.onMessageChunk(update.content.text);
      }
      // Thinking, tool calls and anything else: window.ai has no events for
      // them (docs/ACP_BACKEND_DESIGN.md section 2), so they're dropped here.
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
  ): Promise<{ ok: true; text: string } | { ok: false; error: StreamToken }> {
    if (this.closed || !this.ctx || !this.acpSessionId) {
      return { ok: false, error: agentFailedEvent('The agent session is no longer available') };
    }
    const ctx = this.ctx;
    const sessionId = this.acpSessionId;

    const turn: PendingTurn = {
      cancelReason: null,
      terminalSent: false,
      requestAbort: new AbortController(),
      runEnded: new AbortController(),
      onMessageChunk: (text) => {
        accumulatedText += text;
        onChunk(this.scrub(text));
      },
    };
    let accumulatedText = '';

    const triggerCancel = (reason: CancelReason) => {
      if (turn.cancelReason) return;
      turn.cancelReason = reason;
      ctx.notify(AGENT_METHODS.session_cancel, { sessionId }).catch(() => { /* best-effort */ });
      turn.requestAbort.abort();
    };

    this.currentTurn = turn;
    this.cancelCurrentTurn = () => triggerCancel('aborted');
    const timeoutHandle = setTimeout(() => triggerCancel('timeout'), ACP_TURN_TIMEOUT_MS);

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

import { registerAcpTextSession, unregisterAcpTextSession, acpTextSessionIdsForTab } from './acp-text-session-registry';
export { isAcpTextSession } from './acp-text-session-registry';

const sessions = new Map<string, AcpTextSession>();

/**
 * Opens an ACP-backed text session and registers it under `sessionId`
 * (ai-handlers.ts's own id for the session). Throws on failure — the
 * caller turns that into `ai.createTextSession`'s error response; nothing
 * is registered when this throws, so `isAcpTextSession(sessionId)` stays
 * `false`.
 */
export async function createAcpTextSession(
  sessionId: string,
  agentId: string,
  origin: string,
  tabId: number | undefined,
  systemPrompt: string | undefined,
): Promise<void> {
  const session = new AcpTextSession(agentId, origin, systemPrompt);
  await session.open();
  sessions.set(sessionId, session);
  registerAcpTextSession(sessionId, tabId);
}

export async function promptAcpTextSession(
  sessionId: string,
  input: string,
): Promise<{ ok: true; text: string } | { ok: false; error: StreamToken }> {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: agentFailedEvent('Session not found') };
  return session.prompt(input);
}

export async function promptStreamingAcpTextSession(
  sessionId: string,
  input: string,
  onChunk: (text: string) => void,
): Promise<{ ok: true; text: string } | { ok: false; error: StreamToken }> {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: agentFailedEvent('Session not found') };
  return session.promptStreaming(input, onChunk);
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
 * Destroys every ACP-backed text session that belongs to `tabId` (its tab
 * closed or navigated away), the same cleanup `destroyAcpTextSession` does
 * for an explicit `session.destroy`. `onForgotten` lets the caller forget
 * each session's `TextSessionState` entry too (ai-handlers.ts's own map),
 * without this module importing it directly.
 */
export async function cleanupAcpTextSessionsForTab(
  tabId: number,
  onForgotten: (sessionId: string) => void,
): Promise<void> {
  const sessionIds = acpTextSessionIdsForTab(tabId);
  await Promise.all(sessionIds.map(async (sessionId) => {
    const session = sessions.get(sessionId);
    sessions.delete(sessionId);
    unregisterAcpTextSession(sessionId);
    onForgotten(sessionId);
    await session?.destroy().catch(() => { /* best-effort */ });
  }));
}
