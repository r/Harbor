/**
 * Multi-agent handlers - agent registration, discovery, invocation, messaging, and orchestration.
 */

import type { RequestContext, ResponseSender } from './router-types';
import type {
  AgentRegistrationOptions,
  Pipeline,
  ParallelExecution,
  AgentRouter,
  RemoteAgentEndpoint,
  Supervisor,
  SupervisorTask,
} from '../../multi-agent/types';
import { log, requirePermission } from './helpers';
import { checkPermissions } from '../../policy/permissions';
import { browserAPI } from '../../browser-compat';
import {
  registerAgent,
  unregisterAgent,
  getAgent,
  getAgentsByOrigin,
  getAgentUsage,
  discoverAgents,
} from '../../multi-agent/registry';
import {
  sendMessage as sendAgentMessage,
  invokeAgent as invokeAgentHandler,
  registerMessageHandler,
  unregisterMessageHandler,
  registerInvocationHandler,
  unregisterInvocationHandler,
  subscribeToEvent,
  unsubscribeFromEvent,
} from '../../multi-agent/messaging';
import {
  executePipeline,
  executeParallel,
  executeRouter,
  executeSupervisor,
} from '../../multi-agent/orchestration';
import {
  connectRemoteAgent,
  disconnectRemoteAgent,
  listRemoteAgents,
  pingRemoteAgent,
  discoverRemoteAgents,
} from '../../multi-agent/remote';

// =============================================================================
// State Management
// =============================================================================

// Track which agent each origin has registered (origin -> agentId)
const originAgents = new Map<string, string>();

// Track which agents have external handlers (via Web Agents API)
const externalInvocationHandlers = new Map<string, { origin: string; tabId?: number; extensionId?: string }>();

// =============================================================================
// Agent Registration Handlers
// =============================================================================

/**
 * Handle agents.register - Register as an agent.
 */
export async function handleAgentsRegister(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'agents:register'))) {
    return;
  }

  const options = ctx.payload as AgentRegistrationOptions;

  try {
    const agent = registerAgent(options, ctx.origin, ctx.tabId);
    originAgents.set(ctx.origin, agent.id);

    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: {
        id: agent.id,
        name: agent.name,
        capabilities: agent.capabilities,
        tags: agent.tags,
        acceptsInvocations: agent.acceptsInvocations,
        acceptsMessages: agent.acceptsMessages,
      },
    });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Registration failed',
      },
    });
  }
}

/**
 * Handle agents.unregister - Unregister an agent.
 */
export async function handleAgentsUnregister(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'agents:register'))) {
    return;
  }

  const payload = ctx.payload as { agentId: string };

  const result = unregisterAgent(payload.agentId, ctx.origin);
  if (result) {
    originAgents.delete(ctx.origin);
  }

  sender.sendResponse({ id: ctx.id, ok: true, result });
}

/**
 * Handle agents.getInfo - Get agent info.
 */
export async function handleAgentsGetInfo(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const payload = ctx.payload as { agentId?: string } | undefined;
  const agentId = payload?.agentId || originAgents.get(ctx.origin);

  if (!agentId) {
    sender.sendResponse({ id: ctx.id, ok: true, result: null });
    return;
  }

  const agent = getAgent(agentId);
  if (!agent) {
    sender.sendResponse({ id: ctx.id, ok: true, result: null });
    return;
  }

  // Only return info if same origin or has crossOrigin permission
  if (agent.origin !== ctx.origin) {
    const check = await checkPermissions(ctx.origin, ['agents:crossOrigin']);
    if (!check.granted) {
      sender.sendResponse({ id: ctx.id, ok: true, result: null });
      return;
    }
  }

  const usage = getAgentUsage(agentId);

  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      origin: agent.origin,
      capabilities: agent.capabilities,
      tags: agent.tags,
      status: agent.status,
      usage: usage || {
        promptCount: 0,
        tokensUsed: 0,
        toolCallCount: 0,
        messagesSent: 0,
        invocationsMade: 0,
        invocationsReceived: 0,
      },
    },
  });
}

