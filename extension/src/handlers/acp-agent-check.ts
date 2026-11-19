/**
 * The sidebar's "Check" action for a configured ACP agent: starts it the
 * same way a real `agent.run` would (`acp.open`, then `initialize`), but
 * against a fixed, non-site workspace, and stops at `initialize` — never
 * `session/new`, since checking an agent isn't running a turn on it.
 *
 * Deliberately does not use acp-agent-limits.ts: this isn't a site's agent,
 * so it must never count against, or be refused by, any site's per-site
 * agent cap (docs/ACP_BACKEND_DESIGN.md section 2). It also doesn't reuse
 * page-api/acp-connection.ts's `openAcpChannel`, which scrubs the bridge's
 * own fatal-error text for page safety — there's no page here, only the
 * person checking their own setup, so the raw reason is more useful than
 * Harbor's generic "the agent failed to start".
 */
import {
  client,
  AGENT_METHODS,
  type AnyMessage,
  type Stream as AcpStream,
} from '@agentclientprotocol/sdk';

import { acpClose, acpOpenStream, acpSend, type AcpBridgeEvent } from '../page-api/harbor-core';

/** The bridge workspace every agent check uses — never a site's origin. */
export const AGENT_CHECK_WORKSPACE = 'harbor-agent-check';

/**
 * A check's overall cap: `npx` may download its package on an agent's
 * first run, so this is generous rather than matching a normal RPC
 * timeout.
 */
export const AGENT_CHECK_TIMEOUT_MS = 30_000;

export function formatAgentCheckTimeout(agentName: string): string {
  return `Timed out waiting for ${agentName} to start (30 s).`;
}

export type AgentCheckResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/**
 * "Ready (<configured name> vN)", or just "Ready (<configured name>)" when
 * the agent reports no version. Always the name the person gave this agent
 * in the sidebar — never `agentInfo.name`, which is whatever package the
 * agent itself reports (e.g. a Claude Code ACP adapter might report its own
 * npm package name, not "Claude Code"); that would be a stray protocol-level
 * detail in copy a person reads (maintainer decision). The
 * version, by contrast, is useful and has no such mismatch, so it still
 * comes from `agentInfo`.
 */
export function formatAgentCheckSuccess(
  configuredName: string,
  agentInfo: { name?: string; version?: string } | undefined,
): string {
  if (agentInfo?.version) return `Ready (${configuredName} v${agentInfo.version})`;
  return `Ready (${configuredName})`;
}

/** The literal wording the maintainer settled on for a spawn failure. */
export function formatAgentCheckSpawnFailure(command: string): string {
  return `Command not found: ${command}. Set the full path.`;
}

/**
 * Turns the bridge's own fatal-error text for a failed `acp.open` into the
 * right plain message — "Command not found" only for an actual spawn
 * ENOENT, with an unknown agent and a permission error each getting their
 * own wording, so the person isn't told to "set the full path" when the
 * real problem is that they haven't saved the agent yet, or the OS refused
 * to run it at all. Anything else keeps the bridge's own reason, since
 * this is sidebar-facing (the person checking their own setup), not
 * page-facing.
 */
export function classifyAgentOpenError(message: string, command: string, agentId: string): string {
  if (/unknown agent/i.test(message)) {
    return `Unknown agent: ${agentId}. Save it before checking it.`;
  }
  // ENOENT/EACCES are the raw errno names; "No such file or directory"/
  // "os error 2" and "Permission denied"/"os error 13" are the real Rust
  // bridge's own wording (std::io::Error's Display) for the same two
  // errnos — both forms are matched, since the bridge's exact phrasing
  // isn't a contract this module controls.
  if (/enoent/i.test(message) || /no such file or directory/i.test(message) || /os error 2\b/i.test(message)) {
    return formatAgentCheckSpawnFailure(command);
  }
  if (/eacces/i.test(message) || /permission denied/i.test(message) || /os error 13\b/i.test(message)) {
    return `Permission denied running ${command}.`;
  }
  return `Could not start ${command}: ${message}`;
}

