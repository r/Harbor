/**
 * Harbor ↔ Web Agents API Protocol Types
 *
 * This file defines the communication protocol between the Harbor extension
 * and the Web Agents API extension. Both extensions should import from this
 * file to ensure type consistency.
 *
 * Communication Flow:
 * - Web Agents API → Harbor: chrome.runtime.sendMessage(HARBOR_ID, message)
 * - Harbor → Web Agents API: Response via sendResponse callback
 * - Streaming: Uses chrome.runtime.connect for port-based communication
 *
 * Safari uses HTTP to communicate with harbor-bridge directly.
 */

// =============================================================================
// Base Protocol Types
// =============================================================================

/**
 * Base request format for all messages from Web Agents API to Harbor.
 */
export interface HarborRequest<T = unknown> {
  type: MessageType;
  payload?: T;
  /** Required for streaming requests to correlate responses */
  requestId?: string;
}

/**
 * Base response format for all messages from Harbor to Web Agents API.
 */
export interface HarborResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}

/**
 * Streaming event sent over a port connection.
 */
export interface StreamEvent {
  type: 'token' | 'done' | 'error';
  token?: string;
  finish_reason?: string;
  model?: string;
  error?: { code: number; message: string };
}

/**
 * Wrapper for streaming events over a port.
 */
export interface StreamChunk {
  type: 'stream';
  requestId: string;
  event: StreamEvent;
}

// =============================================================================
// Message Types (Protocol Commands)
// =============================================================================

/**
 * All supported message types between Web Agents API and Harbor.
 */
export type MessageType =
  // LLM Operations
  | 'llm.chat'
  | 'llm.chatStream'
  | 'llm.listProviders'
  | 'llm.getActiveProvider'
  | 'llm.configureProvider'
  | 'llm.listModels'
  | 'llm.listConfiguredModels'
  | 'llm.getConfiguredModelsMetadata'
  // MCP Operations
  | 'mcp.listServers'
  | 'mcp.listTools'
  | 'mcp.callTool'
  | 'mcp.startServer'
  | 'mcp.stopServer'
  // Session Operations
  | 'session.create'
  | 'session.createImplicit'
  | 'session.get'
  | 'session.list'
  | 'session.terminate'
  | 'session.recordUsage'
  // System Operations
  | 'system.health'
  | 'system.getCapabilities'
  | 'system.getVersion'
  | 'system.syncPermissions'
  // Agent Operations (routed to agent router)
  | 'agent.register'
  | 'agent.unregister'
  | 'agent.step'
  | 'agent.terminate'
  | 'agent.status'
  | 'agents.list'
  | 'agents.getActive'
  // Host operations (MCP server requests browser capture; Harbor → Web Agents)
  | 'agent.host.run';

// =============================================================================
// LLM Request/Response Types
// =============================================================================

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmTool {
  name: string;
  description: string;
  input_schema: unknown;
}

export interface LlmToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface LlmChatRequest {
  messages: LlmMessage[];
  model?: string;
  max_tokens?: number;
  temperature?: number;
  system?: string;
  tools?: LlmTool[];
}

export interface LlmChatResponse {
  content: string;
  model?: string;
  choices?: Array<{
    message: {
      role: string;
      content: string;
      tool_calls?: LlmToolCall[];
    };
    finish_reason?: string;
  }>;
}

export interface LlmProvider {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  models?: string[];
}

export interface LlmListProvidersResponse {
  providers: LlmProvider[];
  default_provider?: string;
}

export interface LlmConfigureProviderRequest {
  id?: string;
  provider?: string;
  name?: string;
  api_key?: string;
  base_url?: string;
  enabled?: boolean;
}

export interface LlmListModelsResponse {
  models: Array<{
    id: string;
    name: string;
    provider: string;
  }>;
}

/** Metadata for configured models (companion to listConfiguredModels). */
export interface LlmConfiguredModelMetadata {
  model_id: string;
  is_local: boolean;
}

export interface LlmGetConfiguredModelsMetadataResponse {
  metadata: LlmConfiguredModelMetadata[];
}

// =============================================================================
// MCP Request/Response Types
// =============================================================================