/**
 * Handle agents.discover - Discover available agents.
 */
export async function handleAgentsDiscover(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'agents:discover'))) {
    return;
  }

  const payload = ctx.payload as {
    name?: string;
    capabilities?: string[];
    tags?: string[];
    includeSameOrigin?: boolean;
    includeCrossOrigin?: boolean;
    includeRemote?: boolean;
  } | undefined;

  // Check if cross-origin discovery is allowed
  let allowCrossOrigin = false;
  if (payload?.includeCrossOrigin) {
    const check = await checkPermissions(ctx.origin, ['agents:crossOrigin']);
    allowCrossOrigin = check.granted;
  }

  const agents = discoverAgents(ctx.origin, payload || {}, allowCrossOrigin);

  sender.sendResponse({ id: ctx.id, ok: true, result: agents });
}

/**
 * Handle agents.list - List agents for this origin.
 */
export async function handleAgentsList(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const agents = getAgentsByOrigin(ctx.origin);

  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: agents.map(a => ({
      id: a.id,
      name: a.name,
      status: a.status,
    })),
  });
}

// =============================================================================
// Agent Invocation Handlers
// =============================================================================

/**
 * Handle agents.invoke - Invoke another agent.
 */
export async function handleAgentsInvoke(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'agents:invoke'))) {
    return;
  }

  const payload = ctx.payload as {
    agentId: string;
    task: string;
    input?: unknown;
    timeout?: number;
    traceId?: string;
  };

  const traceId = payload.traceId || `harbor-trace-${Date.now()}`;
  log(`[TRACE ${traceId}] handleAgentsInvoke START - target: ${payload.agentId}, task: ${payload.task}`);

  const fromAgentId = originAgents.get(ctx.origin);
  if (!fromAgentId) {
    log(`[TRACE ${traceId}] ERROR - invoker not registered`);
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_NOT_REGISTERED',
        message: 'Must register as an agent before invoking others',
      },
    });
    return;
  }

  log(`[TRACE ${traceId}] Invoking from ${fromAgentId} to ${payload.agentId}`);
  
  const result = await invokeAgentHandler(
    {
      agentId: payload.agentId,
      task: payload.task,
      input: payload.input,
      timeout: payload.timeout,
    },
    fromAgentId,
    ctx.origin,
    traceId,
  );
  
  log(`[TRACE ${traceId}] invokeAgentHandler complete, success: ${result.success}`);

  sender.sendResponse({ id: ctx.id, ok: true, result });
}

// =============================================================================
// Agent Messaging Handlers
// =============================================================================

/**
 * Handle agents.send - Send a message to another agent.
 */
export async function handleAgentsSend(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'agents:message'))) {
    return;
  }

  const payload = ctx.payload as { to: string; payload: unknown };

  const fromAgentId = originAgents.get(ctx.origin);
  if (!fromAgentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_NOT_REGISTERED',
        message: 'Must register as an agent before sending messages',
      },
    });
    return;
  }

  const result = await sendAgentMessage(fromAgentId, payload.to, payload.payload, ctx.origin);

  sender.sendResponse({ id: ctx.id, ok: true, result });
}

/**
 * Handle agents.subscribe - Subscribe to an event type.
 */
export async function handleAgentsSubscribe(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'agents:message'))) {
    return;
  }

  const payload = ctx.payload as { eventType: string };
  const agentId = originAgents.get(ctx.origin);

  if (agentId) {
    subscribeToEvent(agentId, payload.eventType);
  }

  sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
}

/**
 * Handle agents.unsubscribe - Unsubscribe from an event type.
 */
export async function handleAgentsUnsubscribe(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const payload = ctx.payload as { eventType: string };
  const agentId = originAgents.get(ctx.origin);

  if (agentId) {
    unsubscribeFromEvent(agentId, payload.eventType);
  }

  sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
}

/**
 * Handle agents.registerMessageHandler - Register handler for incoming messages.
 */
