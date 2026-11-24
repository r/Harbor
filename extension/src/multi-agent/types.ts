/**
 * Multi-Agent Types
 * 
 * Type definitions for Extension 3: Multi-Agent Support
 */

import type { PermissionScope, PermissionGrant } from '../agents/types';

// =============================================================================
// Agent Identity
// =============================================================================

/**
 * Unique identifier for an agent
 */
export type AgentId = string;

/**
 * Agent status in its lifecycle
 */
export type AgentStatus = 'active' | 'suspended' | 'terminated';

/**
 * How the agent was created
 */
export type AgentType = 'page' | 'worker' | 'remote';

/**
 * Agent registration options provided by the web page
 */
export interface AgentRegistrationOptions {
  /** Human-readable name for the agent */
  name: string;
  /** Description of what the agent does */
  description?: string;
  /** Capabilities this agent provides to other agents */
  capabilities?: string[];
  /** Tags for discovery */
  tags?: string[];
  /** Whether this agent accepts invocations from other agents */
  acceptsInvocations?: boolean;
  /** Whether this agent accepts messages from other agents */
  acceptsMessages?: boolean;
}

/**
 * Registered agent information
 */
export interface RegisteredAgent {
  /** Unique agent ID */
  id: AgentId;
  /** Human-readable name */
  name: string;
  /** Description */
  description?: string;
  /** Agent type */
  type: AgentType;
  /** Current status */
  status: AgentStatus;
  /** Origin that registered the agent */
  origin: string;
  /** Tab ID (for page agents) */
  tabId?: number;
  /** Capabilities this agent provides */
  capabilities: string[];
  /** Tags for discovery */
  tags: string[];
  /** Whether this agent accepts invocations */
  acceptsInvocations: boolean;
  /** Whether this agent accepts messages */
  acceptsMessages: boolean;
  /** When the agent was registered */
  registeredAt: number;
  /** Last activity timestamp */
  lastActiveAt: number;
}

/**
 * Agent summary for discovery (less detailed than RegisteredAgent)
 */
export interface AgentSummary {
  id: AgentId;
  name: string;
  description?: string;
  origin: string;
  capabilities: string[];
  tags: string[];
  acceptsInvocations: boolean;
  acceptsMessages: boolean;
  /** Whether this is a same-origin agent */
  sameOrigin: boolean;
  /** Whether this is a remote agent */
  isRemote: boolean;
}

// =============================================================================
// Agent Communication
// =============================================================================

/**
 * Message between agents
 */
/**
 * Which site's agent produced an answer. Harbor sets it from its own
 * registry and overwrites anything the agent supplied, so the receiver can
 * judge how sensitive the answer is. See docs/rfds/provenance.md.
 */
export interface AgentProvenance {
  source: 'agent';
  /** The origin that registered the agent. */
  origin: string;
  agentId: AgentId;
}

export interface AgentMessage {
  /** Unique message ID */
  id: string;
  /** Sender agent ID */
  from: AgentId;
  /** Recipient agent ID */
  to: AgentId;
  /** Message type. A 'broadcast' carries `{ type, data, source }` for event subscribers. */
  type: 'request' | 'response' | 'event' | 'error' | 'broadcast';
  /** Message payload */
  payload: unknown;
  /** Correlation ID for request/response matching */
  correlationId?: string;
  /** Timestamp */
  timestamp: number;
  /** The sending agent's site. */
  provenance?: AgentProvenance;
}

/**
 * Invocation request to another agent
 */
