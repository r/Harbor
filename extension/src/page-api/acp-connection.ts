/**
 * Harbor Page API - Shared ACP connection pieces
 *
 * Everything acp-backend.ts (agent.run) and acp-text-session.ts (window.ai
 * text sessions on the ACP backend) both need to talk to the user's own
 * agent over the Agent Client Protocol: opening the bridge channel, wrapping
 * it as the SDK's `Stream`, `initialize` and the protocol-version check,
 * `session/new`, the path scrubber, the provenance/prompt builder, the
 * permission relay, and mapping a prompt's stop reason to a coded error.
 * See docs/ACP_BACKEND_DESIGN.md.
 *
 * Nothing here opens a connection and keeps it running — that's each
 * backend's own job, since agent.run uses one session for one prompt and
 * closes it right after, while a text session keeps one session open across
 * many prompts. This module only has the parts that are identical either
 * way.
 */
import {
  AGENT_METHODS,
  type AnyMessage,
  type ClientContext,
  type ContentBlock,
  type Stream as AcpStream,
} from '@agentclientprotocol/sdk';

import { acpSend, type AcpBridgeEvent } from './harbor-core';
import { askAgentQuestion, type AgentQuestionOutcome, type AgentQuestionOption, type AgentQuestionToolCall } from './agent-question';
import { ErrorCodes, type StreamToken } from './types';

/**
 * An agent turn can take minutes, so neither backend uses `harborRequest`'s
 * 30-second default. This is the overall cap on one turn — one `agent.run`,
 * or one `prompt()`/`promptStreaming()` call on a text session — after
 * which it's cancelled and ends with `ERR_TIMEOUT`.
 */
export const ACP_TURN_TIMEOUT_MS = 10 * 60 * 1000;

/** Why a backend sent `session/cancel` — decides the error a `cancelled` stopReason (or a request the backend gave up waiting on) maps to. */
export type CancelReason = 'aborted' | 'permission-denied' | 'timeout';

export function cancelReasonEvent(reason: CancelReason): StreamToken {
  switch (reason) {
    case 'aborted':
      return { type: 'error', error: { code: ErrorCodes.ABORTED, message: 'Run aborted' } };
    case 'permission-denied':
      return { type: 'error', error: { code: ErrorCodes.PERMISSION_DENIED, message: 'Permission model:prompt required' } };
    case 'timeout':
      return { type: 'error', error: { code: ErrorCodes.TIMEOUT, message: 'Agent run timed out' } };
  }
}

export function agentFailedEvent(message: string): StreamToken {
  return { type: 'error', error: { code: ErrorCodes.AGENT_FAILED, message } };
}

/**
 * Classifies a `session/prompt` response's `stopReason` into either a normal
 * end (the caller decides how to deliver its own accumulated text) or a
 * terminal error event, exactly as acp-backend.ts's `emitStopReason` did
 * before this was extracted. `cancelReason` is `null` unless this backend
 * itself triggered the cancellation (the page's abort, a revoked grant, a
 * timeout) — a `cancelled` stopReason with no `cancelReason` here is the
 * agent's own doing (Codex reports it when a single tool call is rejected),
 * so that's treated as the turn ending normally.
 */
export function stopReasonOutcome(
  stopReason: string,
  cancelReason: CancelReason | null,
): { ok: true } | { ok: false; error: StreamToken } {
  switch (stopReason) {
    case 'end_turn':
      return { ok: true };
    case 'refusal':
      return { ok: false, error: { type: 'error', error: { code: ErrorCodes.AGENT_REFUSED, message: 'The agent refused the request' } } };
    case 'max_tokens':
    case 'max_turn_requests':
      return { ok: false, error: { type: 'error', error: { code: ErrorCodes.AGENT_LIMIT, message: `The agent stopped: ${stopReason}` } } };
    case 'cancelled':
      if (cancelReason) return { ok: false, error: cancelReasonEvent(cancelReason) };
      return { ok: true };
    default:
      return { ok: false, error: agentFailedEvent(`The agent stopped with an unknown reason: ${String(stopReason)}`) };
  }
}