export interface McpServer {
  id: string;
  name: string;
  type: 'wasm' | 'js' | 'native' | 'http';
  running: boolean;
  tools?: McpTool[];
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpToolWithServer extends McpTool {
  serverId: string;
}

export interface McpListServersResponse {
  servers: McpServer[];
}

export interface McpListToolsRequest {
  serverId?: string;
}

export interface McpListToolsResponse {
  tools: McpToolWithServer[];
}

export interface McpCallToolRequest {
  serverId: string;
  toolName: string;
  args?: Record<string, unknown>;
}

export interface McpCallToolResponse {
  result: unknown;
}

export interface McpStartServerRequest {
  serverId: string;
}

export interface McpStopServerRequest {
  serverId: string;
}

// =============================================================================
// Session Request/Response Types
// =============================================================================

export interface SessionCapabilities {
  llm?: boolean;
  tools?: string[];
  browser?: {
    readActiveTab?: boolean;
    interact?: boolean;
    screenshot?: boolean;
  };
}

export interface CreateSessionOptions {
  name?: string;
  capabilities?: SessionCapabilities;
  limits?: {
    maxPrompts?: number;
    maxToolCalls?: number;
  };
}

export interface SessionCreateRequest {
  origin: string;
  tabId?: number;
  options: CreateSessionOptions;
}

export interface SessionCreateImplicitRequest {
  origin: string;
  tabId?: number;
  options?: {
    systemPrompt?: string;
    temperature?: number;
  };
}

export interface SessionSummary {
  sessionId: string;
  type: 'implicit' | 'explicit';
  origin: string;
  status: 'active' | 'suspended' | 'terminated';
  name?: string;
  createdAt: number;
  lastActiveAt: number;
  capabilities: {
    hasLLM: boolean;
    toolCount: number;
    hasBrowserAccess: boolean;
  };
  usage: {
    promptCount: number;
    toolCallCount: number;
    browserAccessCount: number;
  };
}

export interface SessionListRequest {
  origin?: string;
  status?: 'active' | 'suspended' | 'terminated';
  type?: 'implicit' | 'explicit';
  activeOnly?: boolean;
}

export interface SessionTerminateRequest {
  sessionId: string;
  origin: string;
}

export interface SessionRecordUsageRequest {
  sessionId: string;
  type: 'prompt' | 'tool' | 'browser';
  detail?: unknown;
}

// =============================================================================
// System Request/Response Types
// =============================================================================

export interface SystemHealthResponse {
  healthy: boolean;
  bridge: {
    connected: boolean;
    ready: boolean;
    error?: string;
  };
}

export interface SystemCapabilitiesResponse {
  bridgeReady: boolean;
  capabilities: {
    streaming: boolean;
    webSearch: boolean;
    codeExecution: boolean;
  };
  features: {
    llm: boolean;
    mcp: boolean;
    oauth: boolean;
    streaming: boolean;
  };
}

export interface SystemVersionResponse {
  version: string;
  extensionId: string;
}

export interface SystemSyncPermissionsRequest {
  origin: string;
  scopes: string[];
  grantType: 'granted-once' | 'granted-always';
  allowedTools?: string[];
}

// =============================================================================
// Agent Request/Response Types
// =============================================================================

export interface AgentCapabilities {
  llm?: boolean;
  tools?: string[];
  browser?: {
    readActiveTab?: boolean;
    interact?: boolean;
    screenshot?: boolean;
  };
}

export interface AgentRegisterRequest {
  origin: string;
  tabId: number;
  name?: string;
  capabilities?: AgentCapabilities;
}

export interface AgentRegisterResponse {
  agentId: string;
  sessionId: string;
  capabilities: AgentCapabilities;
}

export interface AgentStepRequest {
  agentId: string;
  action?: unknown;
}

export interface AgentStatusResponse {
  agentId: string;
  status: 'active' | 'paused' | 'terminated';
  origin: string;
}

// =============================================================================
// Error Codes
// =============================================================================

/**
 * Standard error codes used across Harbor and Web Agents API.
 * Prefixed with ERR_ for consistency and easy identification.
 */
export const ErrorCodes = {
  // Connection & Discovery
  /** Harbor extension not found or not connected */
  HARBOR_NOT_FOUND: 'ERR_HARBOR_NOT_FOUND',
  /** Native bridge not connected */
  BRIDGE_NOT_CONNECTED: 'ERR_BRIDGE_NOT_CONNECTED',
  /** Extension not installed */
  NOT_INSTALLED: 'ERR_NOT_INSTALLED',
  
  // Request Errors
  /** Request timed out */
  TIMEOUT: 'ERR_TIMEOUT',
  /** Invalid request format */
  INVALID_REQUEST: 'ERR_INVALID_REQUEST',
  /** Method not supported (e.g., Safari limitations) */
  NOT_SUPPORTED: 'ERR_NOT_SUPPORTED',
  
  // Permission Errors
  /** Permission denied by user or policy */
  PERMISSION_DENIED: 'ERR_PERMISSION_DENIED',
  /** Required scope not granted */
  SCOPE_REQUIRED: 'ERR_SCOPE_REQUIRED',
  /** Tool not in allowlist */
  TOOL_NOT_ALLOWED: 'ERR_TOOL_NOT_ALLOWED',
  /** Origin not allowed */
  ORIGIN_DENIED: 'ERR_ORIGIN_DENIED',
  
  // Resource Errors
  /** Resource not found (session, server, agent, etc.) */
  NOT_FOUND: 'ERR_NOT_FOUND',
  /** Session not found */
  SESSION_NOT_FOUND: 'ERR_SESSION_NOT_FOUND',
  /** Agent not found */
  AGENT_NOT_FOUND: 'ERR_AGENT_NOT_FOUND',
  /** Server not found */
  SERVER_NOT_FOUND: 'ERR_SERVER_NOT_FOUND',
  
  // Operation Errors
  /** Tool execution failed */
  TOOL_FAILED: 'ERR_TOOL_FAILED',
  /** Model/LLM execution failed */
  MODEL_FAILED: 'ERR_MODEL_FAILED',
  /** Agent not accepting requests */
  AGENT_NOT_ACCEPTING: 'ERR_AGENT_NOT_ACCEPTING',
  /** Budget exceeded (tool calls, tokens, etc.) */
  BUDGET_EXCEEDED: 'ERR_BUDGET_EXCEEDED',
  
  // Internal Errors
  /** Internal error */
  INTERNAL: 'ERR_INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// =============================================================================
// Error Types
// =============================================================================

/**
 * Structured error object used in API responses.
 */
export interface ApiError {
  code: ErrorCode | string;
  message: string;
  details?: unknown;
}

/**
 * Custom error class for API errors.
 * Can be thrown and caught, and serialized to ApiError format.
 */
export class HarborError extends Error {
  code: ErrorCode | string;
  details?: unknown;

  constructor(code: ErrorCode | string, message: string, details?: unknown) {
    super(message);
    this.name = 'HarborError';
    this.code = code;
    this.details = details;
  }

  toJSON(): ApiError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined && { details: this.details }),
    };
  }

  static fromError(error: unknown): HarborError {
    if (error instanceof HarborError) {
      return error;
    }
    if (error instanceof Error) {
      return new HarborError(ErrorCodes.INTERNAL, error.message);
    }
    return new HarborError(ErrorCodes.INTERNAL, String(error));
  }
}

