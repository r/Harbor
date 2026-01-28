/**
 * Agent Registry
 * 
 * Manages ephemeral agent registration for Extension 3.
 * 
 * Key concepts:
 * - Agents are ephemeral: tied to page lifecycle, destroyed on reload
 * - Each agent has a unique ID generated at registration
 * - Agents can be discovered by other agents (with permission)
 * - Cross-origin discovery requires agents:crossOrigin permission
 */

import { browserAPI } from '../browser-compat';
import type {
  AgentId,
  RegisteredAgent,
  AgentRegistrationOptions,
  AgentSummary,
  AgentStatus,
  AgentUsage,
} from './types';

// In-memory registry (ephemeral - cleared on extension reload)
const agents = new Map<AgentId, RegisteredAgent>();

// Index by origin for quick lookup
const agentsByOrigin = new Map<string, Set<AgentId>>();

// Index by tab for cleanup on tab close
const agentsByTab = new Map<number, Set<AgentId>>();

// Usage tracking
const agentUsage = new Map<AgentId, AgentUsage>();

// Agent ID counter
let agentIdCounter = 0;

/**
 * Generate a unique agent ID
 */
function generateAgentId(): AgentId {
  return `agent-${Date.now()}-${++agentIdCounter}`;
}

/**
 * Register a new agent.
 */
export function registerAgent(
  options: AgentRegistrationOptions,
  origin: string,
  tabId?: number,
): RegisteredAgent {
  const id = generateAgentId();
  const now = Date.now();

  const agent: RegisteredAgent = {
    id,
    name: options.name,
    description: options.description,
    type: 'page',
    status: 'active',
    origin,
    tabId,
    capabilities: options.capabilities || [],
    tags: options.tags || [],
    acceptsInvocations: options.acceptsInvocations ?? true,
    acceptsMessages: options.acceptsMessages ?? true,
    registeredAt: now,
    lastActiveAt: now,
  };

  agents.set(id, agent);

  // Index by origin
  if (!agentsByOrigin.has(origin)) {
    agentsByOrigin.set(origin, new Set());
  }
  agentsByOrigin.get(origin)!.add(id);

  // Index by tab
  if (tabId !== undefined) {
    if (!agentsByTab.has(tabId)) {
      agentsByTab.set(tabId, new Set());
    }
    agentsByTab.get(tabId)!.add(id);
  }

  // Initialize usage tracking
  agentUsage.set(id, {
    agentId: id,
    promptCount: 0,
    tokensUsed: 0,
    toolCallCount: 0,
    messagesSent: 0,
    invocationsMade: 0,
    invocationsReceived: 0,
    startedAt: now,
    lastActivityAt: now,
  });

  console.log('[AgentRegistry] Registered agent:', id, 'name:', options.name, 'origin:', origin);

  return agent;
}

/**
 * Unregister an agent.
 */
export function unregisterAgent(agentId: AgentId, origin: string): boolean {
  const agent = agents.get(agentId);
  
  if (!agent) {
    return false;
  }

  // Only the origin that registered can unregister
  if (agent.origin !== origin) {
    return false;
  }

  agents.delete(agentId);
  agentsByOrigin.get(origin)?.delete(agentId);
  
  if (agent.tabId !== undefined) {
    agentsByTab.get(agent.tabId)?.delete(agentId);
  }

  agentUsage.delete(agentId);

  console.log('[AgentRegistry] Unregistered agent:', agentId);

  return true;
}

/**
 * Get an agent by ID.
 */
export function getAgent(agentId: AgentId): RegisteredAgent | undefined {
  return agents.get(agentId);
}

/**
 * Get all agents for an origin.
 */
export function getAgentsByOrigin(origin: string): RegisteredAgent[] {
  const ids = agentsByOrigin.get(origin);
  if (!ids) return [];
  
  return Array.from(ids)
    .map(id => agents.get(id))
    .filter((a): a is RegisteredAgent => a !== undefined);
}

/**
 * Update agent status.
 */
export function updateAgentStatus(agentId: AgentId, status: AgentStatus): boolean {
  const agent = agents.get(agentId);
  if (!agent) return false;

  agent.status = status;
  agent.lastActiveAt = Date.now();

  return true;
}

/**
 * Update agent last active timestamp.
 */
export function touchAgent(agentId: AgentId): void {
  const agent = agents.get(agentId);
  if (agent) {
    agent.lastActiveAt = Date.now();
  }

  const usage = agentUsage.get(agentId);
  if (usage) {
    usage.lastActivityAt = Date.now();
  }
}

/**
 * Clean up all agents for a tab (called when tab is closed/reloaded).
 */
export function cleanupTabAgents(tabId: number): void {
  const ids = agentsByTab.get(tabId);
  if (!ids) return;

  for (const id of ids) {
    const agent = agents.get(id);
    if (agent) {
      agents.delete(id);
      agentsByOrigin.get(agent.origin)?.delete(id);
      agentUsage.delete(id);
    }
  }

  agentsByTab.delete(tabId);
  console.log('[AgentRegistry] Cleaned up agents for tab:', tabId);
}

