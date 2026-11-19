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
import { log, requireAction, checkAction } from './helpers';
import { getPermissionStatus, isAgentOriginAllowed } from '../../policy/permissions';
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
  broadcastEvent,
  unsubscribeFromEvent,
} from '../../multi-agent/messaging';
import {
  executePipeline,
  executeParallel,
  executeRouter,
  executeSupervisor,
  type StepGate,
} from '../../multi-agent/orchestration';
import {
  connectRemoteAgent,
  disconnectRemoteAgent,
  listRemoteAgents,
  pingRemoteAgent,
  discoverRemoteAgents,
} from '../../multi-agent/remote';
// Harbor's agents/ code may import from page-api (the reverse direction is
// an import-boundary violation; see page-api/__tests__/import-boundary.test.ts).
// A handler registered by Harbor's own in-process page API is delivered by
// calling straight into its `handleIncomingInvocation`, instead of crossing
// an extension boundary that no longer exists for that handler.
import { handleIncomingInvocation } from '../../page-api/handlers/agent-handlers';

// =============================================================================
// State Management
// =============================================================================

// Track which agent each origin has registered (origin -> agentId)
const originAgents = new Map<string, string>();

// Track which agents have an invocation handler registered through Harbor's
// own in-process page API, and where to deliver an invocation (origin/tab).
const invocationHandlers = new Map<string, {
  origin: string;
  tabId?: number;
}>();

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
  if (!(await requireAction(ctx, sender, 'agent.register', { promptAsScope: 'agents:register' }))) {
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
  if (!(await requireAction(ctx, sender, 'agent.register', { promptAsScope: 'agents:register' }))) {
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

  // Only return info if same origin, or the origin may reach the agent's site
  if (agent.origin !== ctx.origin && !(await isAgentOriginAllowed(ctx.origin, agent.origin, ctx.tabId))) {
    sender.sendResponse({ id: ctx.id, ok: true, result: null });
    return;
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
  if (!(await requireAction(ctx, sender, 'agent.discover', { promptAsScope: 'agents:discover' }))) {
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

  // Cross-origin agents are listed only on sites the origin may already
  // reach, so discovery can't reveal which other sites have agents.
  const reachable = payload?.includeCrossOrigin
    ? new Set((await getPermissionStatus(ctx.origin, ctx.tabId)).agentOrigins ?? [])
    : new Set<string>();

  const agents = discoverAgents(ctx.origin, payload || {}, (site) => reachable.has(site));

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
  const payload = ctx.payload as {
    agentId: string;
    task: string;
    input?: unknown;
    timeout?: number;
    traceId?: string;
  };

  // The target agent's origin determines whether this is a same-origin or
  // cross-origin invoke. Cross-origin gets the stricter
  // `agent.delegate.crossOrigin` action; same-origin uses `agent.invoke`.
  const targetAgent = getAgent(payload.agentId);
  const isCrossOrigin = targetAgent && targetAgent.origin !== ctx.origin;
  const action = isCrossOrigin ? 'agent.delegate.crossOrigin' : 'agent.invoke';
  const promptScope = isCrossOrigin ? 'agents:crossOrigin' : 'agents:invoke';
  if (!(await requireAction(ctx, sender, action, {
    promptAsScope: promptScope,
    resource: targetAgent ? { server: targetAgent.id, agentOrigin: targetAgent.origin } : undefined,
    reason: `Invoke agent ${payload.agentId}: ${payload.task}`,
  }))) {
    return;
  }

  const traceId = payload.traceId || `harbor-trace-${Date.now()}`;
  log(`[TRACE ${traceId}] handleAgentsInvoke START - target: ${payload.agentId}`);

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
  if (!(await requireAction(ctx, sender, 'agent.message', { promptAsScope: 'agents:message' }))) {
    return;
  }

  const payload = ctx.payload as { agentId: string; payload: unknown };

  // A message to another site's agent needs a grant for that site, as an
  // invoke does.
  const recipient = getAgent(payload.agentId);
  if (recipient && recipient.origin !== ctx.origin) {
    if (!(await requireAction(ctx, sender, 'agent.delegate.crossOrigin', {
      promptAsScope: 'agents:crossOrigin',
      resource: { server: recipient.id, agentOrigin: recipient.origin },
      reason: `Send a message to agent ${recipient.id}`,
    }))) {
      return;
    }
  }

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

  const result = await sendAgentMessage(fromAgentId, payload.agentId, payload.payload);

  sender.sendResponse({ id: ctx.id, ok: true, result });
}

/**
 * Handle agents.subscribe - Subscribe to an event type.
 */
export async function handleAgentsSubscribe(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requireAction(ctx, sender, 'agent.message', { promptAsScope: 'agents:message' }))) {
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
 * Handle agents.broadcast - Send an event to every subscribed agent the
 * sender may reach: agents on its own site, and on sites it holds an
 * agents:crossOrigin grant for. A broadcast has no single target to ask
 * about, so it never prompts.
 */
export async function handleAgentsBroadcast(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requireAction(ctx, sender, 'agent.message', { promptAsScope: 'agents:message' }))) {
    return;
  }

  const payload = ctx.payload as { eventType?: string; data?: unknown };
  const fromAgentId = originAgents.get(ctx.origin);
  if (!fromAgentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_NOT_REGISTERED', message: 'Must register as an agent before broadcasting' },
    });
    return;
  }
  if (!payload?.eventType) {
    sender.sendResponse({ id: ctx.id, ok: false, error: { code: 'ERR_INVALID_REQUEST', message: 'Missing eventType' } });
    return;
  }

  const reachable = new Set((await getPermissionStatus(ctx.origin, ctx.tabId)).agentOrigins ?? []);
  const result = broadcastEvent(fromAgentId, payload.eventType, payload.data, (site) => site === ctx.origin || reachable.has(site));

  sender.sendResponse({ id: ctx.id, ok: true, result: { delivered: result.delivered } });
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
  const payload = ctx.payload as { agentId?: string; tabId?: number } | undefined;
  const agentId = payload?.agentId || originAgents.get(ctx.origin);
  const agent = agentId ? getAgent(agentId) : undefined;
  // A page may only receive messages for its own site's agents.
  if (!agent || agent.origin !== ctx.origin) {
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
    return;
  }
  const tabId = payload?.tabId || ctx.tabId;

  // The actual handler is in the page: forward each message to its tab as an
  // agent event, which the content script hands to the page. Broadcasts
  // arrive as event messages and are delivered to the page's subscribers.
  registerMessageHandler(agent.id, (message) => {
    if (!tabId) return;
    const event =
      message.type === 'broadcast'
        ? { type: 'broadcast', broadcast: message.payload }
        : { type: 'message', message };
    browserAPI.tabs.sendMessage(tabId, { type: 'agentEvent', event }).catch(() => {});
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
  log('handleAgentsRegisterInvocationHandler called from', ctx.origin);

  const payload = ctx.payload as { agentId?: string; origin?: string; tabId?: number } | undefined;

  // If agentId is provided directly, use it; otherwise look up by origin
  // (for content script registrations).
  const agentId = payload?.agentId || originAgents.get(ctx.origin);

  log('Resolved agentId:', agentId, 'from payload.agentId:', payload?.agentId, 'or originAgents lookup');

  if (!agentId) {
    log('No agent found for invocation handler registration:', ctx.origin);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
    return;
  }

  const handlerOrigin = payload?.origin || ctx.origin;
  const handlerTabId = payload?.tabId || ctx.tabId;

  log('Registering invocation handler for', agentId, 'origin:', handlerOrigin, 'tabId:', handlerTabId);

  // Track where to deliver an invocation for this agent.
  invocationHandlers.set(agentId, { origin: handlerOrigin, tabId: handlerTabId });

  // Register a handler that delivers invocations to the registered handler,
  // in-process through Harbor's own page API. Every registration is local
  // now: there is no second extension to forward to.
  registerInvocationHandler(agentId, async (request, fromAgentId, traceId) => {
    const trace = traceId || 'no-trace';
    log(`[TRACE ${trace}] Proxy handler called for ${agentId}`);

    if (!invocationHandlers.has(agentId)) {
      log(`[TRACE ${trace}] ERROR - no invocation handler info`);
      return {
        success: false,
        error: { code: 'ERR_NO_EXTERNAL_HANDLER', message: 'Invocation handler not found' },
        executionTime: 0,
      };
    }

    const forwardRequest = {
      from: fromAgentId,
      task: request.task,
      input: request.input,
      timeout: request.timeout,
    };

    log(`[TRACE ${trace}] Delivering in-process via Harbor's own page API...`);
    const startTime = Date.now();
    try {
      const response = await handleIncomingInvocation(agentId, forwardRequest, trace);
      log(`[TRACE ${trace}] handleIncomingInvocation returned, success: ${response.success}`);
      return { ...response, executionTime: Date.now() - startTime };
    } catch (e) {
      log(`[TRACE ${trace}] handleIncomingInvocation ERROR: ${e instanceof Error ? e.message : 'Unknown'}`);
      return {
        success: false,
        error: { code: 'ERR_FORWARD_FAILED', message: e instanceof Error ? e.message : 'Delivery failed' },
        executionTime: Date.now() - startTime,
      };
    }
  });

  sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
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
 * The per-step check for an orchestration started by this request. Each
 * target is checked the way `handleAgentsInvoke` checks a direct invoke:
 * `agent.delegate.crossOrigin` for another origin's agent,
 * `agent.invoke` for one on the caller's own origin, scoped to that agent.
 *
 * Checks run one at a time, in the order the steps ask, so parallel tasks
 * and supervisor workers never stack prompts and each answer is in place
 * before the next target is checked.
 */
function orchestrationStepGate(ctx: RequestContext, label: string): StepGate {
  let queue: Promise<unknown> = Promise.resolve();
  return (targetAgentId) => {
    const check = queue.then(() => {
      const targetAgent = getAgent(targetAgentId);
      const isCrossOrigin = targetAgent !== undefined && targetAgent.origin !== ctx.origin;
      return checkAction(ctx, isCrossOrigin ? 'agent.delegate.crossOrigin' : 'agent.invoke', {
        promptAsScope: isCrossOrigin ? 'agents:crossOrigin' : 'agents:invoke',
        resource: targetAgent ? { server: targetAgent.id, agentOrigin: targetAgent.origin } : undefined,
        reason: `${label}: invoke agent ${targetAgentId}`,
      });
    });
    queue = check.catch(() => undefined);
    return check.then((denial) => (denial ? { code: denial.code, message: denial.message } : null));
  };
}

/**
 * Handle agents.orchestrate.pipeline - Execute a pipeline of agents.
 */
export async function handleOrchestratePipeline(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requireAction(ctx, sender, 'agent.invoke', { promptAsScope: 'agents:invoke' }))) {
    return;
  }

  // The page API sends { config: { steps: [{ agentId, task, outputTransform? }] }, initialInput },
  // and its handler has already rejected a pipeline with no steps.
  const payload = ctx.payload as {
    config: { steps: Array<{ agentId: string; task: string; outputTransform?: string }> };
    initialInput?: unknown;
  };

  const agentId = originAgents.get(ctx.origin);

  if (!agentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_NOT_REGISTERED', message: 'Must register as an agent first' },
    });
    return;
  }

  const pipelineId = `pipeline-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const pipeline: Pipeline = {
    id: pipelineId,
    name: pipelineId,
    steps: payload.config.steps.map((step, i) => ({
      id: `step-${i + 1}`,
      agentId: step.agentId,
      taskTemplate: step.task,
      outputTransform: step.outputTransform,
    })),
  };

  const result = await executePipeline(pipeline, payload.initialInput, agentId, orchestrationStepGate(ctx, 'Pipeline'));
  // The page API promises { success, result, stepResults }; Harbor calls the result finalOutput.
  sender.sendResponse({ id: ctx.id, ok: true, result: { ...result, result: result.finalOutput } });
}

/**
 * Handle agents.orchestrate.parallel - Execute agents in parallel.
 * Accepts either a direct ParallelExecution (Harbor page) or { config, origin } (Web Agents API).
 */
export async function handleOrchestrateParallel(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requireAction(ctx, sender, 'agent.invoke', { promptAsScope: 'agents:invoke' }))) {
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

  const result = await executeParallel(execution, agentId, orchestrationStepGate(ctx, 'Parallel'));
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
  if (!(await requireAction(ctx, sender, 'agent.invoke', { promptAsScope: 'agents:invoke' }))) {
    return;
  }

  // The page API sends { config: { routes, defaultAgentId? }, input, task },
  // and its handler has already rejected a router with no routes.
  const payload = ctx.payload as {
    config: { routes: Array<{ condition: string; agentId: string }>; defaultAgentId?: string };
    input?: unknown;
    task: string;
  };

  const agentId = originAgents.get(ctx.origin);

  if (!agentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_NOT_REGISTERED', message: 'Must register as an agent first' },
    });
    return;
  }

  const routerId = `router-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const router: AgentRouter = {
    id: routerId,
    name: routerId,
    routes: payload.config.routes,
    defaultAgentId: payload.config.defaultAgentId,
  };

  const result = await executeRouter(router, payload.input, payload.task, agentId, orchestrationStepGate(ctx, 'Route'));
  // The page API promises the chosen agent's invocation response ({ success, result?, error? });
  // the routing details stay alongside it.
  sender.sendResponse({ id: ctx.id, ok: true, result: { ...result, ...result.invocationResult } });
}

