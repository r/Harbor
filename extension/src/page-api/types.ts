/**
 * Web Agents API Types
 * 
 * Type definitions for the Web Agents API.
 */

// =============================================================================
// Permission Types
// =============================================================================

export type PermissionScope =
  | 'model:prompt'              // Text generation
  | 'model:tools'               // Autonomous agent (model picks and calls tools)
  | 'model:list'                // List providers/models
  | 'mcp:tools.list'            // List available tools
  | 'mcp:tools.call'            // Execute tools
  | 'mcp:servers.register'      // Register a website-provided MCP server (BYOC)
  | 'browser:activeTab.read'    // Read page content
  | 'browser:activeTab.interact'// Click, fill, scroll
  | 'browser:activeTab.screenshot' // Take screenshots
  | 'browser:tabs.create'       // Create and control new tabs
  | 'browser:tabs.read'         // Read tab URLs/titles
  | 'browser:navigate'          // Navigate the active tab
  | 'web:fetch'                 // CORS-bypassing fetch via the extension
  | 'chat:open'                 // Open the user's chat surface
  | 'agents:register'           // Register this page as an agent
  | 'agents:discover'           // Discover other agents
  | 'agents:invoke'             // Invoke other agents
  | 'agents:message'            // Send messages / broadcasts to other agents
  | 'agents:crossOrigin';       // Reach agents on named other sites (agentOrigins)

export type PermissionGrantType =
  | 'granted-once'     // Valid for 10 minutes, tab-scoped
  | 'granted-always'   // Persistent until revoked
  | 'denied'           // User denied
  | 'not-granted';     // Never requested

export interface PermissionGrant {
  scope: PermissionScope;
  type: PermissionGrantType;
  expiresAt?: number;    // For granted-once
  grantedAt: number;
}

export interface PermissionStatus {
  scope: PermissionScope;
  status: PermissionGrantType;
}

export interface RequestPermissionsOptions {
  scopes: PermissionScope[];
  reason?: string;
  toolAllowlist?: string[];  // For mcp:tools.call
  agentOrigins?: string[];   // For agents:crossOrigin: the sites, e.g. "https://example.com"
}

export interface PermissionResult {
  granted: PermissionScope[];
  denied: PermissionScope[];
}

// =============================================================================
// LLM Types
// =============================================================================