// Mirrors page-api/acp-connection.ts's bridgeToSdkStream exactly (duplicated
// rather than imported, since that module's version is tied to the page
// backends' own StreamToken/AcpBridgeEvent error handling, which this check
// deliberately doesn't want — see the file header).
function bridgeToSdkStream(channel: string, events: AsyncGenerator<AcpBridgeEvent>): AcpStream {
  let controller!: ReadableStreamDefaultController<AnyMessage>;
  const readable = new ReadableStream<AnyMessage>({ start(c) { controller = c; } });

  (async () => {
    try {
      for (;;) {
        const { value, done } = await events.next();
        if (done) { controller.close(); return; }
        if (value.type === 'message') {
          controller.enqueue(value.message as AnyMessage);
        } else if (value.type === 'exit') {
          controller.close();
          return;
        } else if (value.type === 'error' && value.fatal) {
          controller.error(new Error(value.message));
          return;
        }
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
 * One check per agent at a time: a second call for an `agentId` already
 * being checked reuses the first call's promise instead of opening a
 * second channel — the sidebar also disables the relevant buttons while a
 * check runs, but this is the backstop for any caller.
 */
const inFlightChecks = new Map<string, Promise<AgentCheckResult>>();

/** Starts (or reuses an in-flight check for) `agentId`. See `runAgentCheck` for what actually happens. */
export function checkAcpAgent(
  agentId: string,
  agentName: string,
  command: string,
): Promise<AgentCheckResult> {
  const existing = inFlightChecks.get(agentId);
  if (existing) return existing;

  const promise = runAgentCheck(agentId, agentName, command).finally(() => {
    // Only this call's own entry — a later check for the same agent, once
    // this one has settled, must not be deduped against a stale promise.
    if (inFlightChecks.get(agentId) === promise) inFlightChecks.delete(agentId);
  });
  inFlightChecks.set(agentId, promise);
  return promise;
}

/** For tests only — the per-agent dedupe map is otherwise self-cleaning. */
export function resetAcpAgentChecksForTests(): void {
  inFlightChecks.clear();
}

/**
 * Starts `agentId` (already configured and saved), runs `initialize`, and
 * closes it. `agentName` and `command` are the sidebar's own copy of the
 * agent record it's checking — used only to word the result, never to
 * decide what the bridge runs (that's `agentId` alone, resolved on the
 * bridge's own side against its configured agents). Bounded by
 * `AGENT_CHECK_TIMEOUT_MS` overall; on every path — success, a bridge or
 * protocol error, or this timeout — the agent is closed exactly once.
 */
async function runAgentCheck(
  agentId: string,
  agentName: string,
  command: string,
): Promise<AgentCheckResult> {
  // Deliberately never calls the stream's own `cancel()`: the real
  // native-bridge.ts `cancel()` (llm/native-bridge.ts's
  // `rpcStreamRequest`) has no way to tell the bridge to actually stop —
  // it only deletes its own pending-stream registration, so any event the
  // bridge still goes on to send afterward (including a late `open`,
  // carrying the one piece of information needed to close the channel) is
  // silently dropped, never delivered. Calling it before `open` arrives
  // would orphan the agent process forever, with nothing left able to
  // learn its channel id. Instead this keeps listening — exactly
  // page-api/acp-connection.ts's `openAcpChannel` pattern for the real
  // `agent.run`/text-session paths — until the open (or a fatal error)
  // actually arrives, however long that takes past this function's own
  // 30s timeout, and closes the channel the moment it's known.
  const { stream: bridgeEvents } = acpOpenStream(agentId, AGENT_CHECK_WORKSPACE);
  let channel: string | undefined;
  // Tracks which channel has actually been closed, not just *that*
  // cleanup has run once: if the timeout wins the race below before
  // `acp.open` resolves, the first cleanup finds no channel yet (nothing
  // to close) — `attempt` is still running in the background, and only
  // learns the channel afterwards. A one-shot "already cleaned up" flag
  // would permanently skip that later, real cleanup and leak the agent
  // process; comparing against the specific channel closed instead lets a
  // *later* cleanup still close a channel the first one never saw, while
  // still never closing the same channel twice.
  let closedChannel: string | undefined;
  const cleanUp = async (): Promise<void> => {
    if (channel && channel !== closedChannel) {
      closedChannel = channel;
      await acpClose(channel).catch(() => { /* best-effort */ });
    }
  };

  const attempt = (async (): Promise<AgentCheckResult> => {
    try {
      const first = await bridgeEvents.next();
      if (first.done) {
        return { ok: false, error: 'Agent closed before starting' };
      }
      const opened = first.value;
      if (opened.type === 'error') {
        if (opened.code === 'agent_cap') {
          return { ok: false, error: 'Too many agents are running' };
        }
        return { ok: false, error: classifyAgentOpenError(opened.message, command, agentId) };
      }
      if (opened.type !== 'open') {
        return { ok: false, error: 'Agent did not start' };
      }
      channel = opened.channel;

      const app = client({ name: 'harbor' });
      const stream = bridgeToSdkStream(channel, bridgeEvents);

      let result: AgentCheckResult = { ok: false, error: 'The agent did not respond' };
      try {
        await app.connectWith(stream, async (ctx) => {
          const initResult = await ctx.request(AGENT_METHODS.initialize, {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          });
          if (initResult.protocolVersion !== 1) {
            result = { ok: false, error: `Unsupported ACP protocol version: ${initResult.protocolVersion}` };
            return;
          }
          result = { ok: true, message: formatAgentCheckSuccess(agentName, initResult.agentInfo ?? undefined) };
        });
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      return result;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  })();

  // If `attempt` loses the race to the timeout below, it keeps running in
  // the background rather than being cancelled outright (this check has
  // no way to abort a pending `acp.open`) — including, when it gets that
  // far, setting `channel` only *after* the timeout's own cleanup already
  // ran with no channel yet to close. This makes sure that channel still
  // gets closed, right away, once `attempt` actually settles, rather than
  // leaking the agent process for however long it takes to start.
  attempt.catch(() => { /* already reported through the race below, or never will be */ }).finally(() => { void cleanUp(); });

  const timeout = new Promise<AgentCheckResult>((resolve) => {
    setTimeout(() => resolve({ ok: false, error: formatAgentCheckTimeout(agentName) }), AGENT_CHECK_TIMEOUT_MS);
  });

  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    // Runs on every path, including the timeout winning the race. Safe to
    // call alongside `attempt`'s own cleanup above — `cleanUp` never closes
    // the same channel twice.
    await cleanUp();
  }
}
