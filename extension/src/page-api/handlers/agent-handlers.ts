/**
 * Multi-Agent Handlers
 * 
 * Handles agent registration, discovery, invocation, and orchestration.
 */

import { harborRequest, invocationTimeoutMs } from '../harbor-core';
import type { AgentListEntry } from '../types';
import type { RequestContext, HandlerResponse } from './types';
import { errorResponse, successResponse } from './types';
import { latestPage } from '../tab-pages';

/**
 * A failed Harbor call, reported with Harbor's own code (ERR_PERMISSION_DENIED,
 * ERR_NOT_REGISTERED, ...) so the page can tell why. ERR_INTERNAL only when
 * Harbor gave no code.
 */
function harborFailure(id: string, e: unknown, fallback: string) {
  const code = (e as { code?: unknown } | null)?.code;
  return errorResponse(
    id,
    typeof code === 'string' && code ? code : 'ERR_INTERNAL',
    e instanceof Error ? e.message : fallback,
  );
}

// =============================================================================
// Agent State
// =============================================================================

// Track registered agents from this extension
const registeredAgents = new Map<string, {
  agentId: string;
  origin: string;
  tabId: number;
  name: string;
  capabilities: string[];
  /** When the page API registered it; compared with the tab's latest page. */
  registeredAt: number;
}>();

// Track pending invocations waiting for responses from pages. Bound to the
// tab the invocation was actually sent to (background.ts's
// agentInvocationResponse listener checks this before resolving), since
// every tab's content script now shares this one extension: without the
// binding, a page in another tab that guessed the invocationId could answer
// on the real handler's behalf.
const pendingInvocations = new Map<string, {
  resolve: (response: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  tabId: number;
  /** When the invocation was sent to the tab's page. */
  sentAt: number;
  /** The site of the agent it was sent to. */
  agentOrigin?: string;
}>();

// Track tabs that have invocation handlers set up (agentId -> tabId)
const agentInvocationTabs = new Map<string, number>();

// =============================================================================
// Invocation Handler Registration
// =============================================================================

async function registerProxyInvocationHandler(agentId: string, origin: string, tabId: number): Promise<void> {
  console.log('[Web Agents API] registerProxyInvocationHandler called:', { agentId, origin, tabId });
  
  if (tabId > 0) {
    agentInvocationTabs.set(agentId, tabId);
  }

  try {
    await harborRequest('agents.registerInvocationHandler', { agentId, origin, tabId });
  } catch (e) {
    console.error('[Web Agents API] Failed to register proxy handler with Harbor:', e);
  }
}

/**
 * Whether the page that registered `agentId` still shows in `tabId`: the tab
 * is on the agent's site, and no newer page has connected there since the
 * agent registered.
 */
async function agentPageStillInTab(agentId: string, tabId: number): Promise<boolean> {
  const agent = registeredAgents.get(agentId);
  if (!agent) return false;
  const latest = latestPage(tabId);
  if (latest && latest.at > agent.registeredAt) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!tab?.url && new URL(tab.url).origin === agent.origin;
  } catch {
    return false;
  }
}

/**
 * Handle an invocation request from Harbor for one of our registered agents.
 */
