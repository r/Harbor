/**
 * Multi-Agent Handlers
 * 
 * Handles agent registration, discovery, invocation, and orchestration.
 */

import { harborRequest, discoverHarbor, getHarborState } from '../harbor-client';
import type { RequestContext, HandlerResponse } from './types';
import { errorResponse, successResponse } from './types';

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
}>();

// Track pending invocations waiting for responses from pages
const pendingInvocations = new Map<string, {
  resolve: (response: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
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
  
  const harborState = getHarborState();
  if (!harborState.connected) {
    const id = await discoverHarbor();
    if (!id) {
      console.error('[Web Agents API] Cannot register invocation handler - Harbor not found');
      return;
    }
  }
  
  try {
    await harborRequest('agents.registerInvocationHandler', { agentId, origin, tabId });
  } catch (e) {
    console.error('[Web Agents API] Failed to register proxy handler with Harbor:', e);
  }
}

/**
 * Handle an invocation request from Harbor for one of our registered agents.
 */
export async function handleIncomingInvocation(
  agentId: string,
  request: { from: string; task: string; input?: unknown; timeout?: number },
  traceId?: string
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
  
  const invocationId = `inv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const timeout = request.timeout || 30000;
  
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      pendingInvocations.delete(invocationId);
      resolve({ success: false, error: { code: 'ERR_TIMEOUT', message: 'Invocation timed out' } });
    }, timeout);
    
    pendingInvocations.set(invocationId, {
      resolve: (response) => {
        clearTimeout(timeoutId);
        pendingInvocations.delete(invocationId);
        resolve(response as { success: boolean; result?: unknown; error?: { code: string; message: string } });
      },
      reject: (error) => {
        clearTimeout(timeoutId);
        pendingInvocations.delete(invocationId);
        resolve({ success: false, error: { code: 'ERR_FAILED', message: error.message } });
      },
      timeout: timeoutId,
    });
    
    chrome.tabs.sendMessage(tabId!, {
      type: 'agentInvocation',
      invocationId,
      agentId,
      from: request.from,
      task: request.task,
      input: request.input,
      traceId: trace,
    }).catch((error) => {
      clearTimeout(timeoutId);
      pendingInvocations.delete(invocationId);
      resolve({ success: false, error: { code: 'ERR_SEND_FAILED', message: error.message } });
    });
  });
}

/**
 * Resolve an invocation response from a page.
 */
export function resolveInvocationResponse(response: {
  invocationId: string;
  success: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}): boolean {
  const pending = pendingInvocations.get(response.invocationId);
  if (pending) {
    pending.resolve(response);
    return true;
  }
  return false;
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
    });

    const tabId = ctx.tabId;
    
    registeredAgents.set(result.id, {
      agentId: result.id,
      origin: ctx.origin,
      tabId: tabId || 0,
      name: result.name,
      capabilities: result.capabilities,
    });
    
    if (result.acceptsInvocations) {
      await registerProxyInvocationHandler(result.id, ctx.origin, tabId || 0);
    }

    return successResponse(ctx.id, result);
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_INTERNAL', e instanceof Error ? e.message : 'Registration failed');
  }
}

export async function handleAgentsUnregister(ctx: RequestContext): HandlerResponse {
  const { agentId } = ctx.payload as { agentId: string };

  if (!agentId) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing agentId');
  }

  try {
    await harborRequest('agents.unregister', { agentId, origin: ctx.origin });
    registeredAgents.delete(agentId);
    return successResponse(ctx.id, null);
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_INTERNAL', e instanceof Error ? e.message : 'Unregistration failed');
  }
}

export async function handleAgentsGetInfo(ctx: RequestContext): HandlerResponse {
  const { agentId } = ctx.payload as { agentId: string };

  if (!agentId) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing agentId');
  }

  try {
    const result = await harborRequest('agents.getInfo', { agentId, origin: ctx.origin });
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
    });
    return successResponse(ctx.id, result);
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_INTERNAL', e instanceof Error ? e.message : 'Discovery failed');
  }
}

export async function handleAgentsList(ctx: RequestContext): HandlerResponse {
  try {
    const result = await harborRequest<{ agents: unknown[] }>('agents.list', { origin: ctx.origin });
    return successResponse(ctx.id, result);
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_INTERNAL', e instanceof Error ? e.message : 'List failed');
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
    });

    return successResponse(ctx.id, result);
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_INTERNAL', e instanceof Error ? e.message : 'Invocation failed');
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
    });

    return successResponse(ctx.id, result);
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_INTERNAL', e instanceof Error ? e.message : 'Send failed');
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
    });

    return successResponse(ctx.id, null);
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_INTERNAL', e instanceof Error ? e.message : 'Subscribe failed');
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
    });

    return successResponse(ctx.id, null);
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_INTERNAL', e instanceof Error ? e.message : 'Unsubscribe failed');
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
    });

    return successResponse(ctx.id, result);
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_INTERNAL', e instanceof Error ? e.message : 'Broadcast failed');
  }
}

// =============================================================================
// Orchestration Handlers
// =============================================================================

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
    });

    return successResponse(ctx.id, result);
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_INTERNAL', e instanceof Error ? e.message : 'Pipeline failed');
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
    });

    return successResponse(ctx.id, result);
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_INTERNAL', e instanceof Error ? e.message : 'Parallel execution failed');
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
    });

    return successResponse(ctx.id, result);
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_INTERNAL', e instanceof Error ? e.message : 'Routing failed');
  }
}

// =============================================================================
// Tab Cleanup
// =============================================================================

export function cleanupAgentsForTab(tabId: number): void {
  for (const [agentId, agent] of registeredAgents.entries()) {
    if (agent.tabId === tabId) {
      registeredAgents.delete(agentId);
      harborRequest('agents.unregister', { agentId, origin: agent.origin }).catch(() => {});
    }
  }
}

// Export state accessors for external use
export { registeredAgents, agentInvocationTabs };
