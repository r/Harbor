/**
 * In-process bridge from the page API to the rest of Harbor.
 *
 * Replaces the old Web Agents API's harbor-client.ts, which crossed an
 * extension boundary via chrome.runtime.sendMessage/connect to reach Harbor.
 * Everything here now runs inside Harbor's own background, so a page call
 * reaches the same handler through the same policy gate
 * (gatePageCall/requireAction) and the same audit log as any other call
 * into Harbor's agent router or extension API.
 *
 * This is the ONLY file under page-api/ allowed to import from outside
 * page-api/, browser-compat, or a type-only import (see
 * __tests__/import-boundary.test.ts). That keeps the rest of page-api/
 * swappable if the agent side (extension-api.ts, background-router.ts, ...)
 * changes shape later.
 */
import { gatePageAction, routeExtensionApiMessage, streamLlmChat } from '../extension-api';
import type { TypedAction } from '../policy/actions';
import { routeAgentMessage } from '../agents/background-router';
import { forgetTabAgents } from '../agents/handlers/multi-agent';
import { forgetTabServers, forgetTabServersIfOriginChanged, listSiteServersForAcp as listSiteServersForAcpImpl, type SiteMcpServerDescriptor } from '../mcp/site-servers';
import { rpcRequest, rpcStreamRequest } from '../llm/native-bridge';
import { browserAPI } from '../browser-compat';
import { ErrorCodes } from './types';
import { requireAction } from '../agents/handlers/helpers';
import type { RequestContext, ResponseSender } from '../agents/handlers/router-types';
import { backendTagForSetting, isGrantedForBackend } from '../policy/backend-grant';

// =============================================================================
// Types
// =============================================================================

export interface StreamEvent {
  type: 'token' | 'done' | 'error';
  token?: string;
  finish_reason?: string;
  model?: string;
  /** A number from the bridge; a string when Harbor's policy gate refused the call. */
  error?: { code?: number | string; message: string };
}

/**
 * In-process dispatch doesn't need a real sender identity: Harbor accepts
 * no cross-extension messages, so there is no sender trust check left to
 * satisfy. Callers always pass the verified page origin in the payload
 * (see page-api/background.ts), which is what `gatePageCall`/`requireAction`
 * and `routeAgentMessage` actually check.
 *
 * `id` carries Harbor's own extension id purely so `routeExtensionApiMessage`'s
 * request log line has something to print.
 */
const PAGE_API_SENDER: { id?: string; url?: string; tab?: { id?: number } } = {
  id: browserAPI.runtime?.id,
};

// `llm.*`, `mcp.*`, `session.*`, `system.*` and `permissions.*` go through
// Harbor's extension-api router, gated by gatePageCall/requireAction.
const EXTENSION_API_PREFIXES = ['llm.', 'mcp.', 'session.', 'system.', 'permissions.'];

function isExtensionApiType(type: string): boolean {
  return EXTENSION_API_PREFIXES.some((prefix) => type.startsWith(prefix));
}

function createError(message: string, code?: string): Error & { code?: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = code ?? ErrorCodes.INTERNAL;
  return error;
}

// =============================================================================
// Policy gate for calls the page API serves itself
// =============================================================================

/** The typed actions a page browser or tab call is checked as. */
export type PageBrowserAction = Extract<
  TypedAction,
  `browser.${string}` | `network.egress.${string}`
>;

/**
 * Check a browser or tab call with Harbor's PolicyEngine after the page API
 * has checked the site's grant. The call is audited under the calling
 * origin; a deny, a watchdog restriction or a rule that asks refuses it (a
 * restriction or ask rule prompts first). Returns the refusal, or `null`
 * when the call may proceed.
 */
export function checkPageAction(
  call: { id: string; type: string; origin: string; tabId?: number },
  action: PageBrowserAction,
  resource?: { host?: string },
  options: { pageFetch?: boolean } = {},
): Promise<{ code: string; message: string } | null> {
  return gatePageAction(call, action, resource, options);
}

