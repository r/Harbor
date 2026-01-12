/**
 * Harbor JS AI Provider - Type Definitions
 * 
 * Types for the window.ai and window.agent APIs exposed to web pages.
 */

// =============================================================================
// Error Types
// =============================================================================

export type ApiErrorCode =
  | 'ERR_NOT_INSTALLED'
  | 'ERR_PERMISSION_DENIED'
  | 'ERR_USER_GESTURE_REQUIRED'
  | 'ERR_SCOPE_REQUIRED'
  | 'ERR_TOOL_NOT_ALLOWED'
  | 'ERR_TOOL_FAILED'
  | 'ERR_MODEL_FAILED'
  | 'ERR_NOT_IMPLEMENTED'
  | 'ERR_INTERNAL'
  | 'ERR_SESSION_NOT_FOUND'
  | 'ERR_TIMEOUT';

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

// =============================================================================
// Permission Scopes
// =============================================================================

export type PermissionScope =
  | 'model:prompt'      // Basic text generation
  | 'model:tools'       // Model can call tools during generation
  | 'model:list'        // List configured LLM providers
  | 'mcp:tools.list'    // List available MCP tools
  | 'mcp:tools.call'    // Call MCP tools
  | 'mcp:servers.register' // Register temporary MCP servers (BYOC)
  | 'browser:activeTab.read'  // Read content from active tab
  | 'chat:open'         // Open the browser's chat UI (BYOC)
  | 'web:fetch';        // Proxy fetch requests (NOT IMPLEMENTED in v1)

export type PermissionGrant = 
  | 'granted-once'      // Permission granted for this session only
  | 'granted-always'    // Permission persisted for this origin
  | 'denied'            // Permission explicitly denied
  | 'not-granted';      // Never requested or no decision made

export interface PermissionGrantResult {
  granted: boolean;
  scopes: Record<PermissionScope, PermissionGrant>;
  /** Tools that are allowed for this origin (only if mcp:tools.call is granted) */
  allowedTools?: string[];
}

export interface PermissionStatus {
  origin: string;
  scopes: Record<PermissionScope, PermissionGrant>;
  /** Tools that are allowed for this origin (only if mcp:tools.call is granted) */
  allowedTools?: string[];
}

// =============================================================================
// Tool Types
// =============================================================================

export interface ToolDescriptor {
  name: string;             // Fully qualified: "serverId/toolName"
  description?: string;
  inputSchema?: unknown;    // JSON Schema
  serverId?: string;
}

export interface ToolCallRequest {
  tool: string;             // Fully qualified tool name
  args: Record<string, unknown>;
}

export interface ToolCallResult {
  success: boolean;
  result?: unknown;
  error?: ApiError;
}

// =============================================================================
// Browser API Types
// =============================================================================

export interface ActiveTabReadability {
  url: string;
  title: string;
  text: string;
}

// =============================================================================
// MCP Server Registration Types (BYOC - Bring Your Own Chatbot)
// =============================================================================

/** MCP server declared via <link rel="mcp-server"> in the page */
export interface DeclaredMCPServer {
  /** Server endpoint URL */
  url: string;
  /** Human-readable name */
  title: string;
  /** Description of what the server provides */
  description?: string;
  /** List of tool names this server provides */
  tools?: string[];
  /** Transport type */
  transport?: 'sse' | 'websocket';
  /** Server icon URL */
  iconUrl?: string;
}

/** Options for registering a website's MCP server */
export interface MCPServerRegistration {
  /** Server endpoint URL (must be HTTPS in production) */
  url: string;
  /** Human-readable name shown to user */
  name: string;
  /** Description of what the server provides */
  description?: string;
  /** List of tools this server provides (for transparency) */
  tools?: string[];
  /** Server icon URL */
  iconUrl?: string;
  /** Transport type (default: 'sse') */
  transport?: 'sse' | 'websocket';
}

/** Result of MCP server registration */
export interface MCPRegistrationResult {
  success: boolean;
  /** ID to use for unregistration */
  serverId?: string;
  error?: {
    code: 'USER_DENIED' | 'INVALID_URL' | 'CONNECTION_FAILED' | 'NOT_SUPPORTED';
    message: string;
  };
}

// =============================================================================
// Chat UI Types (BYOC - Bring Your Own Chatbot)
// =============================================================================

/** Chat UI availability status */
export type ChatAvailability = 'readily' | 'no';

/** Options for opening the browser's chat UI */
export interface ChatOpenOptions {
  /** Initial message to display or send */
  initialMessage?: string;
  /** System prompt to configure the AI */
  systemPrompt?: string;
  /** Which tools to make available (from registered MCP servers) */
  tools?: string[];
  /** Session ID for persistence across navigations */
  sessionId?: string;
  /** Styling hints (browser may ignore) */
  style?: {
    theme?: 'light' | 'dark' | 'auto';
    accentColor?: string;
    position?: 'right' | 'left' | 'center';
  };
}