/**
 * Create an ApiError object from various error types.
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof HarborError) {
    return error.toJSON();
  }
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
    return error as ApiError;
  }
  if (error instanceof Error) {
    return { code: ErrorCodes.INTERNAL, message: error.message };
  }
  return { code: ErrorCodes.INTERNAL, message: String(error) };
}

// =============================================================================
// Type Guards
// =============================================================================

export function isHarborRequest(message: unknown): message is HarborRequest {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    typeof (message as HarborRequest).type === 'string'
  );
}

export function isStreamEvent(event: unknown): event is StreamEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    ['token', 'done', 'error'].includes((event as StreamEvent).type)
  );
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create a success response.
 */
export function successResponse<T>(result?: T): HarborResponse<T> {
  return { ok: true, result };
}

/**
 * Create an error response from a string message.
 */
export function errorResponse(error: string): HarborResponse {
  return { ok: false, error };
}

/**
 * Create an error response from an error code and message.
 */
export function errorResponseWithCode(code: ErrorCode | string, message: string): HarborResponse & { errorCode: string } {
  return { ok: false, error: message, errorCode: code };
}

/**
 * Create an error response from any error type.
 */
export function errorResponseFromError(error: unknown): HarborResponse {
  const apiError = toApiError(error);
  return { ok: false, error: apiError.message };
}

/**
 * Check if an error matches a specific error code.
 */
export function isErrorCode(error: unknown, code: ErrorCode): boolean {
  if (error instanceof HarborError) {
    return error.code === code;
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return (error as { code: string }).code === code;
  }
  return false;
}

/**
 * Throw an error with the given code and message.
 */
export function throwError(code: ErrorCode, message: string, details?: unknown): never {
  throw new HarborError(code, message, details);
}
