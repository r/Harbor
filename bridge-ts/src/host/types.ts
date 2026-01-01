/**
 * MCP Host Types
 * 
 * Types for the MCP execution environment (Host) that manages
 * server connections, tool discovery, invocation, and policy.
 */

// =============================================================================
// Permission Types
// =============================================================================

/**
 * Permission grant types.
 */
export enum GrantType {
  /** Permission expires after TTL or tab close */
  ALLOW_ONCE = 'ALLOW_ONCE',
  /** Permission is persisted across sessions */
  ALLOW_ALWAYS = 'ALLOW_ALWAYS',
  /** Permission is explicitly denied */
  DENY = 'DENY',
}

/**
 * Permission scope identifiers.
 */
export enum PermissionScope {
  /** List available tools */
  TOOLS_LIST = 'mcp:tools.list',
  /** Call/invoke tools */
  TOOLS_CALL = 'mcp:tools.call',
  /** Connect to servers */
  SERVER_CONNECT = 'mcp:server.connect',
  /** Read active tab context */
  ACTIVE_TAB_READ = 'browser:activeTab.read',
}

/**
 * Origin identifier (scheme+host+port).
 */
export type Origin = string;

/**
 * Profile identifier (Firefox profile or extension storage namespace).
 */
export type ProfileId = string;

/**
 * A permission grant record.
 */
export interface PermissionGrant {
  /** The scope being granted/denied */
  scope: PermissionScope;
  /** Grant type */
  grantType: GrantType;
  /** When this grant was created */
  createdAt: number;
  /** When this grant expires (for ALLOW_ONCE) */
  expiresAt?: number;
  /** Tab ID that created this grant (for ALLOW_ONCE with tab-scoped expiry) */
  tabId?: number;
  /** Optional: specific tools allowed (if empty, all tools allowed) */
  allowedTools?: string[];
}

/**
 * Key for permission lookup.
 */
export interface PermissionKey {
  origin: Origin;
  profileId: ProfileId;
  scope: PermissionScope;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Standard error codes for the Host.
 */
export enum ErrorCode {
  /** Caller lacks required permission */
  PERMISSION_DENIED = 'ERR_PERMISSION_DENIED',
  /** Permission scope required but not granted */
  SCOPE_REQUIRED = 'ERR_SCOPE_REQUIRED',
  /** MCP server is not available/connected */
  SERVER_UNAVAILABLE = 'ERR_SERVER_UNAVAILABLE',
  /** Requested tool does not exist */
  TOOL_NOT_FOUND = 'ERR_TOOL_NOT_FOUND',
  /** Tool is not in the allowlist for this origin */
  TOOL_NOT_ALLOWED = 'ERR_TOOL_NOT_ALLOWED',
  /** Tool invocation timed out */
  TOOL_TIMEOUT = 'ERR_TOOL_TIMEOUT',
  /** Tool invocation failed (server returned error) */
  TOOL_FAILED = 'ERR_TOOL_FAILED',
  /** MCP protocol error */
  PROTOCOL_ERROR = 'ERR_PROTOCOL_ERROR',
  /** Internal host error */
  INTERNAL = 'ERR_INTERNAL',
  /** Rate limit exceeded */
  RATE_LIMITED = 'ERR_RATE_LIMITED',
  /** Budget exceeded (max calls per run) */
  BUDGET_EXCEEDED = 'ERR_BUDGET_EXCEEDED',
}

/**
 * Standard API error.
 */
export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/**
 * Create an ApiError.
 */
export function createError(code: ErrorCode, message: string, details?: unknown): ApiError {
  return { code, message, details };
}

// =============================================================================
// Tool Types
// =============================================================================

/**
 * Tool descriptor with provenance.
 */
export interface ToolDescriptor {
  /** Namespaced tool name: serverId/toolName */
  name: string;
  /** Human-readable description */
  description?: string;
  /** JSON Schema for input validation */
  inputSchema?: object;
  /** Server that provides this tool */
  serverId: string;
  /** Human-readable server label */
  serverLabel: string;
  /** Original tool name (without namespace) */
  originalName: string;
}

/**
 * Tool invocation result.
 */
export interface ToolResult {
  ok: true;
  result: unknown;
  provenance: {
    serverId: string;
    toolName: string;
  };
}

/**
 * Tool invocation failure.
 */
export interface ToolError {
  ok: false;
  error: ApiError;
}

/**
 * Tool call outcome.
 */
export type ToolCallResult = ToolResult | ToolError;

// =============================================================================
// Rate Limiting & Budgets
// =============================================================================

/**
 * Rate limit configuration.
 */
export interface RateLimitConfig {
  /** Max tool calls per run/session */
  maxCallsPerRun: number;
  /** Max concurrent tool calls per origin */
  maxConcurrentPerOrigin: number;
  /** Default timeout per tool call (ms) */
  defaultTimeoutMs: number;
}

/**
 * Default rate limits.
 */
export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  maxCallsPerRun: 5,
  maxConcurrentPerOrigin: 2,
  defaultTimeoutMs: 30_000,
};

