/**
 * Agent Messaging
 * 
 * Handles inter-agent communication for Extension 3.
 * 
 * Supports:
 * - Direct messages between agents
 * - Request/response pattern
 * - Event broadcasting
 * - Cross-origin messaging (with permission)
 */

import type {
  AgentId,
  AgentMessage,
  AgentInvocationRequest,
  AgentInvocationResponse,
  AgentEvent,
  AgentProvenance,
  RegisteredAgent,
} from './types';
import {
  getAgent,
  touchAgent,
  recordMessageSent,
  recordInvocationMade,
  recordInvocationReceived,
} from './registry';

// Message handlers registered by agents
type MessageHandler = (message: AgentMessage) => void;
type InvocationHandler = (request: AgentInvocationRequest, fromAgentId: AgentId, traceId?: string) => Promise<AgentInvocationResponse>;
type EventHandler = (event: AgentEvent) => void;

const messageHandlers = new Map<AgentId, MessageHandler>();
const invocationHandlers = new Map<AgentId, InvocationHandler>();
const eventSubscriptions = new Map<string, Set<AgentId>>(); // eventType -> agentIds

// Pending invocations waiting for response
interface PendingInvocation {
  resolve: (response: AgentInvocationResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingInvocations = new Map<string, PendingInvocation>();

// Message ID counter
let messageIdCounter = 0;

function generateMessageId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`;
}

// =============================================================================
// Message Handlers Registration
// =============================================================================

/**
 * Register a message handler for an agent.
 */
export function registerMessageHandler(agentId: AgentId, handler: MessageHandler): void {
  messageHandlers.set(agentId, handler);
}

/**
 * Unregister a message handler.
 */
export function unregisterMessageHandler(agentId: AgentId): void {
  messageHandlers.delete(agentId);
}

/**
 * Register an invocation handler for an agent.
 */
export function registerInvocationHandler(agentId: AgentId, handler: InvocationHandler): void {
  invocationHandlers.set(agentId, handler);
}

/**
 * Unregister an invocation handler.
 */
export function unregisterInvocationHandler(agentId: AgentId): void {
  invocationHandlers.delete(agentId);
}

/**
 * Subscribe an agent to an event type.
 */
export function subscribeToEvent(agentId: AgentId, eventType: string): void {
  if (!eventSubscriptions.has(eventType)) {
    eventSubscriptions.set(eventType, new Set());
  }
  eventSubscriptions.get(eventType)!.add(agentId);
}

/**
 * Unsubscribe an agent from an event type.
 */
export function unsubscribeFromEvent(agentId: AgentId, eventType: string): void {
  eventSubscriptions.get(eventType)?.delete(agentId);
}

/**
 * Unsubscribe an agent from all events.
 */
export function unsubscribeFromAllEvents(agentId: AgentId): void {
  for (const subscribers of eventSubscriptions.values()) {
    subscribers.delete(agentId);
  }
}

// =============================================================================
// Messaging
// =============================================================================

/**
 * Which site's agent sent an answer, from Harbor's registry. Always set by
 * Harbor, after anything the agent returned, so an agent can't claim another
 * site's provenance.
 */
function provenanceOf(agent: RegisteredAgent): AgentProvenance {
  return { source: 'agent', origin: agent.origin, agentId: agent.id };
}

/**
 * Send a message from one agent to another. No permission check here: the
 * caller (`handleAgentsSend`) checks a cross-origin recipient's site first.
 */
export async function sendMessage(
  fromAgentId: AgentId,
  toAgentId: AgentId,
  payload: unknown,
): Promise<{ delivered: boolean; error?: string }> {
  const fromAgent = getAgent(fromAgentId);
  const toAgent = getAgent(toAgentId);

  if (!fromAgent) {
    return { delivered: false, error: 'Sender agent not found' };
  }

  if (!toAgent) {
    return { delivered: false, error: 'Recipient agent not found' };
  }

  // Check if recipient accepts messages
  if (!toAgent.acceptsMessages) {
    return { delivered: false, error: 'Recipient does not accept messages' };
  }

  const message: AgentMessage = {
    id: generateMessageId(),
    from: fromAgentId,
    to: toAgentId,
    type: 'event',
    payload,
    timestamp: Date.now(),
    provenance: provenanceOf(fromAgent),
  };

  const handler = messageHandlers.get(toAgentId);
  if (handler) {
    try {
      handler(message);
      recordMessageSent(fromAgentId);
      touchAgent(toAgentId);
      return { delivered: true };
    } catch (error) {
      return { delivered: false, error: error instanceof Error ? error.message : 'Handler error' };
    }
  }

  return { delivered: false, error: 'No handler registered for recipient' };
}

/**
 * Invoke another agent with a task.
 *
 * This does not check permission. Every caller checks the target first:
 * `handleAgentsInvoke` for a direct invoke, and the orchestration step gate
 * for pipeline, parallel, route and supervisor steps.
 */
export async function invokeAgent(
  request: AgentInvocationRequest,
  fromAgentId: AgentId,
  traceId?: string,
): Promise<AgentInvocationResponse> {
  const trace = traceId || 'no-trace';
  const startTime = Date.now();
  const fromAgent = getAgent(fromAgentId);
  const toAgent = getAgent(request.agentId);
  
  console.log(`[TRACE ${trace}] invokeAgent START - from: ${fromAgentId}, to: ${request.agentId}`);

  if (!fromAgent) {
    return {
      success: false,
      error: { code: 'ERR_AGENT_NOT_FOUND', message: 'Invoker agent not found' },
      executionTime: Date.now() - startTime,
    };
  }

  if (!toAgent) {
    return {
      success: false,
      error: { code: 'ERR_AGENT_NOT_FOUND', message: 'Target agent not found' },
      executionTime: Date.now() - startTime,
    };
  }

  // Check if target accepts invocations
  if (!toAgent.acceptsInvocations) {
    return {
      success: false,
      error: { code: 'ERR_NOT_ACCEPTED', message: 'Target agent does not accept invocations' },
      executionTime: Date.now() - startTime,
    };
  }

  const handler = invocationHandlers.get(request.agentId);
  if (!handler) {
    console.log(`[TRACE ${trace}] ERROR - no handler for ${request.agentId}`);
    return {
      success: false,
      error: { code: 'ERR_NO_HANDLER', message: 'Target agent has no invocation handler' },
      executionTime: Date.now() - startTime,
    };
  }

  console.log(`[TRACE ${trace}] Found handler, calling it...`);
  recordInvocationMade(fromAgentId);
  recordInvocationReceived(request.agentId);

  // Execute with timeout
  const timeout = request.timeout || 30000;
  
  try {
    const result = await Promise.race([
      handler(request, fromAgentId, trace),
      new Promise<AgentInvocationResponse>((_, reject) => {
        setTimeout(() => reject(new Error('Invocation timeout')), timeout);
      }),
    ]);
    console.log(`[TRACE ${trace}] Handler returned, success: ${result.success}`);

    return {
      ...result,
      executionTime: Date.now() - startTime,
      provenance: provenanceOf(toAgent),
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'ERR_INVOCATION_FAILED',
        message: error instanceof Error ? error.message : 'Invocation failed',
      },
      executionTime: Date.now() - startTime,
    };
  }
}

// =============================================================================
// Cleanup
// =============================================================================

/**
 * Deliver an event to every agent subscribed to `eventType` whose site
 * `canReachSite` accepts. No permission check here beyond that filter: the
 * caller (`handleAgentsBroadcast`) decides which sites the sender may reach.
 */
export function broadcastEvent(
  sourceAgentId: AgentId,
  eventType: string,
  data: unknown,
  canReachSite: (site: string) => boolean,
): { delivered: number; failed: number } {
  const subscribers = eventSubscriptions.get(eventType);
  if (!subscribers || subscribers.size === 0) {
    return { delivered: 0, failed: 0 };
  }

  const sourceAgent = getAgent(sourceAgentId);
  const event: AgentEvent = {
    type: eventType,
    data,
    source: sourceAgentId,
    timestamp: Date.now(),
    ...(sourceAgent ? { provenance: provenanceOf(sourceAgent) } : {}),
  };

  let delivered = 0;
  let failed = 0;

  for (const subscriberId of subscribers) {
    if (subscriberId === sourceAgentId) continue;
    const subscriber = getAgent(subscriberId);
    if (!subscriber || !canReachSite(subscriber.origin)) continue;

    const handler = messageHandlers.get(subscriberId);
    if (!handler) continue;
    try {
      handler({
        id: generateMessageId(),
        from: sourceAgentId,
        to: subscriberId,
        type: 'broadcast',
        payload: { type: event.type, data: event.data, source: event.source, provenance: event.provenance },
        timestamp: Date.now(),
      });
      delivered++;
    } catch {
      failed++;
    }
  }

  return { delivered, failed };
}

/**
 * Clean up all handlers for an agent.
 */
export function cleanupAgentHandlers(agentId: AgentId): void {
  unregisterMessageHandler(agentId);
  unregisterInvocationHandler(agentId);
  unsubscribeFromAllEvents(agentId);
}