export function handleAgentsRegisterMessageHandler(
  ctx: RequestContext,
  sender: ResponseSender,
): void {
  const agentId = originAgents.get(ctx.origin);
  if (!agentId) {
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
    return;
  }

  // The actual handler is in the page, we just track registration
  registerMessageHandler(agentId, (message) => {
    // Forward message to the page
    if (ctx.tabId) {
      browserAPI.tabs.sendMessage(ctx.tabId, {
        type: 'harbor_agent_message',
        message,
      }).catch(() => {});
    }
  });

  sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
}

/**
 * Handle agents.unregisterMessageHandler - Unregister message handler.
 */
export function handleAgentsUnregisterMessageHandler(
  ctx: RequestContext,
  sender: ResponseSender,
): void {
  const agentId = originAgents.get(ctx.origin);
  if (agentId) {
    unregisterMessageHandler(agentId);
  }
  sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
}

/**
 * Handle agents.registerInvocationHandler - Register handler for invocations.
 */
export function handleAgentsRegisterInvocationHandler(
  ctx: RequestContext,
  sender: ResponseSender,
): void {
  log('handleAgentsRegisterInvocationHandler called, payload:', JSON.stringify(ctx.payload));
  
  const payload = ctx.payload as { agentId?: string; origin?: string; tabId?: number } | undefined;
  
  // If agentId is provided directly (from Web Agents API), use it
  // Otherwise, look up by origin (for content script registrations)
  const agentId = payload?.agentId || originAgents.get(ctx.origin);
  
  log('Resolved agentId:', agentId, 'from payload.agentId:', payload?.agentId, 'or originAgents lookup');
  
  if (!agentId) {
    log('No agent found for invocation handler registration:', ctx.origin);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
    return;
  }
  
  const handlerOrigin = payload?.origin || ctx.origin;
  const handlerTabId = payload?.tabId || ctx.tabId;
  const handlerExtensionId = ctx.senderExtensionId;
  
  log('Registering invocation handler for', agentId, 'origin:', handlerOrigin, 'tabId:', handlerTabId, 'extensionId:', handlerExtensionId);
  
  // Track that this agent has an external handler (including the sender's extension ID for forwarding)
  externalInvocationHandlers.set(agentId, { origin: handlerOrigin, tabId: handlerTabId, extensionId: handlerExtensionId });
  
  // Register a handler that will forward invocations to the external handler
  registerInvocationHandler(agentId, async (request, fromAgentId, traceId) => {
    const trace = traceId || 'no-trace';
    log(`[TRACE ${trace}] Proxy handler called for ${agentId}, task: ${request.task}`);
    
    const externalInfo = externalInvocationHandlers.get(agentId);
    if (!externalInfo) {
      log(`[TRACE ${trace}] ERROR - no external handler info`);
      return {
        success: false,
        error: { code: 'ERR_NO_EXTERNAL_HANDLER', message: 'External handler not found' },
        executionTime: 0,
      };
    }
    
    log(`[TRACE ${trace}] Forwarding to Web Agents API...`);
    
    // Forward to Web Agents API for delivery to the page
    // Web Agents API will handle forwarding to the correct tab
    try {
      const forwardRequest = {
        from: fromAgentId,
        task: request.task,
        input: request.input,
        timeout: request.timeout,
      };
      const response = await forwardInvocationToExtension(agentId, forwardRequest, externalInfo, trace);
      log(`[TRACE ${trace}] forwardInvocationToExtension returned, success: ${response.success}`);
      return response;
    } catch (e) {
      log(`[TRACE ${trace}] forwardInvocationToExtension ERROR: ${e instanceof Error ? e.message : 'Unknown'}`);
      return {
        success: false,
        error: { code: 'ERR_FORWARD_FAILED', message: e instanceof Error ? e.message : 'Forward failed' },
        executionTime: 0,
      };
    }
  });

  sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
}

/**
 * Forward an invocation to the Web Agents API extension via runtime.sendMessage.
 */