/**
 * Clean up all agents for an origin.
 */
export function cleanupOriginAgents(origin: string): void {
  const ids = agentsByOrigin.get(origin);
  if (!ids) return;

  for (const id of ids) {
    const agent = agents.get(id);
    if (agent) {
      agents.delete(id);
      if (agent.tabId !== undefined) {
        agentsByTab.get(agent.tabId)?.delete(id);
      }
      agentUsage.delete(id);
    }
  }

  agentsByOrigin.delete(origin);
  console.log('[AgentRegistry] Cleaned up agents for origin:', origin);
}

// =============================================================================
// Discovery
// =============================================================================

/**
 * Discover agents matching criteria.
 * 
 * @param queryOrigin - The origin making the query
 * @param options - Discovery options
 * @param allowCrossOrigin - Whether cross-origin discovery is allowed
 */
export function discoverAgents(
  queryOrigin: string,
  options: {
    name?: string;
    capabilities?: string[];
    tags?: string[];
    includeSameOrigin?: boolean;
    includeCrossOrigin?: boolean;
  },
  allowCrossOrigin: boolean,
): AgentSummary[] {
  const results: AgentSummary[] = [];

  for (const agent of agents.values()) {
    // Skip inactive agents
    if (agent.status !== 'active') continue;

    // Check origin permissions
    const sameOrigin = agent.origin === queryOrigin;
    
    if (!sameOrigin && !allowCrossOrigin) {
      continue;
    }

    if (sameOrigin && options.includeSameOrigin === false) {
      continue;
    }

    if (!sameOrigin && options.includeCrossOrigin === false) {
      continue;
    }

    // Apply filters
    if (options.name && !agent.name.toLowerCase().includes(options.name.toLowerCase())) {
      continue;
    }

    if (options.capabilities && options.capabilities.length > 0) {
      const hasCapability = options.capabilities.some(c => agent.capabilities.includes(c));
      if (!hasCapability) continue;
    }

    if (options.tags && options.tags.length > 0) {
      const hasTag = options.tags.some(t => agent.tags.includes(t));
      if (!hasTag) continue;
    }

    results.push({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      origin: agent.origin,
      capabilities: agent.capabilities,
      tags: agent.tags,
      acceptsInvocations: agent.acceptsInvocations,
      acceptsMessages: agent.acceptsMessages,
      sameOrigin,
      isRemote: false,
    });
  }

  return results;
}

/**
 * List all agents for an origin (for debugging/admin).
 */
export function listAllAgents(): RegisteredAgent[] {
  return Array.from(agents.values());
}

// =============================================================================
// Usage Tracking
// =============================================================================

/**
 * Get usage for an agent.
 */
export function getAgentUsage(agentId: AgentId): AgentUsage | undefined {
  return agentUsage.get(agentId);
}

/**
 * Record a prompt (LLM call).
 */
export function recordPrompt(agentId: AgentId, estimatedTokens?: number): void {
  const usage = agentUsage.get(agentId);
  if (usage) {
    usage.promptCount++;
    usage.tokensUsed += estimatedTokens || 0;
    usage.lastActivityAt = Date.now();
  }
  touchAgent(agentId);
}

/**
 * Record a tool call.
 */
export function recordToolCall(agentId: AgentId): void {
  const usage = agentUsage.get(agentId);
  if (usage) {
    usage.toolCallCount++;
    usage.lastActivityAt = Date.now();
  }
  touchAgent(agentId);
}

/**
 * Record a message sent.
 */
export function recordMessageSent(agentId: AgentId): void {
  const usage = agentUsage.get(agentId);
  if (usage) {
    usage.messagesSent++;
    usage.lastActivityAt = Date.now();
  }
  touchAgent(agentId);
}

/**
 * Record an invocation made.
 */
export function recordInvocationMade(agentId: AgentId): void {
  const usage = agentUsage.get(agentId);
  if (usage) {
    usage.invocationsMade++;
    usage.lastActivityAt = Date.now();
  }
  touchAgent(agentId);
}

/**
 * Record an invocation received.
 */
export function recordInvocationReceived(agentId: AgentId): void {
  const usage = agentUsage.get(agentId);
  if (usage) {
    usage.invocationsReceived++;
    usage.lastActivityAt = Date.now();
  }
  touchAgent(agentId);
}

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize the agent registry.
 * Sets up listeners for tab closure to clean up agents.
 */
export function initializeAgentRegistry(): void {
  // Clean up agents when tabs are closed
  browserAPI.tabs.onRemoved.addListener((tabId) => {
    cleanupTabAgents(tabId);
  });

  // Clean up agents when tabs are refreshed (navigated)
  browserAPI.webNavigation?.onCommitted?.addListener((details) => {
    // Only clean up on top-level navigation (not iframes)
    if (details.frameId === 0 && details.transitionType !== 'auto_subframe') {
      cleanupTabAgents(details.tabId);
    }
  });

  console.log('[AgentRegistry] Initialized');
}