/** Result of opening the chat UI */
export interface ChatOpenResult {
  success: boolean;
  /** ID to reference this chat session */
  chatId?: string;
  error?: {
    code: 'USER_DENIED' | 'NOT_AVAILABLE' | 'ALREADY_OPEN' | 'PERMISSION_REQUIRED';
    message: string;
  };
}

// =============================================================================
// Text Session Types (window.ai)
// =============================================================================

export interface TextSessionOptions {
  model?: string;           // Model identifier, default: "default"
  provider?: string;        // Provider identifier (openai, anthropic, ollama, etc.)
  temperature?: number;     // 0.0 - 2.0
  top_p?: number;           // 0.0 - 1.0
  systemPrompt?: string;    // Optional system prompt
}

// =============================================================================
// LLM Provider Types
// =============================================================================

/**
 * Information about an available LLM provider.
 */
export interface LLMProviderInfo {
  /** Provider ID (e.g., 'openai', 'anthropic', 'ollama') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Whether the provider is currently available */
  available: boolean;
  /** Base URL for the provider's API */
  baseUrl?: string;
  /** Available models for this provider */
  models?: string[];
  /** Whether this is the currently active (default) provider */
  isDefault: boolean;
  /** Whether the provider supports tool calling */
  supportsTools?: boolean;
}

/**
 * Current active LLM configuration.
 */
export interface ActiveLLMConfig {
  /** Active provider ID */
  provider: string | null;
  /** Active model ID */
  model: string | null;
}

export interface TextSession {
  sessionId: string;
  prompt(input: string, options?: PromptOptions): Promise<string>;
  promptStreaming(input: string, options?: PromptOptions): AsyncIterable<StreamToken>;
  destroy(): Promise<void>;
}

export interface PromptOptions {
  signal?: AbortSignal;
}

export interface StreamToken {
  type: 'token' | 'done' | 'error';
  token?: string;
  error?: ApiError;
}

// =============================================================================
// Chrome AI API Compatibility Types
// =============================================================================

/**
 * Chrome AI capability availability status.
 * - 'readily': Model is ready to use immediately
 * - 'after-download': Model needs to be downloaded first (not used in Harbor)
 * - 'no': Model is not available
 */
export type AICapabilityAvailability = 'readily' | 'after-download' | 'no';

/**
 * Chrome-compatible AI text session interface.
 * Extends Harbor's TextSession with Chrome API compatibility.
 */
export interface AITextSession extends TextSession {
  clone(): Promise<AITextSession>;
}

/**
 * Chrome languageModel.capabilities() return type.
 */
export interface AILanguageModelCapabilities {
  available: AICapabilityAvailability;
  defaultTopK?: number;
  maxTopK?: number;
  defaultTemperature?: number;
}

/**
 * Chrome languageModel.create() options.
 */
export interface AILanguageModelCreateOptions {
  systemPrompt?: string;
  initialPrompts?: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
  topK?: number;
  signal?: AbortSignal;
}

/**
 * Chrome-compatible window.ai API interface.
 * Provides both Harbor's API and Chrome Prompt API compatibility.
 */
export interface AIApi {
  /** Chrome Compatibility: Check if a text session can be created */
  canCreateTextSession(): Promise<AICapabilityAvailability>;
  
  /** Create a text session (auto-requests permission if needed) */
  createTextSession(options?: TextSessionOptions): Promise<AITextSession>;
  
  /** Chrome Prompt API: languageModel namespace */
  languageModel: {
    capabilities(): Promise<AILanguageModelCapabilities>;
    create(options?: AILanguageModelCreateOptions): Promise<AITextSession>;
  };
}

// =============================================================================
// Agent Run Types (window.agent)
// =============================================================================

export interface AgentRunOptions {
  task: string;
  tools?: string[];         // Allowed tool names (overrides router)
  provider?: string;        // Specify which LLM provider to use (default: active provider)
  useAllTools?: boolean;    // If true, disable tool router and use all tools
  requireCitations?: boolean;
  maxToolCalls?: number;    // Default: 5
  signal?: AbortSignal;
}

export interface Citation {
  source: 'tab' | 'tool';
  ref: string;              // Tool name or "activeTab"
  excerpt: string;
}

export type RunEvent =
  | { type: 'status'; message: string }
  | { type: 'tool_call'; tool: string; args: unknown }
  | { type: 'tool_result'; tool: string; result: unknown; error?: ApiError }
  | { type: 'token'; token: string }
  | { type: 'final'; output: string; citations?: Citation[] }
  | { type: 'error'; error: ApiError };

