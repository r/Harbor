/**
 * Harbor Page API - Background wiring
 *
 * Serves window.ai / window.agent / navigator.modelContext requests from the
 * page-api content script, in-process: llm.*, mcp.*, session.*,
 * permissions.* and system.* calls go through harbor-core.ts to Harbor's own
 * extension-api router, so gatePageCall/requireAction run exactly as they do
 * for a call forwarded from the (now retired) Web Agents API extension.
 *
 * The page's origin always comes from the connecting port's `sender` (its
 * URL in Firefox, its `origin` in Chrome) — never from the message, which a
 * page or a compromised content script could otherwise forge.
 */
import {
  harborRequest,
  harborStreamRequest,
  forgetAgentsInTab,
  forgetSiteServersInTab,
  forgetSiteServersOnNavigation,
} from './harbor-core';
import { policyRefusalCode } from './policy-refusal';
import { featureRefusal, getFeatureFlags } from './policy/feature-flags';
import { type AgentBackend } from './agent-backend';
import { selectAgentBackend } from './agent-backend-selection';
import { AcpAgentBackend, combineAbortSignals } from './acp-backend';
import { acpBackendChangeSignal, invalidateAcpBackendGeneration } from './acp-backend-generation';
import { AGENT_BACKEND_STORAGE_KEY } from './agent-backend-setting';
import {
  isAcpTextSession,
  promptStreamingAcpTextSession,
  cleanupAcpTextSessionsForTab,
  destroyAllAcpTextSessions,
} from './acp-text-session';
import type { TransportStreamEvent } from './types';

import {
  routeMessage,
  type RequestContext,
  // Permission utilities
  hasPermission,
  getPermissions,
  // AI utilities
  resolveTextSession,
  recordExplicitPrompt,
  forgetTextSession,
  // Tab utilities
  restoreSpawnedTabs,
  handleTabRemoved,
  getAllSpawnedTabs,
  // Agent utilities
  cleanupAgentsForTab,
  resolveInvocationResponse,
} from './handlers';
import { browserAPI } from '../browser-compat';

const PORT_NAME = 'harbor-page-api';

function log(...args: unknown[]): void {
  console.log('[Harbor PageAPI]', ...args);
}

/**
 * The page's origin, derived from the connecting port's sender — never from
 * the message a page sent, which could claim to be any origin.
 */
function originFromSender(sender: chrome.runtime.Port['sender']): string {
  const raw = sender?.url ?? (sender as unknown as { origin?: string } | undefined)?.origin;
  if (!raw) return '';
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
}

// =============================================================================
// Streaming Handlers (kept here for port access)
// =============================================================================