export async function handleIncomingInvocation(
  agentId: string,
  request: { from: string; task: string; input?: unknown; timeout?: number },
  traceId?: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; result?: unknown; error?: { code: string; message: string } }> {
  const trace = traceId || 'no-trace';
  
  let tabId = agentInvocationTabs.get(agentId);
  
  if (!tabId) {
    const agent = registeredAgents.get(agentId);
    if (agent?.tabId) {
      tabId = agent.tabId;
    }
  }
  
  console.log(`[TRACE ${trace}] handleIncomingInvocation - agentId: ${agentId}, tabId: ${tabId}`);
  
  if (!tabId) {
    return { success: false, error: { code: 'ERR_NO_TAB', message: 'Agent tab not found' } };
  }

  // Send nothing to the tab unless the page that registered the agent is
  // still the one there. Just after the tab's page is replaced, the old
  // page's agent is still registered until its disconnect is handled, and
  // the content script would post the caller's task and input straight
  // into the new page, which may be another site.
  if (!(await agentPageStillInTab(agentId, tabId))) {
    console.log(`[TRACE ${trace}] handleIncomingInvocation - the agent's page has left tab ${tabId}`);
    return { success: false, error: { code: 'ERR_AGENT_NOT_FOUND', message: "The agent's page is gone" } };
  }
  
  const invocationId = `inv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const timeout = invocationTimeoutMs(request.timeout);
  const pageTabId = tabId;

  return new Promise((resolve) => {
    // The invocation is over for the caller while the agent's page may
    // still be working on it: tell the page to stop, and drop its answer.
    const cancelInPage = (error: { code: string; message: string }) => {
      if (!pendingInvocations.has(invocationId)) return;
      clearTimeout(timeoutId);
      pendingInvocations.delete(invocationId);
      signal?.removeEventListener('abort', onAbort);
      chrome.tabs.sendMessage(pageTabId, { type: 'agentInvocationCancel', invocationId }).catch(() => {});
      resolve({ success: false, error });
    };
    const onAbort = () => cancelInPage({ code: 'ERR_ABORTED', message: 'The caller stopped waiting' });
    const timeoutId = setTimeout(() => {
      cancelInPage({ code: 'ERR_TIMEOUT', message: 'Invocation timed out' });
    }, timeout);
    const settle = (response: { success: boolean; result?: unknown; error?: { code: string; message: string } }) => {
      clearTimeout(timeoutId);
      pendingInvocations.delete(invocationId);
      signal?.removeEventListener('abort', onAbort);
      resolve(response);
    };

    pendingInvocations.set(invocationId, {
      resolve: (response) => settle(response as { success: boolean; result?: unknown; error?: { code: string; message: string } }),
      reject: (error) => settle({ success: false, error: { code: 'ERR_FAILED', message: error.message } }),
      timeout: timeoutId,
      tabId: tabId!,
      sentAt: Date.now(),
      agentOrigin: registeredAgents.get(agentId)?.origin,
    });
    
    chrome.tabs.sendMessage(tabId!, {
      type: 'agentInvocation',
      invocationId,
      agentId,
      // The content script posts into the page only if it's on this site.
      agentOrigin: registeredAgents.get(agentId)?.origin,
      from: request.from,
      task: request.task,
      input: request.input,
      traceId: trace,
    }).catch((error) => {
      settle({ success: false, error: { code: 'ERR_SEND_FAILED', message: error.message } });
    });

    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Resolve an invocation response from a page. `senderTabId` must match the
 * tab the invocation was actually sent to — the response's own
 * `invocationId` is not enough on its own, since any page could try to
 * guess it. background.ts supplies `senderTabId` from the replying
 * content script's `sender.tab.id`, which a page cannot forge.
 */
export function resolveInvocationResponse(
  response: {
    invocationId: string;
    success: boolean;
    result?: unknown;
    error?: { code: string; message: string };
  },
  senderTabId: number,
): boolean {
  const pending = pendingInvocations.get(response.invocationId);
  if (!pending) return false;
  if (pending.tabId !== senderTabId) {
    console.warn(
      '[Harbor PageAPI] Ignoring agentInvocationResponse from a mismatched tab',
      { invocationId: response.invocationId, expectedTabId: pending.tabId, senderTabId },
    );
    return false;
  }
  pending.resolve(response);
  return true;
}

/**
 * The page in a tab has gone (it closed, navigated or reloaded): fail every
 * invocation still waiting on it, since it can no longer answer. The caller
 * hears straight away instead of waiting out the timeout.
 *
 * `sentBefore` spares invocations sent to a newer page in the tab, when the
 * old page's disconnect arrives after the new page has started.
 */
export function failInvocationsForTab(tabId: number, sentBefore = Infinity): void {
  for (const pending of [...pendingInvocations.values()]) {
    if (pending.tabId !== tabId || pending.sentAt >= sentBefore) continue;
    pending.resolve({
      success: false,
      error: { code: 'ERR_AGENT_NOT_FOUND', message: "The agent's page is gone" },
    });
  }
}

/**
 * The tab now shows `url`. Fail every invocation waiting on an agent from
 * another site in that tab, and forget those agents here. A navigation
 * doesn't always close the old page's port (Firefox can keep the page in the
 * back/forward cache), so this doesn't wait for a disconnect.
 */
export function forgetAgentsLeavingTab(tabId: number, url: string): void {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  for (const pending of [...pendingInvocations.values()]) {
    if (pending.tabId !== tabId || pending.agentOrigin === origin) continue;
    pending.resolve({
      success: false,
      error: { code: 'ERR_AGENT_NOT_FOUND', message: "The agent's page is gone" },
    });
  }
  for (const [agentId, agent] of registeredAgents.entries()) {
    if (agent.tabId !== tabId || agent.origin === origin) continue;
    registeredAgents.delete(agentId);
    agentInvocationTabs.delete(agentId);
  }
}

// =============================================================================
// Agent Handlers
// =============================================================================

export async function handleAgentsRegister(ctx: RequestContext): HandlerResponse {
  const options = ctx.payload as {
    name: string;
    description?: string;
    capabilities?: string[];
    tags?: string[];
    acceptsInvocations?: boolean;
    acceptsMessages?: boolean;
  };

  if (!options.name) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing name');
  }

  try {
    const result = await harborRequest<{
      id: string;
      name: string;
      description?: string;
      capabilities: string[];
      tags: string[];
      status: string;
      origin: string;
      acceptsInvocations: boolean;
      acceptsMessages: boolean;
      registeredAt: number;
      lastActiveAt: number;
    }>('agents.register', {
      ...options,
      origin: ctx.origin,
      tabId: ctx.tabId,
    }, { signal: ctx.signal });

    const tabId = ctx.tabId;
    
    registeredAgents.set(result.id, {
      agentId: result.id,
      origin: ctx.origin,
      tabId: tabId || 0,
      name: result.name,
      capabilities: result.capabilities,
      registeredAt: Date.now(),
    });
    
    if (result.acceptsInvocations) {
      await registerProxyInvocationHandler(result.id, ctx.origin, tabId || 0);
    }
    if (result.acceptsMessages) {
      // Messages and broadcasts for this agent go to this tab. The agent is
      // registered either way, so a failure here doesn't fail registration.
      try {
        await harborRequest('agents.registerMessageHandler', { agentId: result.id, origin: ctx.origin, tabId: tabId || 0 });
      } catch (e) {
        console.error('[Web Agents API] Failed to set up message delivery:', e);
      }
    }

    return successResponse(ctx.id, result);
  } catch (e) {
    return harborFailure(ctx.id, e, 'Registration failed');
  }
}

export async function handleAgentsUnregister(ctx: RequestContext): HandlerResponse {
  const { agentId } = ctx.payload as { agentId: string };

  if (!agentId) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing agentId');
  }

  try {
    const unregistered = await harborRequest<boolean>('agents.unregister', { agentId, origin: ctx.origin, tabId: ctx.tabId }, { signal: ctx.signal });
    // Harbor refuses to unregister another origin's agent; that agent stays
    // reachable, so only forget it here when Harbor actually let it go.
    if (unregistered === true) {
      registeredAgents.delete(agentId);
      agentInvocationTabs.delete(agentId);
    }
    return successResponse(ctx.id, null);
  } catch (e) {
    return harborFailure(ctx.id, e, 'Unregistration failed');
  }
}

export async function handleAgentsGetInfo(ctx: RequestContext): HandlerResponse {
  const { agentId } = ctx.payload as { agentId: string };

  if (!agentId) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing agentId');
  }

  try {
    const result = await harborRequest('agents.getInfo', { agentId, origin: ctx.origin, tabId: ctx.tabId }, { signal: ctx.signal });
    return successResponse(ctx.id, result);
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_AGENT_NOT_FOUND', e instanceof Error ? e.message : 'Agent not found');
  }
}

export async function handleAgentsDiscover(ctx: RequestContext): HandlerResponse {
  const query = ctx.payload as {
    name?: string;
    capabilities?: string[];
    tags?: string[];
    includeSameOrigin?: boolean;
    includeCrossOrigin?: boolean;
  };

  try {
    const result = await harborRequest<{ agents: unknown[]; total: number }>('agents.discover', {
      ...query,
      origin: ctx.origin,
      tabId: ctx.tabId,
    }, { signal: ctx.signal });
    return successResponse(ctx.id, result);
  } catch (e) {
    return harborFailure(ctx.id, e, 'Discovery failed');
  }
}

export async function handleAgentsList(ctx: RequestContext): HandlerResponse {
  try {
    const agents = await harborRequest<AgentListEntry[]>('agents.list', { origin: ctx.origin, tabId: ctx.tabId }, { signal: ctx.signal });
    return successResponse(ctx.id, { agents });
  } catch (e) {
    return harborFailure(ctx.id, e, 'List failed');
  }
}

export async function handleAgentsInvoke(ctx: RequestContext): HandlerResponse {
  const { agentId, request } = ctx.payload as {
    agentId: string;
    request: { task: string; input?: unknown; timeout?: number };
  };

  const traceId = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (!agentId || !request) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing agentId or request');
  }

  try {
    const result = await harborRequest<{
      success: boolean;
      result?: unknown;
      error?: { code: string; message: string };
      executionTime?: number;
    }>('agents.invoke', {
      agentId,
      task: request.task,
      input: request.input,
      timeout: request.timeout,
      origin: ctx.origin,
      tabId: ctx.tabId,
      traceId,
    }, {
      signal: ctx.signal,
      // The invocation answers ERR_TIMEOUT itself when its own timeout runs
      // out; this page-call limit is a backstop a little past that, not
      // harborRequest's 30-second default, which would cut it short.
      timeoutMs: invocationTimeoutMs(request.timeout) + 10_000,
    });

    return successResponse(ctx.id, result);
  } catch (e) {
    return harborFailure(ctx.id, e, 'Invocation failed');
  }
}

export async function handleAgentsSend(ctx: RequestContext): HandlerResponse {
  const { agentId, payload } = ctx.payload as { agentId: string; payload: unknown };

  if (!agentId) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing agentId');
  }

  try {
    const result = await harborRequest<{ delivered: boolean }>('agents.send', {
      agentId,
      payload,
      origin: ctx.origin,
      tabId: ctx.tabId,
    }, { signal: ctx.signal });

    return successResponse(ctx.id, result);
  } catch (e) {
    return harborFailure(ctx.id, e, 'Send failed');
  }
}

export async function handleAgentsSubscribe(ctx: RequestContext): HandlerResponse {
  const { eventType } = ctx.payload as { eventType: string };

  if (!eventType) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing eventType');
  }

  try {
    await harborRequest('agents.subscribe', {
      eventType,
      origin: ctx.origin,
      tabId: ctx.tabId,
    }, { signal: ctx.signal });

    return successResponse(ctx.id, null);
  } catch (e) {
    return harborFailure(ctx.id, e, 'Subscribe failed');
  }
}

export async function handleAgentsUnsubscribe(ctx: RequestContext): HandlerResponse {
  const { eventType } = ctx.payload as { eventType: string };

  if (!eventType) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing eventType');
  }

  try {
    await harborRequest('agents.unsubscribe', {
      eventType,
      origin: ctx.origin,
      tabId: ctx.tabId,
    }, { signal: ctx.signal });

    return successResponse(ctx.id, null);
  } catch (e) {
    return harborFailure(ctx.id, e, 'Unsubscribe failed');
  }
}

export async function handleAgentsBroadcast(ctx: RequestContext): HandlerResponse {
  const { eventType, data } = ctx.payload as { eventType: string; data: unknown };

  if (!eventType) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing eventType');
  }

  try {
    const result = await harborRequest<{ delivered: number }>('agents.broadcast', {
      eventType,
      data,
      origin: ctx.origin,
      tabId: ctx.tabId,
    }, { signal: ctx.signal });

    return successResponse(ctx.id, result);
  } catch (e) {
    return harborFailure(ctx.id, e, 'Broadcast failed');
  }
}

// =============================================================================
// Orchestration Handlers
// =============================================================================

/**
 * How long a page's orchestration call may run. Each step keeps its own
 * invocation timeout, and the person may be asked about a step partway
 * through, so a pipeline can run well past harborRequest's 30-second
 * default. This is a backstop, not a step limit.
 */
export const ORCHESTRATION_PAGE_CALL_MS = 30 * 60_000;

export async function handleAgentsPipeline(ctx: RequestContext): HandlerResponse {
  const { config, initialInput } = ctx.payload as {
    config: { steps: Array<{ agentId: string; task: string; inputTransform?: string; outputTransform?: string }> };
    initialInput: unknown;
  };

  if (!config?.steps?.length) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing pipeline steps');
  }

  try {
    const result = await harborRequest<{
      success: boolean;
      result: unknown;
      stepResults: unknown[];
    }>('agents.orchestrate.pipeline', {
      config,
      initialInput,
      origin: ctx.origin,
      tabId: ctx.tabId,
    }, { signal: ctx.signal, timeoutMs: ORCHESTRATION_PAGE_CALL_MS });

    return successResponse(ctx.id, result);
  } catch (e) {
    return harborFailure(ctx.id, e, 'Pipeline failed');
  }
}

export async function handleAgentsParallel(ctx: RequestContext): HandlerResponse {
  const { config } = ctx.payload as {
    config: {
      tasks: Array<{ agentId: string; task: string; input?: unknown }>;
      combineStrategy?: 'array' | 'merge' | 'first';
    };
  };

  if (!config?.tasks?.length) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing parallel tasks');
  }

  try {
    const result = await harborRequest<{
      success: boolean;
      results: unknown[];
      combined: unknown;
    }>('agents.orchestrate.parallel', {
      config,
      origin: ctx.origin,
      tabId: ctx.tabId,
    }, { signal: ctx.signal, timeoutMs: ORCHESTRATION_PAGE_CALL_MS });

    return successResponse(ctx.id, result);
  } catch (e) {
    return harborFailure(ctx.id, e, 'Parallel execution failed');
  }
}

export async function handleAgentsRoute(ctx: RequestContext): HandlerResponse {
  const { config, input, task } = ctx.payload as {
    config: {
      routes: Array<{ condition: string; agentId: string }>;
      defaultAgentId?: string;
    };
    input: unknown;
    task: string;
  };

  if (!config?.routes?.length) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing routes');
  }

  try {
    const result = await harborRequest<{
      success: boolean;
      result?: unknown;
      error?: { code: string; message: string };
    }>('agents.orchestrate.route', {
      config,
      input,
      task,
      origin: ctx.origin,
      tabId: ctx.tabId,
    }, { signal: ctx.signal, timeoutMs: ORCHESTRATION_PAGE_CALL_MS });

    return successResponse(ctx.id, result);
  } catch (e) {
    return harborFailure(ctx.id, e, 'Routing failed');
  }
}

// =============================================================================
// Tab Cleanup
// =============================================================================

export function cleanupAgentsForTab(tabId: number): void {
  failInvocationsForTab(tabId);
  for (const [agentId, agent] of registeredAgents.entries()) {
    if (agent.tabId === tabId) {
      registeredAgents.delete(agentId);
      agentInvocationTabs.delete(agentId);
      harborRequest('agents.unregister', { agentId, origin: agent.origin }).catch(() => {});
    }
  }
}

/**
 * The page in a tab has gone: forget the agents it registered here.
 * `registeredBefore` spares agents a newer page in the tab registered.
 * Harbor's own registry forgets them separately (forgetTabAgents).
 */
export function forgetPageAgentsInTab(tabId: number, registeredBefore = Infinity): void {
  for (const [agentId, agent] of registeredAgents.entries()) {
    if (agent.tabId !== tabId || agent.registeredAt >= registeredBefore) continue;
    registeredAgents.delete(agentId);
    agentInvocationTabs.delete(agentId);
  }
}

// Export state accessors for external use
export { registeredAgents, agentInvocationTabs };