async function forwardInvocationToExtension(
  agentId: string,
  request: { from: string; task: string; input?: unknown; timeout?: number },
  handlerInfo: { origin: string; tabId?: number; extensionId?: string },
  traceId?: string
): Promise<{ success: boolean; result?: unknown; error?: { code: string; message: string }; executionTime: number }> {
  const trace = traceId || 'no-trace';
  const startTime = Date.now();
  
  log(`[TRACE ${trace}] forwardInvocationToExtension - agentId: ${agentId}, task: ${request.task}, extensionId: ${handlerInfo.extensionId}, tabId: ${handlerInfo.tabId}`);
  
  if (!handlerInfo.extensionId) {
    log(`[TRACE ${trace}] ERROR - no extensionId in handlerInfo`);
    return {
      success: false,
      error: { code: 'ERR_NO_EXTENSION', message: 'No extension ID available for invocation forwarding' },
      executionTime: Date.now() - startTime,
    };
  }
  
  return new Promise((resolve) => {
    const timeout = request.timeout || 30000;
    const timeoutId = setTimeout(() => {
      log(`[TRACE ${trace}] forwardInvocationToExtension TIMEOUT`);
      resolve({
        success: false,
        error: { code: 'ERR_TIMEOUT', message: 'Invocation timed out' },
        executionTime: Date.now() - startTime,
      });
    }, timeout);
    
    log(`[TRACE ${trace}] Sending to extension ${handlerInfo.extensionId}...`);
    
    // Send to the Web Agents API extension's background script
    browserAPI.runtime.sendMessage(
      handlerInfo.extensionId,
      {
        type: 'harbor.forwardInvocation',
        agentId,
        request,
        handlerInfo: { origin: handlerInfo.origin, tabId: handlerInfo.tabId },
        traceId: trace,
      },
      (response) => {
        clearTimeout(timeoutId);
        if (browserAPI.runtime.lastError) {
          log(`[TRACE ${trace}] runtime.sendMessage error: ${browserAPI.runtime.lastError.message}`);
          resolve({
            success: false,
            error: { code: 'ERR_SEND_FAILED', message: browserAPI.runtime.lastError.message || 'Send failed' },
            executionTime: Date.now() - startTime,
          });
          return;
        }
        log(`[TRACE ${trace}] Got response from extension: ${JSON.stringify(response)}`);
        resolve({
          ...response,
          executionTime: Date.now() - startTime,
        });
      }
    );
  });
}

/**
 * Handle agents.unregisterInvocationHandler - Unregister invocation handler.
 */
export function handleAgentsUnregisterInvocationHandler(
  ctx: RequestContext,
  sender: ResponseSender,
): void {
  const agentId = originAgents.get(ctx.origin);
  if (agentId) {
    unregisterInvocationHandler(agentId);
  }
  sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
}

// =============================================================================
// Orchestration Handlers
// =============================================================================

/**
 * Handle agents.orchestrate.pipeline - Execute a pipeline of agents.
 */
export async function handleOrchestratePipeline(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'agents:invoke'))) {
    return;
  }

  const payload = ctx.payload as { pipeline: Pipeline; initialInput: unknown };
  const agentId = originAgents.get(ctx.origin);

  if (!agentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_NOT_REGISTERED', message: 'Must register as an agent first' },
    });
    return;
  }

  const result = await executePipeline(payload.pipeline, payload.initialInput, agentId, ctx.origin);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}

/**
 * Handle agents.orchestrate.parallel - Execute agents in parallel.
 * Accepts either a direct ParallelExecution (Harbor page) or { config, origin } (Web Agents API).
 */
