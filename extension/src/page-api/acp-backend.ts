/**
 * Harbor Page API - ACP agent backend
 *
 * Runs a page's `window.agent.run` on the user's own agent over the Agent
 * Client Protocol (ACP), instead of Harbor's built-in model loop. See
 * docs/ACP_BACKEND_DESIGN.md. background.ts's `handleAgentRun` still owns
 * the `toolCalling` feature flag, the `model:prompt` / `model:tools` grant
 * checks before the run starts, and delivering events to the page — this
 * backend only runs the task against the agent it's handed and stops
 * promptly once its signal aborts, exactly like `builtinAgentBackend`.
 *
 * Transport: the bridge starts the agent and relays its JSON-RPC messages
 * (bridge-rs/README.md "ACP agents"); this file wraps that relay as the
 * ACP SDK's `Stream` and drives it with the SDK's `client()` app. The SDK
 * doesn't export a `ClientSideConnection` class (the name used while this
 * was being designed) — `@agentclientprotocol/sdk` 2.8.0's actual stable
 * v1 API is `client({...}).connectWith(stream, async (ctx) => ...)`, which
 * is the same role: a client-side connection over the stream, read through
 * a `ClientContext`.
 *
 * Tools: the first release offers the agent none of Harbor's or the page's
 * tools, so `AgentRunRequest.tools` is ignored here. `AgentRunRequest.
 * maxToolCalls` is ignored too: Harbor gates whether a site may use the
 * user's agent at all, not how the agent works once it's running — there's
 * no tool-call budget on this backend (a maintainer decision; see
 * docs/ACP_BACKEND_DESIGN.md).
 */
import {
  client,
  AGENT_METHODS,
  CLIENT_METHODS,
  type AnyMessage,
  type ClientContext,
  type ContentBlock,
  type Stream as AcpStream,
  type StopReason,
} from '@agentclientprotocol/sdk';

import { acpClose, acpOpenStream, acpSend, type AcpBridgeEvent } from './harbor-core';
import { hasPermission } from './handlers';
import { ErrorCodes, type StreamToken } from './types';
import type { AgentBackend, AgentRunRequest } from './agent-backend';

/**
 * An agent turn can take minutes, so this backend never uses
 * `harborRequest`'s 30-second default. This is its own overall cap, after
 * which the run is cancelled and ends with `ERR_TIMEOUT`.
 */
export const ACP_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** Why this backend sent `session/cancel` — decides the error a `cancelled` stopReason (or a request this backend gave up waiting on) maps to. */
type CancelReason = 'aborted' | 'permission-denied' | 'timeout';

function cancelReasonEvent(reason: CancelReason): StreamToken {
  switch (reason) {
    case 'aborted':
      return { type: 'error', error: { code: ErrorCodes.ABORTED, message: 'Run aborted' } };
    case 'permission-denied':
      return { type: 'error', error: { code: ErrorCodes.PERMISSION_DENIED, message: 'Permission model:prompt required' } };
    case 'timeout':
      return { type: 'error', error: { code: ErrorCodes.TIMEOUT, message: 'Agent run timed out' } };
  }
}

function agentFailedEvent(message: string): StreamToken {
  return { type: 'error', error: { code: ErrorCodes.AGENT_FAILED, message } };
}

/**
 * Answers one `session/request_permission`. Harbor never passes an
 * agent-native "always" through, and once the run is already cancelled
 * (`cancelled` is true before this is even asked — see the guard below),
 * every request gets `cancelled` too, whatever options it offers: a
 * request that's still in flight when Harbor gives up must not approve
 * anything on the page's behalf.
 *
 * A pure function, not a method, so the guard is testable on its own
 * without needing a live round trip through a real connection, which
 * normally tears down at almost the same moment `cancelled` becomes true.
 */