export interface TextSessionOptions {
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface TextSession {
  sessionId: string;
  prompt(text: string): Promise<string>;
  promptStreaming(text: string): AsyncIterable<string>;
  destroy(): void;
}

export type Availability = 'readily' | 'after-download' | 'no';

export interface Capabilities {
  available: Availability;
  defaultTemperature?: number;
  maxTemperature?: number;
  defaultTopK?: number;
  maxTopK?: number;
}

export interface Provider {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  models?: string[];
}

// =============================================================================
// Tool Types
// =============================================================================

export interface ToolDescriptor {
  serverId: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface PageToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

export interface ToolCallOptions {
  tool: string;       // Format: "serverId/toolName" or just "toolName"
  args?: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

// =============================================================================
// Agent Session Types
// =============================================================================

/**
 * Session type - how was this session created?
 */
export type SessionType = 'implicit' | 'explicit';

/**
 * Session status.
 */
export type SessionStatus = 'active' | 'suspended' | 'terminated';

/**
 * Capabilities for LLM access in a session.
 */
export interface LLMCapabilities {
  allowed: boolean;
  provider?: string;
  model?: string;
}

/**
 * Capabilities for tool access in a session.
 */
export interface ToolCapabilities {
  allowed: boolean;
  allowedTools: string[];
}

/**
 * Capabilities for browser API access in a session.
 */
export interface BrowserCapabilities {
  readActiveTab: boolean;
  interact: boolean;
  screenshot: boolean;
}

/**
 * Session limits and budgets.
 */
export interface SessionLimits {
  maxToolCalls?: number;
  expiresAt?: number;
}

/**
 * Full capability set for a session.
 */
export interface SessionCapabilities {
  llm: LLMCapabilities;
  tools: ToolCapabilities;
  browser: BrowserCapabilities;
  limits?: SessionLimits;
}

/**
 * Session usage statistics.
 */
export interface SessionUsage {
  promptCount: number;
  toolCallCount: number;
  tokensUsed?: number;
}

/**
 * Summary of a session for listing/display.
 */
export interface SessionSummary {
  sessionId: string;
  type: SessionType;
  origin: string;
  status: SessionStatus;
  name?: string;
  createdAt: number;
  lastActiveAt: number;
  capabilities: {
    hasLLM: boolean;
    toolCount: number;
    hasBrowserAccess: boolean;
  };
  usage: SessionUsage;
}

/**
 * Options for creating an explicit session.
 */
export interface CreateSessionOptions {
  /** Human-readable name for display */
  name?: string;
  /** Reason for requesting these capabilities */
  reason?: string;
  /** Requested capabilities */
  capabilities: {
    llm?: {
      provider?: string;
      model?: string;
    };
    tools?: string[];
    browser?: ('read' | 'interact' | 'screenshot')[];
  };
  /** Session limits */
  limits?: {
    maxToolCalls?: number;
    ttlMinutes?: number;
  };
  /** Session options */
  options?: {
    systemPrompt?: string;
    temperature?: number;
  };
}

/**
 * Result of creating a session.
 */
export interface CreateSessionResult {
  success: boolean;
  sessionId?: string;
  capabilities?: SessionCapabilities;
  error?: {
    code: 'PERMISSION_DENIED' | 'ORIGIN_DENIED' | 'INVALID_REQUEST';
    message: string;
  };
}

/**
 * Agent session object returned to web pages.
 * This is the programmatic interface for interacting with a session.
 */
export interface AgentSessionHandle {
  readonly sessionId: string;
  readonly capabilities: SessionCapabilities;
  
  /** LLM operations (if llm.allowed) */
  prompt(input: string): Promise<string>;
  promptStreaming(input: string): AsyncIterable<string>;
  
  /** Tool operations (if tools.allowed) */
  callTool(tool: string, args?: Record<string, unknown>): Promise<unknown>;
  listAllowedTools(): string[];
  