export async function handleOrchestrateParallel(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'agents:invoke'))) {
    return;
  }

  const raw = ctx.payload as
    | { config?: { id?: string; tasks?: Array<{ agentId: string; task: string; input?: unknown }>; combineStrategy?: 'array' | 'merge' | 'first' | 'custom' } }
    | ParallelExecution;
  // Web Agents API sends { config: { tasks, combineStrategy }, origin }; Harbor pages send execution directly.
  const execution: ParallelExecution =
    raw && typeof raw === 'object' && 'config' in raw && raw.config != null
      ? {
          id: raw.config.id ?? `exec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          tasks: Array.isArray(raw.config.tasks) ? raw.config.tasks : [],
          combineStrategy: raw.config.combineStrategy ?? 'array',
        }
      : (raw as ParallelExecution);

  if (!Array.isArray(execution.tasks) || execution.tasks.length === 0) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INVALID_REQUEST', message: 'Missing parallel tasks' },
    });
    return;
  }

  const agentId = originAgents.get(ctx.origin);

  if (!agentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_NOT_REGISTERED', message: 'Must register as an agent first' },
    });
    return;
  }

  const result = await executeParallel(execution, agentId, ctx.origin);
  // Web Agents API / Margin expect { success, results, combined }; Harbor returns taskResults + combinedOutput.
  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: {
      ...result,
      results: result.taskResults.map((r) => r.result),
      combined: result.combinedOutput,
    },
  });
}

/**
 * Handle agents.orchestrate.route - Route to an agent based on input.
 */
export async function handleOrchestrateRoute(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'agents:invoke'))) {
    return;
  }

  const payload = ctx.payload as { router: AgentRouter; input: unknown; task: string };
  const agentId = originAgents.get(ctx.origin);

  if (!agentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_NOT_REGISTERED', message: 'Must register as an agent first' },
    });
    return;
  }

  const result = await executeRouter(payload.router, payload.input, payload.task, agentId, ctx.origin);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}

/**
 * Handle agents.orchestrate.supervisor - Execute tasks under supervision.
 */
export async function handleOrchestrateSupervisor(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'agents:invoke'))) {
    return;
  }

  const payload = ctx.payload as { supervisor: Supervisor; tasks: SupervisorTask[] };
  const agentId = originAgents.get(ctx.origin);

  if (!agentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_NOT_REGISTERED', message: 'Must register as an agent first' },
    });
    return;
  }

  const result = await executeSupervisor(payload.supervisor, payload.tasks, agentId, ctx.origin);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}

// =============================================================================
// Remote A2A Handlers
// =============================================================================

/**
 * Handle agents.remote.connect - Connect to a remote agent.
 */
export async function handleRemoteConnect(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'agents:remote'))) {
    return;
  }

  const payload = ctx.payload as RemoteAgentEndpoint;

  try {
    const agent = await connectRemoteAgent(payload);
    if (agent) {
      sender.sendResponse({
        id: ctx.id,
        ok: true,
        result: {
          id: agent.id,
          name: agent.name,
          description: agent.description,
          capabilities: agent.capabilities,
          reachable: agent.reachable,
        },
      });
    } else {
      sender.sendResponse({
        id: ctx.id,
        ok: true,
        result: null,
      });
    }
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Connection failed',
      },
    });
  }
}

/**
 * Handle agents.remote.disconnect - Disconnect from a remote agent.
 */
export async function handleRemoteDisconnect(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const payload = ctx.payload as { agentId: string };
  const result = disconnectRemoteAgent(payload.agentId);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}

/**
 * Handle agents.remote.list - List connected remote agents.
 */
export async function handleRemoteList(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const agents = listRemoteAgents();
  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: agents.map(a => ({
      id: a.id,
      name: a.name,
      description: a.description,
      capabilities: a.capabilities,
      url: a.endpoint.url,
      reachable: a.reachable,
      lastPing: a.lastPing,
    })),
  });
}

/**
 * Handle agents.remote.ping - Ping a remote agent.
 */
export async function handleRemotePing(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const payload = ctx.payload as { agentId: string };
  const result = await pingRemoteAgent(payload.agentId);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}

/**
 * Handle agents.remote.discover - Discover remote agents at a URL.
 */
export async function handleRemoteDiscover(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'agents:remote'))) {
    return;
  }

  const payload = ctx.payload as { baseUrl: string };

  try {
    const agents = await discoverRemoteAgents(payload.baseUrl);
    sender.sendResponse({ id: ctx.id, ok: true, result: agents });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Discovery failed',
      },
    });
  }
}

// Export originAgents for use by other handlers if needed
export { originAgents };
