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
 * Tools: this backend still offers the agent none of Harbor's own
 * (installed-server) tools, so `AgentRunRequest.tools` is ignored here —
 * only the origin/tab's own site-registered MCP servers
 * (`mcp/site-servers.ts`, via harbor-core.ts's `listSiteServersForAcp`)
 * are candidates for `session/new`, and only when the origin holds both
 * `mcp:tools.list` and `mcp:tools.call` (otherwise none of them are);
 * among those, each server is then checked on its own against the
 * policy engine (`siteServerCandidatesForAcp` below) — a rule naming one
 * server (or a glob) only filters that one out, not every site server
 * the origin registered. What's left is then further filtered to only
 * the ones the agent's own `initialize` response says it can use
 * (`acp-connection.ts`'s `initializeAcpSession`). `AgentRunRequest.
 * maxToolCalls` is ignored too: Harbor gates whether a site may use the
 * user's agent at all, not how the agent works once it's running —
 * there's no tool-call budget on this backend, and no per-tool allowlist
 * either, for either kind of tool (a maintainer decision; see
 * docs/ACP_BACKEND_DESIGN.md).
 */
import {
  client,
  AGENT_METHODS,
  CLIENT_METHODS,
  type ClientContext,
  type StopReason,
} from '@agentclientprotocol/sdk';

import { acpClose, acpOpenStream, listSiteServersForAcp, policyAllowsSiteToolsForAcp, requireAgentPromptAction, type AcpBridgeEvent } from './harbor-core';
import type { SiteMcpServerDescriptor } from '../mcp/site-servers';
import { hasPermission } from './handlers';
import { PER_SITE_AGENT_LIMIT, tryAcquireAgentSlot, releaseAgentSlot } from './acp-agent-limits';
import type { StreamToken } from './types';
import type { AgentBackend, AgentRunRequest } from './agent-backend';
import {
  ACP_TURN_TIMEOUT_MS,
  agentBusyEvent,
  answerPermissionRequest,
  bridgeToSdkStream,
  buildPathScrubber,
  buildPromptBlocks,
  cancelReasonEvent,
  cancelReasonForSignal,
  agentFailedEvent,
  combineAbortSignals,
  initializeAcpSession,
  openAcpChannel,
  provenanceMeta,
  scrubDeep,
  stopReasonOutcome,
  type CancelReason,
} from './acp-connection';

// Re-exported under this backend's existing names: acp-backend.test.ts and
// acp-backend-races.test.ts import these from here, and the extraction into
// acp-connection.ts (shared with acp-text-session.ts) shouldn't need them to
// change.
export { answerPermissionRequest, combineAbortSignals };
/** This backend's own name for the shared per-turn timeout. */
export const ACP_RUN_TIMEOUT_MS = ACP_TURN_TIMEOUT_MS;

/**
 * The origin/tab's site-registered MCP servers that may be passed into
 * `session/new` (HBR-134, D2): none of them at all unless the origin
 * holds *both* `mcp:tools.list` and `mcp:tools.call` (Harbor's own
 * origin-grant store, the same check `background.ts`'s `handleAgentRun`
 * makes for the built-in backend's own tools) — that's an all-or-nothing
 * gate on the *origin*, not a per-server one, since Harbor's grant store
 * itself isn't per-server. Past that, each candidate is checked on its
 * own against the policy engine with no prompt
 * (`policyAllowsSiteToolsForAcp`), so a rule naming one server (or a
 * glob) only filters that one out. The per-tool allowlist still doesn't
 * apply to an ACP agent's own tool use (unchanged maintainer decision).
 */
async function siteServerCandidatesForAcp(origin: string, tabId?: number): Promise<SiteMcpServerDescriptor[]> {
  if (!await hasPermission(origin, 'mcp:tools.list', tabId)) return [];
  if (!await hasPermission(origin, 'mcp:tools.call', tabId)) return [];
  const candidates = listSiteServersForAcp(origin, tabId);
  if (candidates.length === 0) return [];
  const allowedIds = new Set(await policyAllowsSiteToolsForAcp(origin, tabId, candidates.map((c) => c.serverId)));
  return candidates.filter((c) => allowedIds.has(c.serverId));
}

export class AcpAgentBackend implements AgentBackend {
  constructor(private readonly agentId: string) {}

  async run(req: AgentRunRequest, emit: (event: StreamToken) => void, signal: AbortSignal): Promise<void> {
    const { origin, tabId, task, systemPrompt } = req;

    // Checked, and reserved, before `acp.open` is ever called — a run past
    // this site's own cap (counted together with its text sessions) never
    // reaches the bridge at all.
    if (!tryAcquireAgentSlot(origin)) {
      emit(agentBusyEvent(`This site already has ${PER_SITE_AGENT_LIMIT} agents running`));
      return;
    }

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
        emit(cancelReasonEvent(cancelReasonForSignal(signal)));
        return;
      }

      const opened = await openAcpChannel(bridgeEvents, () => aborted, (ch) => { channel = ch; });
      if (opened.kind === 'cancelled') {
        // The abort landed while `acp.open` was still in flight. If a
        // channel did get opened, `openAcpChannel` already reported it
        // through `onChannelKnown` above, so the `finally` below still
        // closes it; either way, this never reaches initialize/prompt.
        // `signal` may have aborted because the page/tab gave up, or
        // because the person switched backends mid-run — report whichever
        // it actually was.
        emit(cancelReasonEvent(cancelReasonForSignal(signal)));
        return;
      }
      if (opened.kind === 'failed') {
        emit(opened.error);
        return;
      }

      await this.runSession(opened.channel, opened.cwd, bridgeEvents, req, emit, signal);
    } finally {
      signal.removeEventListener('abort', onAbort);
      cancelBridgeStream();
      if (channel) {
        await acpClose(channel).catch(() => { /* best-effort: the run's own outcome already stands */ });
      }
      releaseAgentSlot(origin);
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
    // Aborts the instant a terminal event is sent, whatever ends the run
    // (success, refusal, a limit, an error, or a cancellation) — so a
    // `session/request_permission` dialog still open at that moment closes
    // right away, rather than waiting on `ctx.signal`'s own timing (which
    // depends on the SDK noticing the connection closed) or the 5-minute
    // liveness timeout.
    const runEnded = new AbortController();
    function send(event: StreamToken): void {
      if (terminalSent) return;
      if (event.type === 'done' || event.type === 'error') {
        terminalSent = true;
        runEnded.abort();
      }
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

    let connectionCtx: ClientContext | undefined;

    // `signal` may abort because the page/tab gave up (an ordinary
    // ERR_ABORTED), or because the person switched `harbor_agent_backend`
    // while this run was still going on the old agent (background.ts
    // combines the two) — cancelReasonForSignal tells them apart so the
    // right one reaches the page.
    const onPageAbort = () => triggerCancel(cancelReasonForSignal(signal), connectionCtx);
    signal.addEventListener('abort', onPageAbort);
    // An abort landing between `openAcpChannel` resolving (this method's
    // caller already has a channel and a cwd) and this listener being
    // registered, just above, would otherwise be missed entirely — nothing
    // else re-checks `signal` before the connection starts, so a run that
    // raced exactly that window would run to completion, or sit until the
    // 10-minute timeout, instead of ending right away.
    if (signal.aborted) triggerCancel(cancelReasonForSignal(signal), connectionCtx);
    const timeoutHandle = setTimeout(() => triggerCancel('timeout', connectionCtx), ACP_RUN_TIMEOUT_MS);

    function emitStopReason(stopReason: StopReason): void {
      const outcome = stopReasonOutcome(stopReason, cancelReason);
      if (outcome.ok) {
        sendToken({ type: 'final', output: accumulatedText });
        send({ type: 'done' });
      } else {
        send(outcome.error);
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

    app.onRequest(CLIENT_METHODS.session_request_permission, async (ctx) => {
      // The run can already be over by the time this arrives (the agent's
      // own request can race session/prompt's response) — never open a
      // dialog for a question nobody's run is still waiting on.
      if (terminalSent) return { outcome: { outcome: 'cancelled' } };

      const { toolCall, options } = ctx.params;
      return answerPermissionRequest(
        () => cancelReason !== null,
        {
          origin,
          agentName: this.agentId,
          toolCall: {
            title: toolCall.title ?? '',
            kind: toolCall.kind ?? undefined,
            rawInput: toolCall.rawInput,
            locations: toolCall.locations?.map((l) => ({ path: l.path, line: l.line ?? undefined })),
          },
          options,
        },
        // Combined so the dialog closes on whichever happens first: Harbor's
        // own cancellation, the SDK's signal for this request (the agent's
        // `$/cancel_request`, or the connection closing), or the run
        // reaching its terminal event right here in this same connection.
        combineAbortSignals([requestAbort.signal, ctx.signal, runEnded.signal]),
      );
    });

    const stream = bridgeToSdkStream(channel, bridgeEvents);

    try {
      await app.connectWith(stream, async (ctx) => {
        connectionCtx = ctx;

        const siteServers = await siteServerCandidatesForAcp(origin, tabId);
        const initialized = await initializeAcpSession(ctx, cwd, requestAbort.signal, siteServers);
        if (!initialized.ok) {
          send(initialized.error);
          return;
        }
        sessionId = initialized.sessionId;

        // Re-checked here, not only at the start of the run: the grant can
        // be revoked during `initialize`/`session/new`, and this is the
        // last check before the agent does anything on the page's behalf.
        if (!await hasPermission(origin, 'model:prompt', tabId)) {
          triggerCancel('permission-denied', ctx);
          send(cancelReasonEvent('permission-denied'));
          return;
        }

        // The typed-action policy gate (model.prompt.agent): reaches the
        // rule engine and the audit log, exactly as a prompt to Harbor's
        // own model does — in addition to, not instead of, the origin-grant
        // check just above.
        if (!await requireAgentPromptAction(origin, tabId)) {
          triggerCancel('permission-denied', ctx);
          send(cancelReasonEvent('permission-denied'));
          return;
        }

        const result = await ctx.request(
          AGENT_METHODS.session_prompt,
          {
            sessionId: initialized.sessionId,
            prompt: buildPromptBlocks(origin, task, systemPrompt, true),
            // A Harbor-aware agent can read this instead of (or alongside)
            // the labelled text block above, which stays for agents that
            // don't look at `_meta`.
            _meta: provenanceMeta(origin),
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