/**
 * Budget tracking for a run.
 */
export interface RunBudget {
  /** Unique run ID */
  runId: string;
  /** Origin for this run */
  origin: Origin;
  /** Max calls allowed */
  maxCalls: number;
  /** Calls made so far */
  callsMade: number;
  /** Currently active calls */
  activeCalls: number;
  /** When run started */
  startedAt: number;
}

// =============================================================================
// Server Configuration
// =============================================================================

/**
 * MCP server configuration record.
 */
export interface ServerConfig {
  /** Stable server ID */
  serverId: string;
  /** Human-readable label */
  label: string;
  /** Command to execute */
  command: string;
  /** Command arguments */
  args: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
  /** Transport type (stdio for MVP) */
  transport: 'stdio' | 'http';
  /** Per-tool timeout overrides */
  toolTimeouts?: Record<string, number>;
}

/**
 * Server connection state.
 */
export enum ServerState {
  STOPPED = 'stopped',
  STARTING = 'starting',
  RUNNING = 'running',
  CRASHED = 'crashed',
  RESTARTING = 'restarting',
}

/**
 * Server status with health info.
 */
export interface ServerStatus {
  serverId: string;
  label: string;
  state: ServerState;
  /** Number of restart attempts */
  restartCount: number;
  /** Last error if crashed */
  lastError?: string;
  /** When server started */
  startedAt?: number;
  /** Available tools (once discovered) */
  tools?: ToolDescriptor[];
}

// =============================================================================
// Agent Run Events (Optional MVP)
// =============================================================================

/**
 * Event types emitted during an agent run.
 */
export type RunEventType = 'status' | 'tool_call' | 'tool_result' | 'final' | 'error';

/**
 * Base run event.
 */
export interface RunEventBase {
  type: RunEventType;
  timestamp: number;
  runId: string;
}

/**
 * Status update event.
 */
export interface StatusEvent extends RunEventBase {
  type: 'status';
  message: string;
}

/**
 * Tool call initiated event.
 */
export interface ToolCallEvent extends RunEventBase {
  type: 'tool_call';
  toolName: string;
  args: unknown;
  callId: string;
}

/**
 * Tool result received event.
 */
export interface ToolResultEvent extends RunEventBase {
  type: 'tool_result';
  callId: string;
  result: ToolCallResult;
  durationMs: number;
}

/**
 * Run completed event.
 */
export interface FinalEvent extends RunEventBase {
  type: 'final';
  output: unknown;
  stats: {
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    totalDurationMs: number;
  };
}

/**
 * Run error event.
 */
export interface ErrorEvent extends RunEventBase {
  type: 'error';
  error: ApiError;
}

/**
 * Union of all run events.
 */
export type RunEvent = StatusEvent | ToolCallEvent | ToolResultEvent | FinalEvent | ErrorEvent;

// =============================================================================
// Host API Options
// =============================================================================

/**
 * Options for listTools.
 */
export interface ListToolsOptions {
  /** Only include tools from these servers */
  serverIds?: string[];
  /** Filter tools by name pattern */
  namePattern?: RegExp;
}

/**
 * Options for callTool.
 */
export interface CallToolOptions {
  /** Override default timeout (ms) */
  timeoutMs?: number;
  /** Run ID for budget tracking */
  runId?: string;
  /** Skip permission check (internal use only) */
  skipPermissionCheck?: boolean;
}

/**
 * Options for runAgent.
 */
export interface RunAgentOptions {
  /** Tools the agent is allowed to use (if empty, use all allowed) */
  toolAllowlist?: string[];
  /** Override rate limits */
  budgets?: Partial<RateLimitConfig>;
  /** Max iterations */
  maxIterations?: number;
}

