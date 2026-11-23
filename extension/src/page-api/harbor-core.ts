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
import { callSiteTool, forgetTabServers, forgetTabServersIfOriginChanged, isSiteServerId, listSiteTools, type SiteMcpServerDescriptor } from '../mcp/site-servers';
// The page's own tools (document.modelContext), relayed to its port: see
// docs/PAGE_TOOLS_FOR_AGENTS.md.
export {
  syncPageTools,
  resolvePageToolResult,
  forgetPageToolsForConnection,
  forgetPageToolsInTab,
  type PageToolDescriptor,
} from '../mcp/page-tools';
export type { SiteMcpServerDescriptor } from '../mcp/site-servers';
import { listPageTools, callPageTool, pageToolServerId, type PageToolDescriptor as PageToolDescriptorImpl } from '../mcp/page-tools';
import { rpcRequest, rpcStreamRequest } from '../llm/native-bridge';
import { browserAPI } from '../browser-compat';
import { ErrorCodes } from './types';
import { checkAction, requireAction } from '../agents/handlers/helpers';
import type { RequestContext, ResponseSender } from '../agents/handlers/router-types';
import { backendTagForSetting, isGrantedForBackend } from '../policy/backend-grant';
import { SessionRegistry } from '../sessions';
import { LabelFlow } from '../policy/label-flow';
export type { LabelFlow } from '../policy/label-flow';

/** Internal ownership of one run's or session's information flow. */
export function createLabelFlow(): LabelFlow {
  return new LabelFlow();
}

export function getSessionLabelFlow(sessionId: string, origin: string): LabelFlow {
  return SessionRegistry.getLabelFlow(sessionId, origin);
}

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
  options: { pageFetch?: boolean; labelFlow?: LabelFlow } = {},
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
  options: { timeoutMs?: number; signal?: AbortSignal; labelFlow?: LabelFlow } = {},
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
    return await Promise.race([dispatch<T>(type, payload, controller.signal, options.labelFlow), timeout]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}