/**
 * One signal that aborts as soon as any of `signals` does — used to give
 * `askAgentQuestion` a signal that reflects every way a turn can end while
 * its dialog is open: the backend's own cancellation, the SDK's per-request
 * signal for this `session/request_permission` (aborts on the agent's own
 * `$/cancel_request` or the connection closing), and the turn's own terminal
 * event.
 *
 * Prefers the platform's `AbortSignal.any` (Firefox 124+, Chrome 116+; missing in Safari before 17.4);
 * falls back to a manual combinator for any target without it. A signal
 * that's already aborted when this runs still needs to produce an
 * already-aborted result — `addEventListener('abort', ...)` alone would
 * never fire for one, since its abort already happened.
 */
export function combineAbortSignals(signals: readonly AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([...signals]);

  const controller = new AbortController();
  if (signals.some((s) => s.aborted)) {
    controller.abort();
    return controller.signal;
  }
  const onAbort = () => controller.abort();
  for (const s of signals) s.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

/**
 * Answers one `session/request_permission` by relaying the agent's own
 * question to the person (`askAgentQuestion`, in a popup window) and
 * passing their choice back unchanged — Harbor adds no options and no
 * rules about which calls need approval (docs/ACP_BACKEND_DESIGN.md
 * section 3).
 *
 * `isCancelled` is read right before asking, not only once up front: once
 * the turn is already cancelled, every request gets `cancelled` immediately
 * — never a dialog — because a request that's still in flight when Harbor
 * gives up must not approve anything on the page's behalf. While the
 * dialog is open, `askAgentQuestion` is itself given `signal`, so a turn
 * that gets cancelled *after* the dialog opened still ends with
 * `cancelled`, and closes the window.
 *
 * `isCancelled` is a function so this is testable without a live round trip
 * through a real connection or a real window (mocked at this seam in
 * acp-backend.test.ts).
 */
export async function answerPermissionRequest(
  isCancelled: () => boolean,
  request: { origin: string; agentName: string; toolCall: AgentQuestionToolCall; options: ReadonlyArray<AgentQuestionOption> },
  signal: AbortSignal,
): Promise<{ outcome: AgentQuestionOutcome }> {
  if (isCancelled()) return { outcome: { outcome: 'cancelled' } };
  const outcome = await askAgentQuestion(
    { origin: request.origin, agentName: request.agentName, toolCall: request.toolCall, options: [...request.options] },
    signal,
  );
  return { outcome };
}

/**
 * Builds a function that scrubs the session's working directory, and the
 * home directory it's under, out of any string: the canonical `cwd` from
 * the `open` event becomes ".", and the part of it before
 * `/.harbor/acp/workspaces/` (the user's home directory) becomes "~".
 * Nothing about where Harbor keeps a site's ACP workspace, or the user's
 * home path and username, should reach a page — an agent's own output
 * (goose, in testing) can otherwise echo the absolute path back in a
 * tool's final answer.
 *
 * macOS canonicalizes `/var/...` to `/private/var/...` (`cwd.canonicalize()`
 * in bridge-rs/src/acp/mod.rs), so when `cwd` starts with `/private/`,
 * both forms are scrubbed: an agent that reports a path itself may use
 * either. The longer (canonical) form is always replaced before the
 * shorter alias, so a canonical occurrence's tail doesn't get partially
 * matched by the alias first.
 */
export function buildPathScrubber(cwd: string): (text: string) => string {
  // The bridge builds the path with the platform's separator.
  const workspaceMarkers = ['/.harbor/acp/workspaces/', '\\.harbor\\acp\\workspaces\\'];

  const cwdVariants = [cwd];
  if (cwd.startsWith('/private/')) cwdVariants.push(cwd.slice('/private'.length));

  const rules: Array<[from: string, to: string]> = cwdVariants.map((v) => [v, '.']);
  for (const v of cwdVariants) {
    for (const marker of workspaceMarkers) {
      const idx = v.indexOf(marker);
      if (idx > 0) rules.push([v.slice(0, idx), '~']);
    }
  }
  rules.sort((a, b) => b[0].length - a[0].length);

  // Replace a path only where it ends at a path boundary: end of text, a
  // separator, a character that can't continue a path segment, or a period
  // that ends a sentence. Otherwise
  // `/Users/sam` would also rewrite `/Users/samuel`. Paths are escaped, so
  // regex metacharacters in them are literal.
  const PATH_END = String.raw`(?=$|[/\\\s"'<>\x60),;:\]\)}]|\.(?:$|\s))`;
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const compiled = rules
    .filter(([from]) => from)
    .map(([from, to]) => [new RegExp(escape(from) + PATH_END, 'g'), to] as const);

  return (text: string): string => {
    let out = text;
    for (const [pattern, to] of compiled) out = out.replace(pattern, to);
    return out;
  };
}

/** Walks a JSON-ish value, scrubbing every string it contains. */
export function scrubDeep<T>(value: T, scrub: (text: string) => string): T {
  if (typeof value === 'string') return scrub(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, scrub)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Two keys can scrub to the same string; keep both rather than
      // silently dropping one.
      let key = scrub(k);
      for (let n = 2; key in out; n++) key = `${scrub(k)} (${n})`;
      out[key] = scrubDeep(v, scrub);
    }
    return out as T;
  }
  return value;
}