// =============================================================================
// Request/Response
// =============================================================================

/** Default time limit for a call into the rest of Harbor. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Send a request to the rest of Harbor, in-process. Throws on failure, same
 * contract as the old cross-extension harborRequest, including its time
 * limit: 30 seconds unless the caller asks for longer (a permission prompt
 * waits on the user).
 *
 * `options.signal`, when given, is forwarded to the handler itself (today,
 * only `permissions.request` reads it) rather than racing it here — racing
 * it here would only make *this* call reject early, while the consent
 * prompt it started stayed open and could still grant well after the page
 * gave up. Letting the handler act on the signal means the prompt itself
 * closes, or discards this call's own answer.
 */
export async function harborRequest<T = unknown>(
  type: string,
  payload?: unknown,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  // Aborts when the caller gives up (the page's own request timed out, or
  // an agent.run was cancelled) or when this request times out. Harbor's
  // policy check can wait on a prompt for longer than either; a call given
  // up on by then isn't performed (see routeExtensionApiMessage).
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', onCallerAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    // One signal covers both reasons a caller can give up: its own timeout
    // or request abort (`options.signal`), and this request's own 30s (or
    // longer, for a permission prompt) timer. Passing `controller.signal`
    // on, rather than `options.signal`, means a late prompt answer is
    // discarded here too, not just when the page itself gave up first.
    return await Promise.race([dispatch<T>(type, payload, controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}

async function dispatch<T>(type: string, payload: unknown, signal: AbortSignal): Promise<T> {
  if (isExtensionApiType(type)) {
    const response = await routeExtensionApiMessage({ type, payload }, PAGE_API_SENDER, { signal });
    if (!response.ok) throw createError(response.error ?? 'Unknown error from Harbor', response.code);
    return response.result as T;
  }

  // agent.chat.*, agent.mcp.* and agents.* — the agent router's in-process
  // entry. routeAgentMessage only reads payload.origin/tabId, which
  // background.ts always sets from the connecting port's sender, and
  // rejects a call with no origin.
  return new Promise<T>((resolve, reject) => {
    routeAgentMessage(
      { type, payload },
      (response: { ok: boolean; result?: unknown; error?: string; code?: string }) => {
        if (response.ok) resolve(response.result as T);
        else reject(createError(response.error ?? 'Unknown error from Harbor', response.code));
      },
      { signal },
    );
  });
}

/**
 * Create a streaming request to the rest of Harbor. Only `llm.chatStream`
 * streams today. `requestId`, when given, becomes the audit record's
 * correlationId — pass the page's own request id for a readable activity
 * feed.
 */
export function harborStreamRequest(
  type: string,
  payload?: unknown,
  requestId?: string,
  signal?: AbortSignal,
): { stream: AsyncIterable<StreamEvent>; cancel: () => void } {
  if (type !== 'llm.chatStream') {
    throw createError(`harborStreamRequest: unsupported streaming type "${type}"`);
  }

  // Aborts on cancel() or the caller's signal, so a prompt the page stopped
  // waiting for during Harbor's policy check never reaches the model.
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onCallerAbort, { once: true });
  const release = () => signal?.removeEventListener('abort', onCallerAbort);

  const inner = streamLlmChat(payload, requestId, controller.signal);
  async function* tracked(): AsyncGenerator<StreamEvent> {
    try {
      yield* inner as AsyncGenerator<StreamEvent>;
    } finally {
      release();
    }
  }
  const generator = tracked();
  const stream: AsyncIterable<StreamEvent> = {
    [Symbol.asyncIterator]() {
      return generator;
    },
  };
  const cancel = () => {
    controller.abort();
    release();
    void generator.return(undefined);
  };
  return { stream, cancel };
}

// =============================================================================
// ACP bridge access (for the ACP agent backend — see page-api/acp-backend.ts)
// =============================================================================

/**
 * One event from `acp.open`'s stream, as documented in bridge-rs/README.md
 * "ACP agents": `open` once, carrying the channel and (per the parallel
 * bridge unit) the session's working directory; then one `message` per
 * line the agent's process prints, already parsed as JSON; then `exit`
 * when the process ends. A `fatal` error means the agent never started
 * (no channel exists); any other `error` is a recoverable per-line failure
 * and more `message`/`exit` events can still follow it. `code`, when
 * present, is a machine-readable reason for a fatal error — today only
 * `"agent_cap"`, when the bridge's global 8-agent cap is hit — which the
 * caller matches on instead of `message` (which can name local paths or
 * configuration, and isn't a stable contract).
 */
export type AcpBridgeEvent =
  | { type: 'open'; channel: string; cwd?: string }
  | { type: 'message'; message: unknown }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; fatal?: boolean; code?: string; message: string };

/**
 * Opens a channel to a bridge-configured ACP agent. `workspace` is the
 * site origin the run is for; the bridge/parallel unit turns it into the
 * session's `cwd`, reported back on the `open` event.
 *
 * Unlike `harborStreamRequest`, this has no 30-second timeout: an agent
 * turn can take minutes, so the caller (the ACP backend) owns its own
 * overall run timeout.
 */
export function acpOpenStream(
  agentId: string,
  workspace: string,
): { stream: AsyncGenerator<AcpBridgeEvent>; cancel: () => void } {
  const eventQueue: AcpBridgeEvent[] = [];
  let resolveWaiting: ((event: AcpBridgeEvent | null) => void) | null = null;
  let finished = false;
  let failure: Error | null = null;

  const { cancel, done } = rpcStreamRequest(
    'acp.open',
    { agentId, workspace },
    (event: unknown) => {
      const e = event as AcpBridgeEvent;
      if (resolveWaiting) {
        const resolve = resolveWaiting;
        resolveWaiting = null;
        resolve(e);
      } else {
        eventQueue.push(e);
      }
    },
  );

  done
    .then(() => {
      finished = true;
      resolveWaiting?.(null);
      resolveWaiting = null;
    })
    .catch((e: unknown) => {
      finished = true;
      failure = e instanceof Error ? e : new Error(String(e));
      resolveWaiting?.(null);
      resolveWaiting = null;
    });

  async function* generate(): AsyncGenerator<AcpBridgeEvent> {
    try {
      while (true) {
        if (eventQueue.length > 0) {
          yield eventQueue.shift()!;
          continue;
        }
        if (finished) {
          if (failure) throw failure;
          return;
        }
        const event = await new Promise<AcpBridgeEvent | null>((resolve) => {
          resolveWaiting = resolve;
        });
        if (event === null) {
          if (failure) throw failure;
          return;
        }
        yield event;
      }
    } finally {
      cancel();
    }
  }

  return { stream: generate(), cancel };
}

/** Writes one JSON-RPC message to the agent's stdin via `acp.send`. */
export async function acpSend(channel: string, message: unknown): Promise<void> {
  await rpcRequest('acp.send', { channel, message });
}

/**
 * Kills the agent process. Best-effort from the caller's point of view —
 * the ACP backend calls this on every exit path and doesn't let a failure
 * here mask the run's real outcome.
 */
export async function acpClose(channel: string): Promise<void> {
  await rpcRequest('acp.close', { channel });
}

// =============================================================================
// model.prompt.agent — the policy gate for a prompt sent to the person's
// own ACP agent (see page-api/acp-backend.ts and page-api/acp-text-session.ts)
// =============================================================================

/**
 * Runs the typed-action policy gate for one prompt about to be sent to the
 * person's own ACP agent (`model.prompt.agent`) — the same `requireAction`
 * path page calls go through (`extension-api.ts`'s `gatePageCall`), so the
 * decision reaches the rule engine and the audit log exactly as a prompt to
 * Harbor's own model does. Called once per `agent.run` and once per prompt
 * on an ACP-backed `window.ai` text session, right before `session/prompt`
 * — in addition to, not instead of, the `model:prompt` origin-grant check
 * both already do (`hasPermission`): that's Harbor's own consent store,
 * this is the policy engine's rule evaluation and audit trail.
 *
 * Returns only a boolean: whatever response `requireAction` would have sent
 * back to a page is discarded (the `sender` below is a no-op), since the
 * caller here always reports a plain `ERR_PERMISSION_DENIED` on `false` —
 * the same wording the pre-existing origin-grant check already uses — not
 * the policy engine's own error code for whichever tier actually denied it.
 *
 * `upstreamConsent: 'origin-grant'` means a site that already holds
 * `model:prompt` proceeds without a second native popup when the engine
 * would otherwise ask or preview for this action — the same deal a page's
 * own `llm.chat`/`session.create` calls get through `gatePageCall`.
 */
export async function requireAgentPromptAction(origin: string, tabId?: number): Promise<boolean> {
  const ctx: RequestContext = {
    id: crypto.randomUUID(),
    // `requireAction` never branches on `ctx.type` (only `ctx.id`/`ctx.origin`/
    // `ctx.tabId` reach the policy request and the audit record) — the
    // transport-level `agent.run`/`session.promptStreaming` types this is
    // called from aren't part of this `MessageType` union at all (it's the
    // agent-router's own type, distinct from extension-api.ts's), so this
    // names the closest real member rather than widening the type for one
    // synthetic ctx.
    type: 'session.prompt',
    payload: {},
    origin,
    tabId,
  };
  const sender: ResponseSender = { sendResponse: () => {}, sendStreamEvent: () => {} };
  return requireAction(ctx, sender, 'model.prompt.agent', { upstreamConsent: 'origin-grant' });
}

/**
 * Whether `origin` holds a live `model:prompt` grant recorded for the ACP
 * agent `agentId` specifically — never a live read of whatever backend is
 * currently selected. acp-text-session.ts's own `agentId` is fixed for
 * the session's whole life, so its per-turn check needs this instead of
 * `requireAgentPromptAction`'s live-selection check, which a long-lived
 * session can outlive (defence in depth: the primary fix for the same gap
 * is destroying every live ACP text session on a backend switch, in
 * page-api/background.ts).
 */
export async function isModelPromptGrantedForAgent(
  origin: string,
  agentId: string,
  tabId?: number,
): Promise<boolean> {
  return isGrantedForBackend(origin, 'model:prompt', backendTagForSetting({ type: 'acp', agentId }), tabId);
}

/**
 * The page in a tab has gone (it navigated, reloaded or closed): forget the
 * agents it registered, so nothing more is delivered to that tab for them.
 */
export function forgetAgentsInTab(tabId: number, registeredBefore?: number): void {
  forgetTabAgents(tabId, registeredBefore);
}

// =============================================================================
// Site-registered MCP servers (mcp/site-servers.ts) — per-tab lifetime
// =============================================================================

/**
 * The tab closed, or its page went away outright: disconnect and forget
 * every MCP server that tab's page registered (`window.agent.mcp.register`).
 */
export function forgetSiteServersInTab(tabId: number): void {
  forgetTabServers(tabId);
}

/**
 * The tab navigated to `url`. A site's registered MCP servers are dropped
 * once the tab's new URL no longer shares their origin — a same-document
 * URL change (a hash, or `pushState`) that keeps the same origin is a
 * no-op, same as `webNavigation`-based cleanup elsewhere treats it.
 */
export function forgetSiteServersOnNavigation(tabId: number, url: string): void {
  forgetTabServersIfOriginChanged(tabId, url);
}

/**
 * The origin/tab's site-registered MCP servers, as candidates for
 * `page-api/acp-connection.ts`'s `initializeAcpSession` to offer the
 * person's own ACP agent in `session/new` (filtered there by what the
 * agent's `initialize` response says it can actually use).
 */
export function listSiteServersForAcp(origin: string, tabId?: number): SiteMcpServerDescriptor[] {
  if (tabId === undefined) return [];
  return listSiteServersForAcpImpl(origin, tabId);
}