// =============================================================================
// Message Protocol (page <-> content script <-> background)
// =============================================================================

export const PROVIDER_MESSAGE_NAMESPACE = 'harbor-provider';

export interface ProviderMessage {
  namespace: typeof PROVIDER_MESSAGE_NAMESPACE;
  type: ProviderMessageType;
  requestId: string;
  payload?: unknown;
}

export type ProviderMessageType =
  // Ping/health check
  | 'ping'
  | 'pong'
  // Permissions
  | 'request_permissions'
  | 'permissions_result'
  | 'list_permissions'
  | 'list_permissions_result'
  // LLM Providers
  | 'llm_list_providers'
  | 'llm_list_providers_result'
  | 'llm_get_active'
  | 'llm_get_active_result'
  // Text session (window.ai)
  | 'create_text_session'
  | 'create_text_session_result'
  | 'text_session_prompt'
  | 'text_session_prompt_result'
  | 'text_session_prompt_streaming'
  | 'text_session_stream_token'
  | 'text_session_stream_done'
  | 'text_session_destroy'
  | 'text_session_destroy_result'
  // Tools
  | 'tools_list'
  | 'tools_list_result'
  | 'tools_call'
  | 'tools_call_result'
  // Browser
  | 'active_tab_read'
  | 'active_tab_read_result'
  // Agent run
  | 'agent_run'
  | 'agent_run_event'
  | 'agent_run_abort'
  // MCP Server Registration (BYOC)
  | 'mcp_discover'
  | 'mcp_discover_result'
  | 'mcp_register'
  | 'mcp_register_result'
  | 'mcp_unregister'
  | 'mcp_unregister_result'
  // Chat UI (BYOC)
  | 'chat_can_open'
  | 'chat_can_open_result'
  | 'chat_open'
  | 'chat_open_result'
  | 'chat_close'
  | 'chat_close_result'
  // Errors
  | 'error';

// Request payloads
export interface RequestPermissionsPayload {
  scopes: PermissionScope[];
  reason?: string;
  /** Specific tools needed (for mcp:tools.call scope) */
  tools?: string[];
}

export interface CreateTextSessionPayload {
  options?: TextSessionOptions;
}

export interface TextSessionPromptPayload {
  sessionId: string;
  input: string;
  streaming: boolean;
}

export interface TextSessionDestroyPayload {
  sessionId: string;
}

export interface ToolsCallPayload {
  tool: string;
  args: Record<string, unknown>;
}

export interface AgentRunPayload {
  task: string;
  tools?: string[];
  provider?: string;        // Specify which LLM provider to use
  requireCitations?: boolean;
  maxToolCalls?: number;
}

// Response payloads
export interface ErrorPayload {
  error: ApiError;
}

export interface PermissionsResultPayload {
  granted: boolean;
  scopes: Record<PermissionScope, PermissionGrant>;
}

export interface CreateTextSessionResultPayload {
  sessionId: string;
}

export interface TextSessionPromptResultPayload {
  result: string;
}

export interface StreamTokenPayload {
  requestId: string;  // Original request ID
  token: StreamToken;
}

export interface ToolsListResultPayload {
  tools: ToolDescriptor[];
}

export interface ToolsCallResultPayload {
  success: boolean;
  result?: unknown;
  error?: ApiError;
}

export interface ActiveTabReadResultPayload {
  url: string;
  title: string;
  text: string;
}

export interface AgentRunEventPayload {
  requestId: string;  // Original request ID
  event: RunEvent;
}

// =============================================================================
// Storage Types
// =============================================================================

export interface StoredPermissions {
  // Key: origin (e.g., "https://example.com")
  [origin: string]: {
    scopes: Record<PermissionScope, PermissionGrant>;
    /** Per-origin tool allowlist (empty means all tools allowed) */
    allowedTools?: string[];
    updatedAt: number;
  };
}

export interface TemporaryGrant {
  origin: string;
  scopes: PermissionScope[];
  /** Per-origin tool allowlist (empty means all tools allowed) */
  allowedTools?: string[];
  grantedAt: number;
  expiresAt: number;  // TTL for "once" grants
  tabId?: number;     // Associated tab, if any
}

// =============================================================================
// Internal Background State
// =============================================================================

export interface TextSessionState {
  id: string;
  origin: string;
  options: TextSessionOptions;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  createdAt: number;
}

export interface AgentRunState {
  id: string;
  origin: string;
  task: string;
  allowedTools: string[];
  maxToolCalls: number;
  requireCitations: boolean;
  toolCallCount: number;
  aborted: boolean;
  createdAt: number;
}