/**
 * Builds the `session/prompt` content blocks: the site's `systemPrompt`,
 * when given, labelled as coming from the site (never as the agent's own
 * instructions), followed by the task/input text. For a text session,
 * `systemPrompt` is only passed for the first prompt the caller sends.
 */
export function buildPromptBlocks(origin: string, text: string, systemPrompt: string | undefined): ContentBlock[] {
  const prompt: ContentBlock[] = [];
  if (systemPrompt) {
    prompt.push({ type: 'text', text: `Instructions from ${origin}:\n${systemPrompt}` });
  }
  prompt.push({ type: 'text', text });
  return prompt;
}

/**
 * `_meta` carried on every `session/prompt`, so a Harbor-aware agent can
 * read it instead of (or alongside) the labelled text block above, which
 * stays for agents that don't look at `_meta`.
 */
export function provenanceMeta(origin: string): { 'harbor/provenance': { source: 'website'; origin: string } } {
  return { 'harbor/provenance': { source: 'website', origin } };
}

/**
 * Wraps the bridge's acp.open event stream as the ACP SDK's bidirectional
 * `Stream`: the agent's parsed JSON-RPC messages become the readable side,
 * and every message the SDK writes is relayed with `acp.send`. Resolves
 * once the agent exits (normally or on a fatal error), from the reader
 * side's point of view — the SDK's connection then rejects whatever
 * request was still waiting on a response, which the caller maps to
 * ERR_AGENT_FAILED unless it already knows why it cancelled.
 */
export function bridgeToSdkStream(channel: string, events: AsyncGenerator<AcpBridgeEvent>): AcpStream {
  let controller!: ReadableStreamDefaultController<AnyMessage>;
  const readable = new ReadableStream<AnyMessage>({
    start(c) {
      controller = c;
    },
  });

  (async () => {
    try {
      for (;;) {
        const { value, done } = await events.next();
        if (done) {
          controller.close();
          return;
        }
        if (value.type === 'message') {
          controller.enqueue(value.message as AnyMessage);
        } else if (value.type === 'exit') {
          controller.close();
          return;
        } else if (value.type === 'error' && value.fatal) {
          // A fatal error after `open` isn't part of the documented
          // contract, but failing closed here is safe either way.
          controller.error(new Error(value.message));
          return;
        }
        // A non-fatal 'error' (a dropped line, a broken write) is
        // recoverable: keep reading for more `message`/`exit` events.
      }
    } catch (e) {
      controller.error(e instanceof Error ? e : new Error(String(e)));
    }
  })();

  const writable = new WritableStream<AnyMessage>({
    async write(chunk) {
      await acpSend(channel, chunk);
    },
  });

  return { readable, writable };
}