async function handleSessionPromptStreaming(
  ctx: RequestContext,
  sendEvent: (event: TransportStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const { sessionId, input } = ctx.payload as { sessionId: string; input: string };

  const resolved = await resolveTextSession(sessionId, ctx.origin, ctx.tabId);
  if (!('session' in resolved)) {
    sendEvent({ id: ctx.id, event: { type: 'error', error: { code: resolved.code, message: resolved.message } }, done: true });
    return;
  }
  const { session } = resolved;

  if (isAcpTextSession(sessionId)) {
    try {
      // `signal` aborts when the page breaks its for-await loop
      // (injected.ts's createStreamIterable.return(), relayed as
      // {type:'abort', id} on the port) or the port disconnects — either
      // way this turn gets `session/cancel`, not left running.
      const result = await promptStreamingAcpTextSession(sessionId, input, (chunk) => {
        sendEvent({ id: ctx.id, event: { type: 'token', token: chunk } });
      }, signal);
      if (result.ok) {
        sendEvent({ id: ctx.id, event: { type: 'done' }, done: true });
      } else {
        sendEvent({ id: ctx.id, event: result.error, done: true });
      }
    } catch (e) {
      sendEvent({
        id: ctx.id,
        event: { type: 'error', error: { code: 'ERR_AGENT_FAILED', message: e instanceof Error ? e.message : 'Agent run failed' } },
        done: true,
      });
    }
    return;
  }

  try {
    session.history.push({ role: 'user', content: input });

    const messages: Array<{ role: string; content: string }> = [];
    if (session.options.systemPrompt) {
      messages.push({ role: 'system', content: session.options.systemPrompt as string });
    }
    messages.push(...session.history);

    const { stream } = harborStreamRequest('llm.chatStream', {
      origin: ctx.origin,
      tabId: ctx.tabId,
      messages,
      model: session.options.model,
      temperature: session.options.temperature,
    }, ctx.id, signal);

    let fullContent = '';

    for await (const event of stream) {
      if (event.type === 'token' && event.token) {
        fullContent += event.token;
        sendEvent({ id: ctx.id, event: { type: 'token', token: event.token } });
      } else if (event.type === 'done') {
        session.history.push({ role: 'assistant', content: fullContent });
        recordExplicitPrompt(session, input, fullContent);
        sendEvent({ id: ctx.id, event: { type: 'done' }, done: true });
        break;
      } else if (event.type === 'error') {
        sendEvent({
          id: ctx.id,
          event: {
            type: 'error',
            error: { code: policyRefusalCode(event.error) ?? 'ERR_MODEL_FAILED', message: event.error?.message || 'Stream error' },
          },
          done: true,
        });
        break;
      }
    }
  } catch (e) {
    sendEvent({
      id: ctx.id,
      event: { type: 'error', error: { code: policyRefusalCode(e) ?? 'ERR_MODEL_FAILED', message: e instanceof Error ? e.message : 'Streaming failed' } },
      done: true,
    });
  }
}

async function handleAgentRun(
  ctx: RequestContext,
  sendEvent: (event: TransportStreamEvent) => void,
  signal: AbortSignal,
  backendOverride?: AgentBackend,
): Promise<void> {
  const { task, maxToolCalls = 5, systemPrompt } = ctx.payload as {
    task: string;
    maxToolCalls?: number;
    systemPrompt?: string;
  };

  log('agent.run starting:', { taskLength: task?.length ?? 0, maxToolCalls, origin: ctx.origin });

  // Enforce the setting at the receiver: a page can send transport messages
  // directly, without going through the injected API's disabled wrapper.
  // This, the grant checks below, tool listing/filtering and delivering
  // events to the page apply to every backend, so they stay here rather
  // than in the backend itself.
  const refusal = featureRefusal(ctx.type, await getFeatureFlags());
  if (refusal) {
    sendEvent({ id: ctx.id, event: { type: 'error', error: refusal }, done: true });
    return;
  }

  for (const scope of ['model:prompt', 'model:tools'] as const) {
    if (!await hasPermission(ctx.origin, scope, ctx.tabId)) {
      sendEvent({
        id: ctx.id,
        event: { type: 'error', error: { code: 'ERR_PERMISSION_DENIED', message: `Permission ${scope} required` } },
        done: true,
      });
      return;
    }
  }

  try {
    // Get available tools
    let tools: Array<{ serverId: string; name: string; description?: string; inputSchema?: unknown }> = [];

    if (await hasPermission(ctx.origin, 'mcp:tools.list', ctx.tabId)) {
      const toolsResult = await harborRequest<{ tools: typeof tools }>('mcp.listTools', {
        origin: ctx.origin,
        tabId: ctx.tabId,
      }, { signal });
      tools = toolsResult.tools || [];

      // Offer only the tools the site was granted. No allowlist means no tools.
      const permissions = await getPermissions(ctx.origin, ctx.tabId);
      tools = tools.filter(t =>
        permissions.allowedTools.includes(t.name) ||
        permissions.allowedTools.includes(`${t.serverId}/${t.name}`)
      );
    }

    // Captured *before* reading the backend selection, not after — a
    // switch landing in the gap while `selectAgentBackend()`'s own storage
    // read is still in flight invalidates the generation this signal
    // belongs to, same as one landing any time later. Capturing it after
    // the read instead would miss exactly that race: `backend` could
    // still resolve to the (now stale) agent that switch just replaced,
    // paired with a *new*, not-yet-aborted generation's signal, so the run
    // would never be told the agent it just picked is already gone.
    const backendChangeSignal = acpBackendChangeSignal();
    const backend = backendOverride ?? await selectAgentBackend();
    // An ACP-backed run also ends if the person switches
    // `harbor_agent_backend` while it's still going on the old agent — not
    // just on the page's own abort/tab-close — by combining in the shared
    // generation signal (acp-backend-generation.ts), which a storage
    // change below aborts. The built-in backend doesn't need this: there's
    // no "old agent" for it to keep running on.
    const runSignal = backend instanceof AcpAgentBackend
      ? combineAbortSignals([signal, backendChangeSignal])
      : signal;
    await backend.run(
      { origin: ctx.origin, tabId: ctx.tabId, task, systemPrompt, maxToolCalls, tools },
      (event) => sendEvent({ id: ctx.id, event, done: event.type === 'done' || event.type === 'error' }),
      runSignal,
    );
  } catch (e) {
    sendEvent({
      id: ctx.id,
      event: { type: 'error', error: { code: policyRefusalCode(e) ?? 'ERR_AGENT_FAILED', message: e instanceof Error ? e.message : 'Agent run failed' } },
      done: true,
    });
  }
}

// =============================================================================
// Initialization
// =============================================================================

let initialized = false;

/**
 * Wire up the page API's background listeners. Called once from Harbor's
 * main background.ts entry point, alongside initializeExtensionApi() and
 * initializeRouter().
 */
export function initializePageApi(): void {
  if (initialized) return;
  initialized = true;

  log('Initializing...');

  // Restore tracked spawned tabs from storage.
  restoreSpawnedTabs();

  // Switching `harbor_agent_backend` ends work still running on the old
  // agent, not just changes what the *next* call uses: every live
  // ACP-backed window.ai text session is destroyed (a later prompt on one
  // gets the same "session not found" a destroy always produces), and
  // every in-flight ACP agent.run is cancelled with ERR_AGENT_FAILED /
  // "The agent was changed." (acp-backend-generation.ts, combined into
  // each such run's signal above). `storage.onChanged` fires for *any*
  // write to the key, including one that re-selects the same agent, or
  // clears back to the built-in model — all treated the same way, since
  // there's no cheap way to tell "really changed" from "written again"
  // apart, and erring toward ending old work is the safe side.
  // Guarded like policy/store.ts's own storage.onChanged listener: some
  // test harnesses (and, in principle, a browser target) stub a `chrome`
  // with no `storage.onChanged` at all.
  if (browserAPI.storage?.onChanged) {
    browserAPI.storage.onChanged.addListener((changes: Record<string, unknown>, area: string) => {
      if (area !== 'local' || !(AGENT_BACKEND_STORAGE_KEY in changes)) return;
      invalidateAcpBackendGeneration();
      void destroyAllAcpTextSessions(forgetTextSession);
    });
  }

  // Clean up spawned tabs when they are closed.
  browserAPI.tabs.onRemoved.addListener(async (tabId: number) => {
    const wasTracked = Object.values(getAllSpawnedTabs()).some(tabs => tabs.includes(tabId));

    if (wasTracked) {
      try {
        await browserAPI.tabs.get(tabId);
        // Tab still exists - spurious event
        return;
      } catch {
        // Tab is truly gone
      }
    }

    handleTabRemoved(tabId);
    cleanupAgentsForTab(tabId);
    // Cancels any turn in progress and kills the agent process for every
    // ACP-backed window.ai text session this tab opened — a no-op when it
    // opened none.
    await cleanupAcpTextSessionsForTab(tabId, forgetTextSession);
    // Disconnects and forgets every MCP server this tab's page registered
    // (window.agent.mcp.register) — a no-op when it registered none.
    forgetSiteServersInTab(tabId);
  });

  // A tab's registered MCP servers belong to the page that registered
  // them; once that tab's URL no longer shares that page's origin (a real
  // navigation, not a same-document hash/pushState change), they're
  // dropped too — tabs.onRemoved above is the backstop for the tab closing
  // outright.
  browserAPI.tabs.onUpdated?.addListener((tabId: number, changeInfo: { url?: string }) => {
    if (changeInfo.url) forgetSiteServersOnNavigation(tabId, changeInfo.url);
  });

  // Port connection handler: the page-facing transport.
  // Each page connection, numbered, and the latest one in each tab with when
  // it connected: a reloaded page's old connection can close after the new one opens.
  let pageConnections = 0;
  const latestTabConnection = new Map<number, { connection: number; at: number }>();

  browserAPI.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
    if (port.name !== PORT_NAME) return;

    const origin = originFromSender(port.sender);
    const tabId = port.sender?.tab?.id;
    // Which page connection this is, in its tab (see the disconnect below).
    const connection = ++pageConnections;
    if (tabId !== undefined) latestTabConnection.set(tabId, { connection, at: Date.now() });
    const cookieStoreId = (port.sender?.tab as (chrome.tabs.Tab & { cookieStoreId?: string }) | undefined)?.cookieStoreId;

    // One AbortController per in-flight request on this port, keyed by
    // request id — not just agent.run/session.promptStreaming: a page's own
    // client-side request timeout (injected.ts) now also posts
    // {type:'abort', id} for ai.createTextSession and session.prompt, on
    // the ACP backend, so the agent starting or a turn running doesn't
    // outlive a page that's already given up waiting. The content script
    // also posts {type:'abort', id} when the page breaks a streaming
    // for-await loop (injected.ts's createStreamIterable.return()); the
    // port disconnecting (tab closed or navigated) aborts every request
    // still in flight on it.
    const runControllers = new Map<string, AbortController>();

    port.onMessage.addListener(async (message: { id: string; type: string; payload: unknown }) => {
      if (message?.type === 'abort') {
        // The id crosses the page/extension boundary, so it's validated
        // here rather than trusted as the declared type.
        if (typeof message.id !== 'string') return;
        runControllers.get(message.id)?.abort();
        return;
      }

      const controller = new AbortController();
      runControllers.set(message.id, controller);

      const ctx: RequestContext = {
        id: message.id,
        type: message.type,
        payload: message.payload,
        // The origin always comes from the port's sender, established once
        // when the port connected — never from a per-message field, which a
        // page (or a compromised content script) could otherwise forge.
        origin,
        tabId,
        cookieStoreId,
        signal: controller.signal,
      };

      try {
        if (ctx.type === 'session.promptStreaming') {
          const sendEvent = (event: TransportStreamEvent) => {
            try { port.postMessage(event); } catch { /* Port disconnected */ }
          };
          await handleSessionPromptStreaming(ctx, sendEvent, controller.signal);
          return;
        }

        if (ctx.type === 'agent.run') {
          const sendEvent = (event: TransportStreamEvent) => {
            try { port.postMessage(event); } catch { /* Port disconnected */ }
          };
          await handleAgentRun(ctx, sendEvent, controller.signal);
          return;
        }

        const response = await routeMessage(ctx);
        try {
          port.postMessage(response);
        } catch {
          /* Port disconnected */
        }
      } finally {
        // A page may reuse an id; only remove the controller this call added.
        if (runControllers.get(message.id) === controller) runControllers.delete(message.id);
      }
    });

    port.onDisconnect?.addListener(() => {
      for (const controller of runControllers.values()) controller.abort();
      runControllers.clear();
      // The page navigated or reloaded (a new port connects for the new
      // page) or the tab closed outright — either way, every ACP-backed
      // text session this port's page opened must end, not just the ones
      // tabs.onRemoved also catches: a same-tab navigation disconnects this
      // port without ever firing tabs.onRemoved.
      if (tabId !== undefined) void cleanupAcpTextSessionsForTab(tabId, forgetTextSession);
      // The page's agents go with it, so nothing more is delivered to this
      // tab for them once it shows another page. Only the top frame runs the
      // page API.
      if (tabId !== undefined && (port.sender?.frameId ?? 0) === 0) {
        // If a newer page in this tab has connected already, spare the
        // agents it registered: only this page's agents go.
        const latest = latestTabConnection.get(tabId);
        const newerPageSince = latest && latest.connection !== connection ? latest.at : undefined;
        if (newerPageSince === undefined) latestTabConnection.delete(tabId);
        forgetAgentsInTab(tabId, newerPageSince);
      }
    });
  });

  // The content script asks for feature flags before injecting the page API.
  browserAPI.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
    if (message?.type === 'getFeatureFlags') {
      getFeatureFlags().then(flags => sendResponse(flags));
      return true;
    }
    return false;
  });

  // A tab's content script relaying the page's answer to an invocation it
  // was asked to handle (see content-script.ts's `agentInvocationResponse`
  // forwarding). Every tab's content script now shares this one extension,
  // so this is checked carefully before resolving anything:
  //  - only Harbor's own content script may answer (never a page directly,
  //    and never another extension);
  //  - only the tab the invocation was actually sent to may answer, and
  //    only from that tab's top frame — resolveInvocationResponse() enforces
  //    the tab match, and content-script.ts only runs in the top frame
  //    (manifest.json's `all_frames: false`), so frameId is always 0 there.
  browserAPI.runtime.onMessage.addListener(
    (
      message: { type?: string; response?: Parameters<typeof resolveInvocationResponse>[0] },
      sender: chrome.runtime.MessageSender,
      _sendResponse: (response?: unknown) => void,
    ) => {
      if (message?.type !== 'agentInvocationResponse') return false;

      if (sender.id !== browserAPI.runtime.id || !sender.tab) {
        log('Ignoring agentInvocationResponse: not from Harbor\'s own content script', sender.id);
        return false;
      }
      if (sender.frameId !== undefined && sender.frameId !== 0) {
        log('Ignoring agentInvocationResponse: not the top frame', sender.frameId);
        return false;
      }
      if (!message.response) return false;

      const resolved = resolveInvocationResponse(message.response, sender.tab.id!);
      if (!resolved) {
        log('agentInvocationResponse did not match a pending invocation for this tab:', message.response.invocationId, sender.tab.id);
      }
      return false;
    },
  );

  log('Initialized.');
}