async function dispatch<T>(type: string, payload: unknown, signal: AbortSignal, labelFlow?: LabelFlow): Promise<T> {
  if (isExtensionApiType(type)) {
    const response = await routeExtensionApiMessage({ type, payload }, PAGE_API_SENDER, { signal, labelFlow });
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
  labelFlow?: LabelFlow,
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

  const inner = streamLlmChat(payload, requestId, controller.signal, labelFlow);
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
export async function checkAgentPromptAction(origin: string, tabId?: number, labelFlow?: LabelFlow): Promise<{ code: string; message: string } | null> {
  return checkAction(pageToolPolicyContext(origin, tabId), 'model.prompt.agent', { upstreamConsent: 'origin-grant', labelFlow });
}

export async function requireAgentPromptAction(origin: string, tabId?: number, labelFlow?: LabelFlow): Promise<boolean> {
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
  return requireAction(ctx, sender, 'model.prompt.agent', { upstreamConsent: 'origin-grant', labelFlow });
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
 * Calls `listener` whenever Harbor ends an `agent.sessions` session on its
 * own: it expired, was dropped for inactivity, or was terminated. The page
 * API uses this to end the agent process behind a session that has one.
 */
export function onHarborSessionEnded(listener: (sessionId: string, origin: string) => void): () => void {
  return SessionRegistry.subscribe((event) => {
    if (event.type === 'session_terminated') listener(event.sessionId, event.origin);
  });
}

// =============================================================================
// The page's own tools, for the person's agent
// =============================================================================

/**
 * A synthetic request context for a policy check made on the page's behalf
 * during agent work it started. `requireAction` only reads id/origin/tabId.
 */
function pageToolPolicyContext(origin: string, tabId: number | undefined, signal?: AbortSignal): RequestContext {
  return { id: crypto.randomUUID(), type: 'session.prompt', payload: {}, origin, tabId, signal };
}

/**
 * The calling tab's page tools (document.modelContext), for agent work that
 * page started, or null when it has none or policy refuses `tool.list` for
 * its `page:<host>` server. Needs no grant of its own: the grant that started
 * the run or chat covers it (docs/PAGE_TOOLS_FOR_AGENTS.md §2). The check is
 * recorded in the audit log either way; a rule that asks is a refusal here,
 * since there's no one-off prompt for page tools.
 */
export async function pageToolsForAgent(
  origin: string,
  tabId: number | undefined,
): Promise<{ serverId: string; generation: number; tools: PageToolDescriptorImpl[] } | null> {
  if (tabId === undefined) return null;
  const listing = listPageTools(tabId, origin);
  if (!listing) return null;
  if (!(await policyAllowsPageToolList(origin, tabId))) return null;
  return { serverId: pageToolServerId(origin), ...listing };
}

/**
 * The `tool.list` policy check for a page's own tools (`page:<host>`), with no
 * prompt: a rule that asks refuses. Recorded in the audit log either way.
 */
export async function policyAllowsPageToolList(origin: string, tabId: number): Promise<boolean> {
  const denial = await checkAction(pageToolPolicyContext(origin, tabId), 'tool.list', {
    upstreamConsent: 'origin-grant',
    noPrompt: true,
    resource: { server: pageToolServerId(origin) },
  });
  return denial === null;
}

/** The tab's current page tools, if the page there is `origin`'s (mcp/page-tools.ts). */
export function listPageToolsForTab(tabId: number, origin: string) {
  return listPageTools(tabId, origin);
}

/**
 * Call one of the calling tab's page tools for agent work that page started:
 * policy-checks `tool.call` for `page:<host>` and that tool (recorded in the
 * audit log), then runs the page's handler. Rejects with the refusal's code,
 * or `ERR_TOOL_FAILED` (see mcp/page-tools.ts's callPageTool).
 */
export async function callPageToolForAgent(call: {
  origin: string;
  tabId: number | undefined;
  generation: number;
  name: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
  labelFlow?: LabelFlow;
  /** Called once the policy check has allowed the call, before it runs. */
  onAllowed?: () => void;
}): Promise<unknown> {
  if (call.tabId === undefined) {
    throw Object.assign(new Error('This page tool has no tab'), { code: 'ERR_TOOL_FAILED' });
  }
  const serverId = pageToolServerId(call.origin);
  const denial = await checkAction(pageToolPolicyContext(call.origin, call.tabId, call.signal), 'tool.call', {
    upstreamConsent: 'origin-grant',
    noPrompt: true,
    resource: { server: serverId, tool: call.name },
    labelFlow: call.labelFlow,
  });
  if (denial) throw Object.assign(new Error(denial.message), { code: denial.code });
  call.onAllowed?.();
  const listing = listPageTools(call.tabId, call.origin);
  const offered = listing?.generation === call.generation
    && listing.tools.some(tool => tool.name === call.name) && !call.signal?.aborted;
  try {
    return await callPageTool({
      tabId: call.tabId,
      origin: call.origin,
      generation: call.generation,
      name: call.name,
      input: call.input,
      signal: call.signal,
    });
  } finally {
    // A stale/missing tool never returned page content. Actual handler
    // failures can carry page-authored error text and keep the source labels.
    if (offered) call.labelFlow?.addPageOutput(call.origin);
  }
}

// =============================================================================
// The bridge's page-tools MCP endpoint, for the person's ACP agent
// =============================================================================

interface PageToolEndpoint {
  origin: string;
  tabId: number;
  /** The page generation the session started under: a reload ends its tools. */
  generation: number;
  /** An agent.run's tool budget; absent for a page chat. */
  maxCalls?: number;
  calls: number;
  labelFlow?: LabelFlow;
  /** Endpoint tool name → the site server tool it stands for, from the last listing. */
  siteNames?: Map<string, { serverId: string; tool: string }>;
}

const pageToolEndpoints = new Map<string, PageToolEndpoint>();

/**
 * Opens a bridge-hosted MCP endpoint serving the calling tab's page tools to
 * one ACP session, and returns it in the form `session/new` takes a site
 * server in (`acp-connection.ts`'s `mcpServersForAgent`). Null — nothing
 * opened — when the page has no tools, policy refuses them
 * (`pageToolsForAgent`), or the bridge can't open one. The caller closes it
 * with `closePageToolEndpoint` when the session ends.
 */
export async function openPageToolEndpointForAcp(
  origin: string,
  tabId: number | undefined,
  options: { maxCalls?: number; labelFlow?: LabelFlow } = {},
): Promise<(SiteMcpServerDescriptor & { endpointId: string }) | null> {
  if (tabId === undefined) return null;
  const listing = await pageToolsForAgent(origin, tabId);
  const siteTools = await siteToolsForAgent(origin, tabId);
  if (!listing && siteTools.length === 0) return null;
  let opened: { endpointId?: unknown; url?: unknown };
  try {
    opened = await rpcRequest<{ endpointId?: unknown; url?: unknown }>('page_tools.open', {});
  } catch {
    console.log('[Harbor] Could not open a page tools endpoint on the bridge');
    return null;
  }
  const { endpointId, url } = opened ?? {};
  // The URL goes straight into the agent's session/new, so it must be the
  // bridge's own loopback listener and nothing else.
  if (typeof endpointId !== 'string' || typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]+$/.test(url)) {
    console.log('[Harbor] The bridge returned an unexpected page tools endpoint');
    if (typeof endpointId === 'string') await rpcRequest('page_tools.close', { endpointId }).catch(() => {});
    return null;
  }
  pageToolEndpoints.set(endpointId, { origin, tabId, generation: listing?.generation ?? -1, maxCalls: options.maxCalls, calls: 0, labelFlow: options.labelFlow });
  // One MCP server for everything the site offers, named by its host: the
  // page's own tools under their names, its registered servers' tools as
  // `<server>__<tool>` (see siteToolEndpointName).
  return { serverId: pageToolServerId(origin), name: hostOf(origin), url, transport: 'streamable-http', endpointId };
}

/** Closes an endpoint opened by `openPageToolEndpointForAcp`. Idempotent. */
export async function closePageToolEndpoint(endpointId: string): Promise<void> {
  if (!pageToolEndpoints.delete(endpointId)) return;
  await rpcRequest('page_tools.close', { endpointId }).catch(() => { /* best-effort; the bridge's exit closes it too */ });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pageToolErrorResult(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** A page tool's result as an MCP CallToolResult. It is untrusted page content, passed on as data only. */
function pageToolCallResult(result: unknown) {
  if (typeof result === 'string') return { content: [{ type: 'text', text: result }] };
  let text: string;
  try {
    text = result === undefined ? '' : JSON.stringify(result);
  } catch {
    return pageToolErrorResult("The page tool's result can't be sent");
  }
  return isPlainRecord(result)
    ? { content: [{ type: 'text', text }], structuredContent: result }
    : { content: [{ type: 'text', text }] };
}

/**
 * Answers the bridge's `page_tools.list` / `page_tools.call` host requests for
 * an endpoint this module opened. Always answers with an MCP result, never a
 * thrown error: a page tool's own error text is page content and must not
 * reach native-bridge.ts's failure log.
 */
export async function handlePageToolsHostRequest(method: string, params: unknown): Promise<unknown> {
  const endpointId = isPlainRecord(params) && typeof params.endpointId === 'string' ? params.endpointId : undefined;
  const endpoint = endpointId ? pageToolEndpoints.get(endpointId) : undefined;

  if (method === 'page_tools.list') {
    if (!endpoint) return { tools: [] };
    return { tools: await endpointToolListing(endpoint) };
  }

  if (method === 'page_tools.call') {
    if (!endpoint) return pageToolErrorResult('This page tool is no longer available');
    const name = isPlainRecord(params) && typeof params.name === 'string' ? params.name : '';
    const input = isPlainRecord(params) && isPlainRecord(params.arguments) ? params.arguments : {};
    if (endpoint.maxCalls !== undefined && endpoint.calls >= endpoint.maxCalls) {
      return pageToolErrorResult('Tool call budget exceeded; this call was not run.');
    }
    // Reserved before anything is awaited, so calls the agent sends in
    // parallel can't all pass the check above; given back if policy refuses
    // the call, so a refused call spends no budget.
    endpoint.calls++;
    let allowed = false;
    try {
      // The name map from the agent's last listing; built (and its policy
      // checks audited) only if the agent calls before listing.
      if (!endpoint.siteNames) await endpointToolListing(endpoint);
      const site = endpoint.siteNames?.get(name);
      if (site) {
        const result = await callSiteToolForAgent({
          origin: endpoint.origin,
          tabId: endpoint.tabId,
          serverId: site.serverId,
          name: site.tool,
          input,
          labelFlow: endpoint.labelFlow,
          onAllowed: () => { allowed = true; },
        });
        return acpToolResult(endpoint, withProvenance(siteToolCallResult(result), toolProvenance(endpoint.origin, 'site-server', site.serverId)));
      }
      const result = await callPageToolForAgent({
        origin: endpoint.origin,
        tabId: endpoint.tabId,
        generation: endpoint.generation,
        name,
        input,
        labelFlow: endpoint.labelFlow,
        onAllowed: () => { allowed = true; },
      });
      return acpToolResult(endpoint, withProvenance(pageToolCallResult(result), toolProvenance(endpoint.origin, 'page-tool')));
    } catch (e) {
      if (!allowed) endpoint.calls--;
      return acpToolResult(endpoint, withProvenance(pageToolErrorResult(e instanceof Error && e.message ? e.message : 'Page tool failed'), toolProvenance(endpoint.origin, 'page-tool')));
    }
  }

  return pageToolErrorResult('Unknown page tools request');
}

async function acpToolResult(endpoint: PageToolEndpoint, result: unknown): Promise<unknown> {
  if (endpoint.labelFlow && !endpoint.labelFlow.labels.isEmpty()) {
    const denial = await checkAction(pageToolPolicyContext(endpoint.origin, endpoint.tabId), 'model.prompt.agent', {
      labelFlow: endpoint.labelFlow,
      upstreamConsent: 'origin-grant',
      noPrompt: true,
    });
    if (denial) return pageToolErrorResult(denial.message);
  }
  return result;
}

export function __resetPageToolEndpointsForTests(): void {
  pageToolEndpoints.clear();
}

// =============================================================================
// The site's own MCP server tools, for agent work that site started
// =============================================================================

/**
 * A site's own registered MCP server tools get the same gate as its page
 * tools (docs/PERMISSIONS.md): no grant of their own and no per-tool
 * allowlist, since mcp:tools.list/mcp:tools.call would also open the
 * person's installed servers. Each server's tools are offered only if the
 * policy engine allows `tool.list` for it, with no prompt (a rule that asks
 * refuses). Every check is in the audit log.
 */
export async function siteToolsForAgent(
  origin: string,
  tabId: number | undefined,
): Promise<Array<{ serverId: string; name: string; description?: string; inputSchema?: unknown }>> {
  if (tabId === undefined) return [];
  const tools = listSiteTools(origin, tabId);
  const allowed = new Map<string, boolean>();
  const out: typeof tools = [];
  for (const tool of tools) {
    if (!allowed.has(tool.serverId)) {
      const denial = await checkAction(pageToolPolicyContext(origin, tabId), 'tool.list', {
        upstreamConsent: 'origin-grant',
        noPrompt: true,
        resource: { server: tool.serverId },
      });
      allowed.set(tool.serverId, denial === null);
    }
    if (allowed.get(tool.serverId)) out.push(tool);
  }
  return out;
}

/**
 * Call one of a site's own MCP server tools for agent work that site
 * started: policy-checks `tool.call` for that server and tool (audited, no
 * prompt), then calls the server through Harbor's own connection to it.
 * Rejects with the refusal's code, or `ERR_TOOL_FAILED`.
 */
export async function callSiteToolForAgent(call: {
  origin: string;
  tabId: number | undefined;
  serverId: string;
  name: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
  labelFlow?: LabelFlow;
  /** Called once the policy check has allowed the call, before it runs. */
  onAllowed?: () => void;
}): Promise<unknown> {
  if (call.tabId === undefined || !isSiteServerId(call.serverId)) {
    throw Object.assign(new Error('No such site tool'), { code: 'ERR_TOOL_FAILED' });
  }
  const denial = await checkAction(pageToolPolicyContext(call.origin, call.tabId, call.signal), 'tool.call', {
    upstreamConsent: 'origin-grant',
    noPrompt: true,
    resource: { server: call.serverId, tool: call.name },
    labelFlow: call.labelFlow,
  });
  if (denial) throw Object.assign(new Error(denial.message), { code: denial.code });
  call.onAllowed?.();
  try {
    const result = await callSiteTool(call.origin, call.tabId, call.serverId, call.name, call.input);
    if (!result.ok) throw Object.assign(new Error(result.error), { code: 'ERR_TOOL_FAILED' });
    return result.result;
  } finally {
    call.labelFlow?.addPageOutput(call.origin);
  }
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return 'site';
  }
}

/** `site:<host>:<name>` + tool → `<name>__<tool>`, within MCP's tool-name alphabet. */
function siteToolEndpointName(serverId: string, tool: string): string {
  const serverName = serverId.slice(serverId.lastIndexOf(':') + 1) || 'site';
  return `${serverName}__${tool}`.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
}


// =============================================================================
// Provenance: where a tool came from, in a form the site can't forge
// =============================================================================

/**
 * `_meta` provenance for a tool or tool result Harbor serves, from the
 * browser's own record of the page's origin (never anything the site
 * supplied). The same shape as the `harbor/provenance` Harbor puts on
 * prompts (acp-connection.ts's provenanceMeta); see docs/rfds/provenance.md.
 */
export function toolProvenance(origin: string, source: 'page-tool' | 'site-server', server?: string) {
  return { 'harbor/provenance': { source, origin, ...(server ? { server } : {}) } };
}

/** A site-supplied description, prefixed with the site Harbor knows it came from. */
export function describedBySite(origin: string, description: string | undefined): string {
  const text = (description ?? '').trim();
  return text ? `From ${hostOf(origin)}: ${text}` : `From ${hostOf(origin)}.`;
}

function withProvenance<T extends Record<string, unknown>>(result: T, meta: ReturnType<typeof toolProvenance>): T & { _meta: ReturnType<typeof toolProvenance> } {
  return { ...result, _meta: meta };
}

/** A site server's own result is already an MCP CallToolResult: passed through, not re-wrapped. */
function siteToolCallResult(result: unknown) {
  if (isPlainRecord(result) && Array.isArray(result.content)) {
    const out: Record<string, unknown> = { content: result.content };
    if (isPlainRecord(result.structuredContent)) out.structuredContent = result.structuredContent;
    if (result.isError === true) out.isError = true;
    return out;
  }
  return pageToolCallResult(result);
}

/**
 * Everything the endpoint offers the agent: the page's own tools under their
 * names, then the site's registered servers' tools as `<server>__<tool>`. A
 * name already taken (by a page tool, or by another of the same page's
 * servers) gets a numbered suffix, so every name maps to exactly one tool.
 * The name map is kept on the endpoint for calls.
 */
async function endpointToolListing(endpoint: PageToolEndpoint) {
  const listing = listPageTools(endpoint.tabId, endpoint.origin);
  const pageTools = listing && listing.generation === endpoint.generation ? listing.tools : [];
  const taken = new Set(pageTools.map((t) => t.name));
  const siteNames = new Map<string, { serverId: string; tool: string }>();
  const siteEntries = [];
  for (const t of await siteToolsForAgent(endpoint.origin, endpoint.tabId)) {
    const base = siteToolEndpointName(t.serverId, t.name);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 120)}_${n}`;
    taken.add(name);
    siteNames.set(name, { serverId: t.serverId, tool: t.name });
    siteEntries.push({
      name,
      description: describedBySite(endpoint.origin, t.description),
      inputSchema: (t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object' }) as Record<string, unknown>,
      _meta: toolProvenance(endpoint.origin, 'site-server', t.serverId),
    });
  }
  endpoint.siteNames = siteNames;
  return [
    ...pageTools.map((t) => ({
      name: t.name,
      description: describedBySite(endpoint.origin, t.description),
      inputSchema: t.inputSchema,
      _meta: toolProvenance(endpoint.origin, 'page-tool'),
    })),
    ...siteEntries,
  ];
}