export interface AgentInvocationRequest {
  /** Target agent ID */
  agentId: AgentId;
  /** Task description */
  task: string;
  /** Input data */
  input?: unknown;
  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * Invocation response from an agent
 */
export interface AgentInvocationResponse {
  /** Whether the invocation succeeded */
  success: boolean;
  /** Result data (if success) */
  result?: unknown;
  /** Error (if failure) */
  error?: {
    code: string;
    message: string;
  };
  /** Execution time in milliseconds */
  executionTime: number;
  /** The answering agent's site; absent when Harbor answered instead (not found, refused, timed out). */
  provenance?: AgentProvenance;
}

/**
 * Event emitted by an agent
 */
export interface AgentEvent {
  /** Event type */
  type: string;
  /** Event data */
  data: unknown;
  /** Source agent ID */
  source: AgentId;
  /** Timestamp */
  timestamp: number;
  /** The broadcasting agent's site. */
  provenance?: AgentProvenance;
}

// =============================================================================
// Permission Inheritance
// =============================================================================

/**
 * Effective permissions for an agent (bounded by invoker)
 */
export interface EffectivePermissions {
  /** Scopes that are granted */
  scopes: Record<PermissionScope, PermissionGrant>;
  /** Tools that are allowed */
  allowedTools: string[];
  /** Maximum token budget (inherited from invoker) */
  tokenBudget?: number;
  /** Maximum tool calls (inherited from invoker) */
  toolCallBudget?: number;
}

/**
 * Permission check result
 */
export interface PermissionCheckResult {
  /** Whether the permission is granted */
  granted: boolean;
  /** Reason if denied */
  reason?: string;
  /** The effective permissions after inheritance */
  effective?: EffectivePermissions;
}

// =============================================================================
// Resource Tracking
// =============================================================================

/**
 * Resource usage for an agent
 */
export interface AgentUsage {
  /** Agent ID */
  agentId: AgentId;
  /** Number of LLM prompts */
  promptCount: number;
  /** Estimated tokens used */
  tokensUsed: number;
  /** Number of tool calls */
  toolCallCount: number;
  /** Number of messages sent */
  messagesSent: number;
  /** Number of invocations made */
  invocationsMade: number;
  /** Number of invocations received */
  invocationsReceived: number;
  /** Session start time */
  startedAt: number;
  /** Last activity */
  lastActivityAt: number;
}

// =============================================================================
// Discovery
// =============================================================================

/**
 * Discovery query options
 */
export interface AgentDiscoveryQuery {
  /** Filter by name (partial match) */
  name?: string;
  /** Filter by capabilities */
  capabilities?: string[];
  /** Filter by tags */
  tags?: string[];
  /** Include same-origin agents */
  includeSameOrigin?: boolean;
  /** Include cross-origin agents (requires permission) */
  includeCrossOrigin?: boolean;
  /** Include remote agents (requires permission) */
  includeRemote?: boolean;
}

/**
 * Discovery result
 */
export interface AgentDiscoveryResult {
  /** Matching agents */
  agents: AgentSummary[];
  /** Total count (may be more than returned) */
  total: number;
  /** Whether more results are available */
  hasMore: boolean;
}

// =============================================================================
// Remote A2A Protocol
// =============================================================================

/**
 * Remote agent endpoint
 */
export interface RemoteAgentEndpoint {
  /** Endpoint URL */
  url: string;
  /** Protocol version */
  version: string;
  /** Authentication method */
  auth?: 'none' | 'bearer' | 'api-key';
}

/**
 * Remote agent info (from A2A protocol)
 */
export interface RemoteAgentInfo {
  /** Agent ID */
  id: AgentId;
  /** Name */
  name: string;
  /** Description */
  description?: string;
  /** Capabilities */
  capabilities: string[];
  /** Endpoint */
  endpoint: RemoteAgentEndpoint;
  /** Whether the agent is reachable */
  reachable: boolean;
  /** Last ping time */
  lastPing?: number;
}

// =============================================================================
// Orchestration
// =============================================================================

/**
 * Orchestration pattern type
 */
export type OrchestrationPattern = 'pipeline' | 'parallel' | 'router' | 'supervisor' | 'custom';

/**
 * Pipeline step
 */
export interface PipelineStep {
  /** Step ID */
  id: string;
  /** Agent to invoke */
  agentId: AgentId;
  /** Task template (can include {{input}} placeholder) */
  taskTemplate: string;
  /** Transform output before passing to next step */
  outputTransform?: string;
}

/**
 * Pipeline definition
 */
export interface Pipeline {
  /** Pipeline ID */
  id: string;
  /** Pipeline name */
  name: string;
  /** Steps in order */
  steps: PipelineStep[];
}

/**
 * Parallel execution definition
 */
export interface ParallelExecution {
  /** Execution ID */
  id: string;
  /** Tasks to run in parallel */
  tasks: Array<{
    agentId: AgentId;
    task: string;
    input?: unknown;
  }>;
  /** How to combine results */
  combineStrategy: 'array' | 'merge' | 'first' | 'custom';
}

/**
 * Router definition
 */
export interface AgentRouter {
  /** Router ID */
  id: string;
  /** Router name */
  name: string;
  /** Routes based on input */
  routes: Array<{
    /** Condition (evaluated against input) */
    condition: string;
    /** Target agent */
    agentId: AgentId;
  }>;
  /** Default agent if no route matches */
  defaultAgentId?: AgentId;
}

// =============================================================================
// Supervisor Pattern
// =============================================================================

/**
 * Assignment strategy for distributing tasks to workers
 */
export type SupervisorAssignmentStrategy =
  | 'round-robin'      // Cycle through workers
  | 'random'           // Random selection
  | 'least-busy'       // Select worker with fewest active tasks
  | 'capability-match'; // Match task requirements to worker capabilities

/**
 * Supervisor configuration
 */
export interface Supervisor {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Worker agents in the pool */
  workers: AgentId[];
  /** How to assign tasks to workers */
  assignmentStrategy: SupervisorAssignmentStrategy;
  /** Max concurrent tasks per worker (default: 1) */
  maxConcurrentPerWorker?: number;
  /** Retry configuration */
  retry?: {
    /** Max retry attempts per task (default: 0 = no retries) */
    maxAttempts: number;
    /** Delay between retries in ms (default: 1000) */
    delayMs: number;
    /** Whether to try a different worker on failure (default: true) */
    reassignOnFailure: boolean;
  };
  /** How to aggregate results from all tasks */
  aggregation: 'array' | 'merge' | 'custom';
}

/**
 * Task for supervisor to manage
 */
export interface SupervisorTask {
  /** Unique task identifier */
  id: string;
  /** Task description */
  task: string;
  /** Input data for the task */
  input?: unknown;
  /** Required capabilities (for capability-match strategy) */
  requiredCapabilities?: string[];
  /** Priority (higher = more urgent, default: 0) */
  priority?: number;
}

/**
 * Individual task result within supervisor execution
 */
export interface SupervisorTaskResult {
  /** Task ID */
  taskId: string;
  /** Worker that executed the task */
  workerId: AgentId;
  /** Result data (if successful) */
  result?: unknown;
  /** Error message (if failed) */
  error?: string;
  /** Number of attempts made */
  attempts: number;
  /** Execution time in milliseconds */
  executionTime: number;
  /** The site of the worker that answered last. */
  provenance?: AgentProvenance;
}

/**
 * Result of supervisor execution
 */
export interface SupervisorResult {
  /** Whether all tasks completed successfully */
  success: boolean;
  /** Individual task results */
  results: SupervisorTaskResult[];
  /** Execution statistics */
  stats: {
    /** Total tasks submitted */
    totalTasks: number;
    /** Tasks that succeeded */
    succeeded: number;
    /** Tasks that failed */
    failed: number;
    /** Total execution time in milliseconds */
    totalTime: number;
  };
}

/**
 * Options for creating a simple supervisor
 */
export interface CreateSupervisorOptions {
  /** Supervisor name */
  name: string;
  /** Worker agent IDs */
  workers: AgentId[];
  /** Assignment strategy (default: round-robin) */
  strategy?: SupervisorAssignmentStrategy;
  /** Max retries per task (default: 0) */
  maxRetries?: number;
}

// =============================================================================
// Message Types (for transport)
// =============================================================================

export type MultiAgentMessageType =
  // Registration
  | 'agents.register'
  | 'agents.unregister'
  | 'agents.getInfo'
  // Discovery
  | 'agents.discover'
  | 'agents.list'
  // Communication
  | 'agents.invoke'
  | 'agents.send'
  | 'agents.subscribe'
  | 'agents.broadcast'
  | 'agents.unsubscribe'
  // Remote
  | 'agents.remote.connect'
  | 'agents.remote.disconnect'
  | 'agents.remote.list'
  // Orchestration
  | 'agents.orchestrate.pipeline'
  | 'agents.orchestrate.parallel'
  | 'agents.orchestrate.route'
  | 'agents.orchestrate.supervisor';