/**
 * The result of waiting for `acp.open`'s first event: either the agent
 * started (`ready`, with the channel and its working directory), the abort
 * landed before or during that wait (`cancelled` — `onChannelKnown` may
 * still have been called, so the caller can close a channel that did get
 * opened), or the agent failed to start (`failed`, with the error event to
 * deliver to the page). Shared because agent.run and a text session's
 * `open()` both wait on exactly this, the only difference being what they
 * do once they have a channel and a `cwd`.
 */
export type AcpChannelResult =
  | { kind: 'ready'; channel: string; cwd: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: StreamToken };

/**
 * Waits for `acp.open`'s first event and classifies it. `isAborted` is
 * checked both before and after the wait, since the abort can land while
 * `acp.open` is still in flight — if it does, and that first event still
 * produced a channel, `onChannelKnown` is called so the caller can close it
 * in its own cleanup, but this still reports `cancelled` either way, never
 * going on to `initialize`/`session/new`.
 */
export async function openAcpChannel(
  bridgeEvents: AsyncGenerator<AcpBridgeEvent>,
  isAborted: () => boolean,
  onChannelKnown: (channel: string) => void,
): Promise<AcpChannelResult> {
  try {
    const first = await bridgeEvents.next();

    if (isAborted()) {
      if (!first.done && first.value.type === 'open') onChannelKnown(first.value.channel);
      return { kind: 'cancelled' };
    }

    if (first.done) {
      return { kind: 'failed', error: agentFailedEvent('Agent closed before starting') };
    }
    const opened = first.value;
    if (opened.type === 'error') {
      // The bridge's reason can name local paths or configuration, so the
      // page only learns that the agent didn't start.
      console.warn('[Harbor] ACP agent failed to start:', opened.message);
      return { kind: 'failed', error: agentFailedEvent('The agent failed to start') };
    }
    if (opened.type !== 'open' || !opened.cwd) {
      return { kind: 'failed', error: agentFailedEvent('Agent did not report a working directory') };
    }
    onChannelKnown(opened.channel);
    return { kind: 'ready', channel: opened.channel, cwd: opened.cwd };
  } catch (e) {
    console.warn('[Harbor] ACP agent failed to start:', e instanceof Error ? e.message : e);
    return { kind: 'failed', error: agentFailedEvent('The agent failed to start') };
  }
}

/**
 * Runs `initialize` (protocol v1, no `fs`/`terminal` capabilities) and
 * `session/new`, exactly as acp-backend.ts did inline before this was
 * extracted. Returns the new session's id, or the terminal error to
 * deliver to the page (an unsupported protocol version) — the caller
 * decides how (`send(...)` for agent.run, a rejected `open()` for a text
 * session).
 */
export async function initializeAcpSession(
  ctx: ClientContext,
  cwd: string,
  cancellationSignal: AbortSignal,
): Promise<{ ok: true; sessionId: string } | { ok: false; error: StreamToken }> {
  const initResult = await ctx.request(
    AGENT_METHODS.initialize,
    {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    },
    { cancellationSignal, stopWaitingOnCancel: true },
  );
  if (initResult.protocolVersion !== 1) {
    return { ok: false, error: agentFailedEvent('unsupported ACP protocol version') };
  }

  const newSession = await ctx.request(
    AGENT_METHODS.session_new,
    { cwd, mcpServers: [] },
    { cancellationSignal, stopWaitingOnCancel: true },
  );
  return { ok: true, sessionId: newSession.sessionId };
}