  /** Session management */
  terminate(): Promise<void>;
}

// =============================================================================
// Message Types (internal)
// =============================================================================

export type MessageType =
  // Permission operations
  | 'request_permissions'
  | 'list_permissions'
  // AI operations
  | 'create_session'
  | 'session_prompt'
  | 'session_prompt_streaming'
  | 'session_destroy'
  | 'can_create_session'
  | 'get_capabilities'
  | 'list_providers'
  | 'get_active_provider'
  // Tool operations
  | 'list_tools'
  | 'call_tool'
  // Session operations
  | 'session_create_explicit'
  | 'session_get'
  | 'session_list'
  | 'session_terminate';

export interface TransportRequest {
  id: string;
  type: MessageType;
  payload: unknown;
}

export interface TransportResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: ApiError;
}

export interface TransportStreamEvent {
  id: string;
  event: StreamToken;
  done?: boolean;
}

export interface StreamToken {
  type: 'token' | 'done' | 'error';
  token?: string;
  error?: ApiError;
}

export interface ApiError {
  code: string;
  message: string;
}

/**
 * Harbor's one list of the error codes a page can see. Everything that sends
 * a page an error uses one of these; `error-codes-list.test.ts` fails if the
 * source emits an `ERR_*` code that isn't here.
 */
export const ErrorCodes = {
  NOT_INSTALLED: 'ERR_NOT_INSTALLED',
  PERMISSION_DENIED: 'ERR_PERMISSION_DENIED',
  SCOPE_REQUIRED: 'ERR_SCOPE_REQUIRED',
  FEATURE_DISABLED: 'ERR_FEATURE_DISABLED',
  TOOL_NOT_ALLOWED: 'ERR_TOOL_NOT_ALLOWED',
  TOOL_NOT_FOUND: 'ERR_TOOL_NOT_FOUND',
  TOOL_FAILED: 'ERR_TOOL_FAILED',
  TOOL_TIMEOUT: 'ERR_TOOL_TIMEOUT',
  MODEL_FAILED: 'ERR_MODEL_FAILED',
  SESSION_NOT_FOUND: 'ERR_SESSION_NOT_FOUND',
  BUDGET_EXCEEDED: 'ERR_BUDGET_EXCEEDED',
  HARBOR_NOT_FOUND: 'ERR_HARBOR_NOT_FOUND',
  TIMEOUT: 'ERR_TIMEOUT',
  INVALID_REQUEST: 'ERR_INVALID_REQUEST',
  ELEMENT_NOT_FOUND: 'ERR_ELEMENT_NOT_FOUND',
  AGENT_FAILED: 'ERR_AGENT_FAILED',
  ABORTED: 'ERR_ABORTED',
  HANDLER_FAILED: 'ERR_HANDLER_FAILED',
  INTERNAL: 'ERR_INTERNAL',
  AGENT_NOT_FOUND: 'ERR_AGENT_NOT_FOUND',
  AGENT_NOT_ACCEPTING: 'ERR_AGENT_NOT_ACCEPTING',
  AGENT_REFUSED: 'ERR_AGENT_REFUSED',
  AGENT_LIMIT: 'ERR_AGENT_LIMIT',
  /**
   * Too many ACP agents are already running — this site's own cap
   * (`PER_SITE_AGENT_LIMIT` in acp-agent-limits.ts) or the bridge's global
   * one (`agent_cap` on `acp.open`'s fatal error, bridge-rs/src/acp/mod.rs).
   * See docs/ACP_BACKEND_DESIGN.md sections 2 and 3.
   */
  AGENT_BUSY: 'ERR_AGENT_BUSY',
  NOT_IMPLEMENTED: 'ERR_NOT_IMPLEMENTED',

  // The policy engine's refusals (see POLICY_REFUSAL_CODES and
  // docs/PERMISSIONS.md).
  BLOCKED_BY_POLICY: 'ERR_BLOCKED_BY_POLICY',
  QUARANTINED: 'ERR_QUARANTINED',
  LABEL_FLOW_BLOCKED: 'ERR_LABEL_FLOW_BLOCKED',
  UNKNOWN_ACTION: 'ERR_UNKNOWN_ACTION',

  // Multi-agent registration, invocation and orchestration.
  NOT_REGISTERED: 'ERR_NOT_REGISTERED',
  NOT_ACCEPTED: 'ERR_NOT_ACCEPTED',
  NO_HANDLER: 'ERR_NO_HANDLER',
  NO_TAB: 'ERR_NO_TAB',
  NO_ROUTE: 'ERR_NO_ROUTE',
  INVOCATION_FAILED: 'ERR_INVOCATION_FAILED',
  FORWARD_FAILED: 'ERR_FORWARD_FAILED',
  SEND_FAILED: 'ERR_SEND_FAILED',
  FAILED: 'ERR_FAILED',

  // agent.chat and agent.mcp calls that failed for a reason other than policy.
  CHAT: 'ERR_CHAT',
  CHAT_OPEN: 'ERR_CHAT_OPEN',
  CHAT_CLOSE: 'ERR_CHAT_CLOSE',
  MCP_DISCOVER: 'ERR_MCP_DISCOVER',
  MCP_REGISTER: 'ERR_MCP_REGISTER',
  MCP_UNREGISTER: 'ERR_MCP_UNREGISTER',
} as const;

/** One of Harbor's error codes. */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// =============================================================================
// Multi-Agent Types
// =============================================================================

/**
 * Unique identifier for an agent.
 */
export type AgentId = string;

/**
 * Agent status.
 */
export type AgentStatus = 'active' | 'suspended' | 'terminated';

/**
 * Agent type - where the agent runs.
 */
export type AgentType = 'page' | 'worker' | 'remote';

/**
 * Options for registering an agent.
 */
export interface AgentRegisterOptions {
  /** Human-readable name for the agent */
  name: string;
  /** Description of what the agent does */
  description?: string;
  /** List of capabilities the agent provides */
  capabilities?: string[];
  /** Tags for discovery */
  tags?: string[];
  /** Whether the agent accepts invocations */
  acceptsInvocations?: boolean;
  /** Whether the agent accepts direct messages */
  acceptsMessages?: boolean;
}

/**
 * Registered agent information.
 */
export interface RegisteredAgent {
  id: AgentId;
  name: string;
  description?: string;
  capabilities: string[];
  tags: string[];
  status: AgentStatus;
  type: AgentType;
  origin: string;
  tabId?: number;
  acceptsInvocations: boolean;
  acceptsMessages: boolean;
  registeredAt: number;
  lastActiveAt: number;
}

/**
 * Summary of an agent for discovery (less detailed).
 */
export interface AgentSummary {
  id: AgentId;
  name: string;
  description?: string;
  capabilities: string[];
  tags: string[];
  status: AgentStatus;
  sameOrigin: boolean;
  isRemote: boolean;
}

/** Basic identity and lifecycle state of an agent on the calling origin. */
export type AgentListEntry = Pick<AgentSummary, 'id' | 'name' | 'status'>;

/**
 * Query options for discovering agents.
 */
export interface AgentDiscoveryQuery {
  /** Filter by name (substring match) */
  name?: string;
  /** Filter by capabilities (must have all) */
  capabilities?: string[];
  /** Filter by tags (must have any) */
  tags?: string[];
  /** Include same-origin agents (default: true) */
  includeSameOrigin?: boolean;
  /** Include cross-origin agents (default: false, requires permission) */
  includeCrossOrigin?: boolean;
}

/**
 * Result of agent discovery.
 */
export interface AgentDiscoveryResult {
  agents: AgentSummary[];
  total: number;
}

/**
 * Request to invoke an agent.
 */
export interface AgentInvocationRequest {
  /** The task or action to perform */
  task: string;
  /** Input data for the task */
  input?: unknown;
  /** Timeout in milliseconds (default: 30000, capped at 300000) */
  timeout?: number;
}

/**
 * Which site's agent produced an answer. Harbor sets it from its own
 * registry, never from the agent, so the receiver can judge how sensitive
 * the answer is.
 */
export interface AgentProvenance {
  source: 'agent';
  origin: string;
  agentId: AgentId;
}

/**
 * Response from invoking an agent.
 */
export interface AgentInvocationResponse {
  success: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
  executionTime?: number;
  /** Absent when Harbor answered instead of the agent (not found, refused, timed out). */
  provenance?: AgentProvenance;
}

/**
 * Message sent between agents.
 */
export interface AgentMessage {
  id: string;
  from: AgentId;
  to: AgentId;
  type: 'request' | 'response' | 'event' | 'error';
  payload: unknown;
  correlationId?: string;
  timestamp: number;
  provenance?: AgentProvenance;
}

/**
 * Event broadcast by an agent.
 */
export interface AgentEvent {
  type: string;
  data: unknown;
  source: AgentId;
  timestamp: number;
  provenance?: AgentProvenance;
}

/**
 * Pipeline step configuration.
 */
export interface PipelineStep {
  agentId: AgentId;
  task: string;
  inputTransform?: string;
  outputTransform?: string;
}

/**
 * Pipeline configuration.
 */
export interface PipelineConfig {
  steps: PipelineStep[];
}

/**
 * Parallel task configuration.
 */
export interface ParallelTask {
  agentId: AgentId;
  task: string;
  input?: unknown;
}

/**
 * Parallel execution configuration.
 */
export interface ParallelConfig {
  tasks: ParallelTask[];
  combineStrategy?: 'array' | 'merge' | 'first';
}

/**
 * Route configuration for routing.
 */
export interface RouteConfig {
  condition: string;
  agentId: AgentId;
}

/**
 * Router configuration.
 */
export interface RouterConfig {
  routes: RouteConfig[];
  defaultAgentId?: AgentId;
}