/**
 * Handle agents.orchestrate.supervisor - Execute tasks under supervision.
 */
export async function handleOrchestrateSupervisor(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requireAction(ctx, sender, 'agent.invoke', { promptAsScope: 'agents:invoke' }))) {
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

  const result = await executeSupervisor(payload.supervisor, payload.tasks, agentId, orchestrationStepGate(ctx, 'Supervisor'));
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
  const payload = ctx.payload as RemoteAgentEndpoint;
  let urlHost: string | undefined;
  try {
    urlHost = new URL(payload.url).hostname;
  } catch {
    urlHost = undefined;
  }
  if (!(await requireAction(ctx, sender, 'agent.delegate.remote', {
    promptAsScope: 'agents:remote',
    resource: urlHost ? { host: urlHost } : undefined,
    reason: `Connect to remote agent at ${payload.url}`,
  }))) {
    return;
  }

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
  const payload = ctx.payload as { baseUrl: string };
  let urlHost: string | undefined;
  try {
    urlHost = new URL(payload.baseUrl).hostname;
  } catch {
    urlHost = undefined;
  }
  if (!(await requireAction(ctx, sender, 'agent.delegate.remote', {
    promptAsScope: 'agents:remote',
    resource: urlHost ? { host: urlHost } : undefined,
    reason: `Discover agents at ${payload.baseUrl}`,
  }))) {
    return;
  }

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