export function answerPermissionRequest(
  cancelled: boolean,
  options: ReadonlyArray<{ optionId: string; kind: string }>,
): { outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } } {
  if (cancelled) return { outcome: { outcome: 'cancelled' } };
  const rejectOnce = options.find((o) => o.kind === 'reject_once');
  return rejectOnce
    ? { outcome: { outcome: 'selected', optionId: rejectOnce.optionId } }
    : { outcome: { outcome: 'cancelled' } };
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
function buildPathScrubber(cwd: string): (text: string) => string {
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
function scrubDeep<T>(value: T, scrub: (text: string) => string): T {
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
 * Wraps the bridge's acp.open event stream as the ACP SDK's bidirectional
 * `Stream`: the agent's parsed JSON-RPC messages become the readable side,
 * and every message the SDK writes is relayed with `acp.send`. Resolves
 * once the agent exits (normally or on a fatal error), from the reader
 * side's point of view — the SDK's connection then rejects whatever
 * request was still waiting on a response, which the caller maps to
 * ERR_AGENT_FAILED unless it already knows why it cancelled.
 */
function bridgeToSdkStream(channel: string, events: AsyncGenerator<AcpBridgeEvent>): AcpStream {
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

export class AcpAgentBackend implements AgentBackend {
  constructor(private readonly agentId: string) {}

  async run(req: AgentRunRequest, emit: (event: StreamToken) => void, signal: AbortSignal): Promise<void> {
    const { origin, tabId, task, systemPrompt } = req;

    // Registered before the first `acp.open` event, not just checked once
    // up front: an abort (the page's, or a tab closing) can land at any
    // point while the agent is still starting, before there's a session
    // (or even a channel) to cancel. `aborted` is re-checked right after
    // the first event arrives, below, so that case still ends with
    // exactly one ERR_ABORTED instead of going on to initialize/prompt.
    let aborted = signal.aborted;
    const onAbort = () => { aborted = true; };
    signal.addEventListener('abort', onAbort);

    const { stream: bridgeEvents, cancel: cancelBridgeStream } = acpOpenStream(this.agentId, origin);
    // Set only once `open` arrives, so the `finally` below knows whether
    // there's a real channel to `acp.close` — a fatal pre-open failure,
    // or an abort that landed before `open`, never produced one.
    let channel: string | undefined;

    try {
      if (aborted) {
        emit(cancelReasonEvent('aborted'));
        return;
      }

      let cwd: string;
      try {
        const first = await bridgeEvents.next();

        if (aborted) {
          // The abort landed while `acp.open` was still in flight. If this
          // first event still produced a channel, close it in the
          // `finally` below; either way, never reach initialize/prompt.
          if (!first.done && first.value.type === 'open') channel = first.value.channel;
          emit(cancelReasonEvent('aborted'));
          return;
        }

        if (first.done) {
          emit(agentFailedEvent('Agent closed before starting'));
          return;
        }
        const opened = first.value;
        if (opened.type === 'error') {
          // The bridge's reason can name local paths or configuration, so
          // the page only learns that the agent didn't start.
          console.warn('[Harbor] ACP agent failed to start:', opened.message);
          emit(agentFailedEvent('The agent failed to start'));
          return;
        }
        if (opened.type !== 'open' || !opened.cwd) {
          emit(agentFailedEvent('Agent did not report a working directory'));
          return;
        }
        channel = opened.channel;
        cwd = opened.cwd;
      } catch (e) {
        console.warn('[Harbor] ACP agent failed to start:', e instanceof Error ? e.message : e);
        emit(agentFailedEvent('The agent failed to start'));
        return;
      }

      await this.runSession(channel, cwd, bridgeEvents, req, emit, signal);
    } finally {
      signal.removeEventListener('abort', onAbort);
      cancelBridgeStream();
      if (channel) {
        await acpClose(channel).catch(() => { /* best-effort: the run's own outcome already stands */ });
      }
    }
  }

  private async runSession(
    channel: string,
    cwd: string,
    bridgeEvents: AsyncGenerator<AcpBridgeEvent>,
    req: AgentRunRequest,
    emit: (event: StreamToken) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const { origin, tabId, task, systemPrompt } = req;

    const scrub = buildPathScrubber(cwd);

    // `session/update` notifications are handled concurrently (the SDK
    // doesn't wait for one handler to settle before dispatching the
    // next), so a `tool_call_update` that's still awaiting its grant
    // re-check can resolve after `session/prompt`'s response already
    // produced the terminal event. `send`/`sendToken` are the only way
    // anything reaches the page from here on, so this flag alone decides
    // it: once a terminal event has gone out, nothing more does.
    let terminalSent = false;
    function send(event: StreamToken): void {
      if (terminalSent) return;
      if (event.type === 'done' || event.type === 'error') terminalSent = true;
      emit(event);
    }
    function sendToken(payload: Record<string, unknown>): void {
      send({ type: 'token', token: JSON.stringify(scrubDeep(payload, scrub)) });
    }

    let cancelReason: CancelReason | null = null;
    let sessionId: string | null = null;
    let accumulatedText = '';
    const toolNames = new Map<string, string>();
    const requestAbort = new AbortController();

    const triggerCancel = (reason: CancelReason, ctx?: ClientContext) => {
      if (cancelReason) return;
      cancelReason = reason;
      if (sessionId && ctx) {
        ctx.notify(AGENT_METHODS.session_cancel, { sessionId }).catch(() => { /* best-effort */ });
      }
      requestAbort.abort();
    };

    const onPageAbort = () => triggerCancel('aborted', connectionCtx);
    signal.addEventListener('abort', onPageAbort);
    const timeoutHandle = setTimeout(() => triggerCancel('timeout', connectionCtx), ACP_RUN_TIMEOUT_MS);

    let connectionCtx: ClientContext | undefined;

    function emitStopReason(stopReason: StopReason): void {
      switch (stopReason) {
        case 'end_turn':
          sendToken({ type: 'final', output: accumulatedText });
          send({ type: 'done' });
          return;
        case 'refusal':
          send({ type: 'error', error: { code: ErrorCodes.AGENT_REFUSED, message: 'The agent refused the request' } });
          return;
        case 'max_tokens':
        case 'max_turn_requests':
          send({ type: 'error', error: { code: ErrorCodes.AGENT_LIMIT, message: `The agent stopped: ${stopReason}` } });
          return;
        case 'cancelled':
          if (cancelReason) {
            send(cancelReasonEvent(cancelReason));
          } else {
            // Nothing here triggered the cancel — e.g. Codex reports
            // `cancelled` when a single tool call is rejected. Treat it as
            // the run ending normally, with whatever text came back.
            sendToken({ type: 'final', output: accumulatedText });
            send({ type: 'done' });
          }
          return;
        default:
          // A stop reason this client doesn't know. End the run so the page
          // isn't left waiting.
          send(agentFailedEvent(`The agent stopped with an unknown reason: ${String(stopReason)}`));
          return;
      }
    }

    const app = client({ name: 'harbor' });

    app.onNotification(CLIENT_METHODS.session_update, async (ctx) => {
      const update = ctx.params.update;
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
          if (update.content.type === 'text') accumulatedText += update.content.text;
          return;
        case 'agent_thought_chunk':
          if (update.content.type === 'text') {
            sendToken({ type: 'thinking', content: update.content.text });
          }
          return;
        case 'tool_call': {
          if (cancelReason) return;

          // Announced as soon as it arrives, before the (async) grant
          // re-check below: it's the agent telling the page what it's
          // about to do, in the agent's own order, not a decision that
          // needs gating itself — only the tool's actual result does.
          const name = update.title || update.kind || update.toolCallId;
          toolNames.set(update.toolCallId, name);
          sendToken({ type: 'tool_call', tool: name, args: update.rawInput ?? {} });

          if (!await hasPermission(origin, 'model:prompt', tabId)) {
            triggerCancel('permission-denied', ctx.agent);
          }
          return;
        }
        case 'tool_call_update': {
          if (cancelReason) return;

          if (!await hasPermission(origin, 'model:prompt', tabId)) {
            triggerCancel('permission-denied', ctx.agent);
            return;
          }

          if (update.status === 'completed' || update.status === 'failed') {
            const name = toolNames.get(update.toolCallId) ?? update.title ?? update.kind ?? update.toolCallId;
            sendToken({ type: 'tool_result', tool: name, result: update.content ?? update.rawOutput ?? null });
          }
          return;
        }
        default:
          // Plans, usage, modes and the rest are dropped at first (see
          // docs/ACP_BACKEND_DESIGN.md section 2).
          return;
      }
    });

    app.onRequest(CLIENT_METHODS.session_request_permission, async (ctx) =>
      answerPermissionRequest(cancelReason !== null, ctx.params.options));

    const stream = bridgeToSdkStream(channel, bridgeEvents);

    try {
      await app.connectWith(stream, async (ctx) => {
        connectionCtx = ctx;

        const initResult = await ctx.request(
          AGENT_METHODS.initialize,
          {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          },
          { cancellationSignal: requestAbort.signal, stopWaitingOnCancel: true },
        );
        if (initResult.protocolVersion !== 1) {
          send(agentFailedEvent('unsupported ACP protocol version'));
          return;
        }

        const newSession = await ctx.request(
          AGENT_METHODS.session_new,
          { cwd, mcpServers: [] },
          { cancellationSignal: requestAbort.signal, stopWaitingOnCancel: true },
        );
        sessionId = newSession.sessionId;

        // Re-checked here, not only at the start of the run: the grant can
        // be revoked during `initialize`/`session/new`, and this is the
        // last check before the agent does anything on the page's behalf.
        if (!await hasPermission(origin, 'model:prompt', tabId)) {
          triggerCancel('permission-denied', ctx);
          send(cancelReasonEvent('permission-denied'));
          return;
        }

        const prompt: ContentBlock[] = [];
        if (systemPrompt) {
          prompt.push({ type: 'text', text: `Instructions from ${origin}:\n${systemPrompt}` });
        }
        prompt.push({ type: 'text', text: task });

        const result = await ctx.request(
          AGENT_METHODS.session_prompt,
          {
            sessionId: newSession.sessionId,
            prompt,
            // A Harbor-aware agent can read this instead of (or alongside)
            // the labelled text block above, which stays for agents that
            // don't look at `_meta`.
            _meta: { 'harbor/provenance': { source: 'website', origin } },
          },
          { cancellationSignal: requestAbort.signal, stopWaitingOnCancel: true },
        );
        emitStopReason(result.stopReason);
      });
    } catch (e) {
      if (cancelReason) {
        send(cancelReasonEvent(cancelReason));
      } else {
        send(agentFailedEvent(scrub(e instanceof Error ? e.message : 'Agent run failed')));
      }
    } finally {
      signal.removeEventListener('abort', onPageAbort);
      clearTimeout(timeoutHandle);
    }
  }
}
