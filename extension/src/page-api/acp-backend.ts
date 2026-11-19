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
 * tools, so `AgentRunRequest.tools` is ignored here.
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
type CancelReason = 'aborted' | 'permission-denied' | 'tool-limit' | 'timeout';

function cancelReasonEvent(reason: CancelReason): StreamToken {
  switch (reason) {
    case 'aborted':
      return { type: 'error', error: { code: ErrorCodes.ABORTED, message: 'Run aborted' } };
    case 'permission-denied':
      return { type: 'error', error: { code: ErrorCodes.PERMISSION_DENIED, message: 'Permission model:prompt required' } };
    case 'tool-limit':
      return { type: 'error', error: { code: ErrorCodes.BUDGET_EXCEEDED, message: 'Tool call budget exceeded' } };
    case 'timeout':
      return { type: 'error', error: { code: ErrorCodes.TIMEOUT, message: 'Agent run timed out' } };
  }
}

function agentFailedEvent(message: string): StreamToken {
  return { type: 'error', error: { code: ErrorCodes.AGENT_FAILED, message } };
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

    if (signal.aborted) {
      emit(cancelReasonEvent('aborted'));
      return;
    }

    const { stream: bridgeEvents, cancel: cancelBridgeStream } = acpOpenStream(this.agentId, origin);
    // Set only once `open` arrives, so the `finally` below knows whether
    // there's a real channel to `acp.close` — a fatal pre-open failure
    // never produced one.
    let channel: string | undefined;

    try {
      let cwd: string;
      try {
        const first = await bridgeEvents.next();
        if (first.done) {
          emit(agentFailedEvent('Agent closed before starting'));
          return;
        }
        const opened = first.value;
        if (opened.type === 'error') {
          emit(agentFailedEvent(opened.message));
          return;
        }
        if (opened.type !== 'open' || !opened.cwd) {
          emit(agentFailedEvent('Agent did not report a working directory'));
          return;
        }
        channel = opened.channel;
        cwd = opened.cwd;
      } catch (e) {
        emit(agentFailedEvent(e instanceof Error ? e.message : 'Agent failed to start'));
        return;
      }

      await this.runSession(channel, cwd, bridgeEvents, req, emit, signal);
    } finally {
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
    const { origin, tabId, task, systemPrompt, maxToolCalls } = req;

    let cancelReason: CancelReason | null = null;
    let sessionId: string | null = null;
    let accumulatedText = '';
    // The budget counts distinct tool calls, not every notification about
    // one: a call is counted once, the first time its id appears, whether
    // that's its `tool_call` or (for an id that never got one) its first
    // `tool_call_update`. Later progress updates for the same id are free.
    let toolCallCount = 0;
    const countedToolCallIds = new Set<string>();
    function countToolCall(toolCallId: string): 'ok' | 'over-budget' {
      if (countedToolCallIds.has(toolCallId)) return 'ok';
      countedToolCallIds.add(toolCallId);
      toolCallCount++;
      return toolCallCount > maxToolCalls ? 'over-budget' : 'ok';
    }
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
          emit({ type: 'token', token: JSON.stringify({ type: 'final', output: accumulatedText }) });
          emit({ type: 'done' });
          return;
        case 'refusal':
          emit({ type: 'error', error: { code: ErrorCodes.AGENT_REFUSED, message: 'The agent refused the request' } });
          return;
        case 'max_tokens':
        case 'max_turn_requests':
          emit({ type: 'error', error: { code: ErrorCodes.AGENT_LIMIT, message: `The agent stopped: ${stopReason}` } });
          return;
        case 'cancelled':
          if (cancelReason) {
            emit(cancelReasonEvent(cancelReason));
          } else {
            // Nothing here triggered the cancel — e.g. Codex reports
            // `cancelled` when a single tool call is rejected. Treat it as
            // the run ending normally, with whatever text came back.
            emit({ type: 'token', token: JSON.stringify({ type: 'final', output: accumulatedText }) });
            emit({ type: 'done' });
          }
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
            emit({ type: 'token', token: JSON.stringify({ type: 'thinking', content: update.content.text }) });
          }
          return;
        case 'tool_call': {
          if (cancelReason) return;

          if (!await hasPermission(origin, 'model:prompt', tabId)) {
            triggerCancel('permission-denied', ctx.agent);
            return;
          }
          if (countToolCall(update.toolCallId) === 'over-budget') {
            triggerCancel('tool-limit', ctx.agent);
            return;
          }

          const name = update.title || update.kind || update.toolCallId;
          toolNames.set(update.toolCallId, name);
          emit({ type: 'token', token: JSON.stringify({ type: 'tool_call', tool: name, args: update.rawInput ?? {} }) });
          return;
        }
        case 'tool_call_update': {
          if (cancelReason) return;

          if (!await hasPermission(origin, 'model:prompt', tabId)) {
            triggerCancel('permission-denied', ctx.agent);
            return;
          }
          if (countToolCall(update.toolCallId) === 'over-budget') {
            triggerCancel('tool-limit', ctx.agent);
            return;
          }

          if (update.status === 'completed' || update.status === 'failed') {
            const name = toolNames.get(update.toolCallId) ?? update.title ?? update.kind ?? update.toolCallId;
            emit({
              type: 'token',
              token: JSON.stringify({ type: 'tool_result', tool: name, result: update.content ?? update.rawOutput ?? null }),
            });
          }
          return;
        }
        default:
          // Plans, usage, modes and the rest are dropped at first (see
          // docs/ACP_BACKEND_DESIGN.md section 2).
          return;
      }
    });

    app.onRequest(CLIENT_METHODS.session_request_permission, async (ctx) => {
      if (cancelReason) return { outcome: { outcome: 'cancelled' } };
      const rejectOnce = ctx.params.options.find((o) => o.kind === 'reject_once');
      return rejectOnce
        ? { outcome: { outcome: 'selected', optionId: rejectOnce.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    });

    const stream = bridgeToSdkStream(channel, bridgeEvents);

    try {
      await app.connectWith(stream, async (ctx) => {
        connectionCtx = ctx;

        await ctx.request(
          AGENT_METHODS.initialize,
          {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          },
          { cancellationSignal: requestAbort.signal, stopWaitingOnCancel: true },
        );

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
          emit(cancelReasonEvent('permission-denied'));
          return;
        }

        const prompt: ContentBlock[] = [];
        if (systemPrompt) {
          prompt.push({ type: 'text', text: `Instructions from ${origin}:\n${systemPrompt}` });
        }
        prompt.push({ type: 'text', text: task });

        const result = await ctx.request(
          AGENT_METHODS.session_prompt,
          { sessionId: newSession.sessionId, prompt },
          { cancellationSignal: requestAbort.signal, stopWaitingOnCancel: true },
        );
        emitStopReason(result.stopReason);
      });
    } catch (e) {
      if (cancelReason) {
        emit(cancelReasonEvent(cancelReason));
      } else {
        emit(agentFailedEvent(e instanceof Error ? e.message : 'Agent run failed'));
      }
    } finally {
      signal.removeEventListener('abort', onPageAbort);
      clearTimeout(timeoutHandle);
    }
  }
}
