/**
 * Web Agent API Type Definitions
 *
 * Types matching the Web IDL specification for window.ai and window.agent APIs.
 * See: docs/JS_AI_PROVIDER_API.md and spec/explainer.md
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
  | 'ERR_SESSION_NOT_FOUND'
  | 'ERR_TIMEOUT'
  | 'ERR_INTERNAL'
  | 'ERR_INVALID_REQUEST'
  // Multi-agent: the caller hasn't registered as an agent.
  | 'ERR_NOT_REGISTERED'
  // Typed-permission decisions surface these.
  | 'ERR_BLOCKED_BY_POLICY'
  | 'ERR_LABEL_FLOW_BLOCKED'
  | 'ERR_UNKNOWN_ACTION'
  | 'ERR_QUARANTINED';

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

export class WebAgentError extends Error {
  code: ApiErrorCode;
  details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'WebAgentError';
    this.code = code;
    this.details = details;
  }

  toJSON(): ApiError {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

// =============================================================================
// Permission Types
// =============================================================================

export type PermissionScope =
  // Extension 1: Core AI & MCP
  | 'model:prompt'
  | 'model:tools'
  | 'model:list'
  | 'mcp:tools.list'
  | 'mcp:tools.call'
  | 'mcp:servers.register'
  // Extension 1: Browser (same-tab only)
  | 'browser:activeTab.read'
  | 'browser:activeTab.interact'  // click, fill, scroll (same-tab only)
  | 'browser:activeTab.screenshot' // capture screenshots
  // Extension 2: Navigation and Tabs
  | 'browser:navigate'             // navigate current tab to new URL
  | 'browser:tabs.read'            // read tab metadata (URL, title) for all tabs
  | 'browser:tabs.create'          // create new tabs and control them
  // Extension 2: Web Fetch
  | 'web:fetch'                    // proxy HTTP requests (with allowlist)
  // Other
  | 'chat:open'
  // Extension 3: Multi-Agent (reserved)
  | 'agents:register'              // register as an agent
  | 'agents:discover'              // discover other agents
  | 'agents:invoke'                // invoke other agents
  | 'agents:message'               // send/receive messages
  | 'agents:crossOrigin'           // cross-origin agent communication
  | 'agents:remote';               // connect to remote A2A agents

export type PermissionGrant =
  | 'granted-once'
  | 'granted-always'
  | 'denied'
  | 'not-granted';

export interface PermissionGrantResult {
  granted: boolean;
  scopes: Record<PermissionScope, PermissionGrant>;
  allowedTools?: string[];
  /** Sites whose agents the origin may currently reach (`agents:crossOrigin`). */
  agentOrigins?: string[];
}

export interface PermissionStatus {
  origin: string;
  scopes: Record<PermissionScope, PermissionGrant>;
  allowedTools?: string[];
  /** Sites whose agents the origin may currently reach (`agents:crossOrigin`). */
  agentOrigins?: string[];
  /** Sites the person refused agents:crossOrigin for (sidebar display). */
  deniedAgentOrigins?: string[];
}

export interface RequestPermissionsOptions {
  scopes: PermissionScope[];
  reason?: string;
  tools?: string[];
  /** The sites `agents:crossOrigin` is asked for. Required with that scope. */
  agentOrigins?: string[];
}

export interface StoredPermission {
  grant: PermissionGrant;
  grantedAt: number;
  expiresAt?: number; // For 'granted-once'
  tabId?: number; // For 'granted-once'
  /** Every tab an unexpired 'granted-once' covers, when more than one answered. */
  tabIds?: number[];
}

export interface StoredOriginPermissions {
  origin: string;
  scopes: Record<PermissionScope, StoredPermission>;
  allowedTools: string[];
  /**
   * `agents:crossOrigin` grants, one per target site, each with its own
   * duration and tab. The scope has no site-wide entry: an old one in
   * `scopes` is ignored.
   */
  agentOrigins?: Record<string, StoredPermission>;
}

// =============================================================================
// Tool Types
// =============================================================================

export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  serverId?: string;
}

export interface ToolCallOptions {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolCallResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

// =============================================================================
// Text Session Types
// =============================================================================

export type AICapabilityAvailability = 'readily' | 'after-download' | 'no';

export interface TextSessionOptions {
  model?: string;
  provider?: string;
  temperature?: number;
  top_p?: number;
  systemPrompt?: string;
}

export interface AILanguageModelCapabilities {
  available: AICapabilityAvailability;
  defaultTopK?: number;
  maxTopK?: number;
  defaultTemperature?: number;
}

export interface AILanguageModelCreateOptions {
  systemPrompt?: string;
  initialPrompts?: ConversationMessage[];
  temperature?: number;
  topK?: number;
  signal?: AbortSignal;
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface StreamToken {
  type: 'token' | 'done' | 'error';
  token?: string;
  error?: ApiError;
}

export interface TextSession {
  sessionId: string;
  prompt(input: string): Promise<string>;
  promptStreaming(input: string): AsyncIterable<StreamToken>;
  destroy(): Promise<void>;
  clone(): Promise<TextSession>;
}

export interface StoredSession {
  sessionId: string;
  origin: string;
  options: TextSessionOptions;
  history: ConversationMessage[];
  createdAt: number;
}

// =============================================================================
// LLM Provider Types
// =============================================================================

export interface LLMProviderInfo {
  /** Unique instance ID (e.g., 'openai-work', 'openai-personal') */
  id: string;
  /** Provider type (e.g., 'openai', 'anthropic', 'ollama') */
  type: string;
  /** User-defined display name */
  name: string;
  /** Whether this provider instance is available */
  available: boolean;
  /** Custom base URL if configured */
  baseUrl?: string;
  /** Available model IDs */
  models?: string[];
  /** Whether this is the global default provider */
  isDefault: boolean;
  /** Whether this is the default for its provider type */
  isTypeDefault: boolean;
  /** Whether this provider supports tool calling */
  supportsTools?: boolean;
}

export interface ActiveLLMConfig {
  provider: string | null;
  model: string | null;
}

export interface AddProviderOptions {
  /** Provider type (e.g., 'openai', 'anthropic') */
  type: string;
  /** User-defined display name */
  name: string;
  /** API key (for cloud providers) */
  apiKey?: string;
  /** Custom base URL */
  baseUrl?: string;
}

// =============================================================================
// Agent Run Types
// =============================================================================

export interface AgentRunOptions {
  task: string;
  tools?: string[];
  provider?: string;
  useAllTools?: boolean;
  requireCitations?: boolean;
  maxToolCalls?: number;
  signal?: AbortSignal;
}

export interface Citation {
  source: 'tab' | 'tool';
  ref: string;
  excerpt: string;
}

export interface StatusEvent {
  type: 'status';
  message: string;
}

export interface ToolCallEvent {
  type: 'tool_call';
  tool: string;
  args: unknown;
}

export interface ToolResultEvent {
  type: 'tool_result';
  tool: string;
  result?: unknown;
  error?: ApiError;
}

export interface TokenEvent {
  type: 'token';
  token: string;
}

export interface FinalEvent {
  type: 'final';
  output: string;
  citations?: Citation[];
}

export interface ErrorEvent {
  type: 'error';
  error: ApiError;
}

export type RunEvent =
  | StatusEvent
  | ToolCallEvent
  | ToolResultEvent
  | TokenEvent
  | FinalEvent
  | ErrorEvent;

// =============================================================================
// Browser API Types
// =============================================================================

export interface ActiveTabReadability {
  url: string;
  title: string;
  text: string;
}

// =============================================================================
// Capabilities API Types (agent.capabilities())
// =============================================================================

/**
 * LLM capabilities available to the agent
 */
export interface LLMCapabilities {
  /** Whether LLM access is available */
  available: boolean;
  /** Whether streaming responses are supported */
  streaming: boolean;
  /** Whether tool calling is supported */
  toolCalling: boolean;
  /** Available provider types */
  providers: string[];
  /** Best runtime to use */
  bestRuntime: 'firefox' | 'chrome' | 'harbor' | null;
}

/**
 * Tool/MCP capabilities available to the agent
 */
export interface ToolCapabilities {
  /** Whether MCP tool access is available */
  available: boolean;
  /** Number of tools available */
  count: number;
  /** List of connected MCP server IDs */
  servers: string[];
}

/**
 * Browser interaction capabilities
 */
export interface BrowserCapabilities {
  /** Can read content from current tab */
  readActiveTab: boolean;
  /** Can interact with current tab (click, fill, scroll) */
  interact: boolean;
  /** Can take screenshots */
  screenshot: boolean;
  /** Can navigate current tab (Extension 2) */
  navigate: boolean;
  /** Can read other tabs metadata (Extension 2) */
  readTabs: boolean;
  /** Can create new tabs (Extension 2) */
  createTabs: boolean;
}

/**
 * Multi-agent capabilities (Extension 3)
 */
export interface AgentCapabilities {
  /** Can register as an agent */
  register: boolean;
  /** Can discover other agents */
  discover: boolean;
  /** Can invoke other agents */
  invoke: boolean;
  /** Can send/receive messages */
  message: boolean;
  /** Can communicate cross-origin */
  crossOrigin: boolean;
  /** Can connect to remote agents */
  remote: boolean;
}

/**
 * Permission status for each capability area
 */
export interface CapabilityPermissions {
  /** Permissions for LLM access */
  llm: {
    prompt: PermissionGrant;
    tools: PermissionGrant;
    list: PermissionGrant;
  };
  /** Permissions for MCP tools */
  mcp: {
    list: PermissionGrant;
    call: PermissionGrant;
    register: PermissionGrant;
  };
  /** Permissions for browser access */
  browser: {
    read: PermissionGrant;
    interact: PermissionGrant;
    screenshot: PermissionGrant;
    navigate: PermissionGrant;
    tabsRead: PermissionGrant;
    tabsCreate: PermissionGrant;
  };
  /** Permissions for multi-agent features */
  agents: {
    register: PermissionGrant;
    discover: PermissionGrant;
    invoke: PermissionGrant;
    message: PermissionGrant;
    crossOrigin: PermissionGrant;
    remote: PermissionGrant;
  };
  /** Permissions for web fetch */
  web: {
    fetch: PermissionGrant;
  };
}

/**
 * Complete capabilities report from agent.capabilities()
 */
export interface AgentCapabilitiesReport {
  /** API version */
  version: string;
  /** LLM capabilities */
  llm: LLMCapabilities;
  /** MCP/tool capabilities */
  tools: ToolCapabilities;
  /** Browser interaction capabilities */
  browser: BrowserCapabilities;
  /** Multi-agent capabilities (Extension 3) */
  agents: AgentCapabilities;
  /** Current permission status for all scopes */
  permissions: CapabilityPermissions;
  /** List of allowed tool names (if mcp:tools.call is granted) */
  allowedTools: string[];
  /** Feature flags that are enabled */
  features: {
    browserInteraction: boolean;
    screenshots: boolean;
    multiAgent: boolean;
    remoteTabs: boolean;
    webFetch: boolean;
  };
}

// =============================================================================
// BYOC (Bring Your Own Chatbot) Types
// =============================================================================

export interface DeclaredMCPServer {
  url: string;
  title: string;
  description?: string;
  tools?: string[];
  transport?: 'sse' | 'websocket';
}

export interface MCPServerRegistration {
  url: string;
  name: string;
  description?: string;
  tools?: string[];
  transport?: 'sse' | 'websocket';
}

export interface MCPRegistrationResult {
  success: boolean;
  serverId?: string;
  error?: {
    code: 'USER_DENIED' | 'INVALID_URL' | 'CONNECTION_FAILED' | 'NOT_SUPPORTED';
    message: string;
  };
}

export type ChatAvailability = 'readily' | 'no';

export interface ChatOpenOptions {
  initialMessage?: string;
  systemPrompt?: string;
  tools?: string[];
  sessionId?: string;
  style?: {
    theme?: 'light' | 'dark' | 'auto';
    accentColor?: string;
    position?: 'right' | 'left' | 'center';
  };
}

export interface ChatOpenResult {
  success: boolean;
  chatId?: string;
  error?: {
    code: 'USER_DENIED' | 'NOT_AVAILABLE' | 'ALREADY_OPEN';
    message: string;
  };
}

// =============================================================================
// Message Protocol Types (for transport layer)
// =============================================================================

export type MessageType =
  // AI methods
  | 'ai.canCreateTextSession'
  | 'ai.createTextSession'
  | 'ai.languageModel.capabilities'
  | 'ai.languageModel.create'
  | 'ai.providers.list'
  // Session methods
  | 'session.prompt'
  | 'session.promptStreaming'
  | 'session.destroy'
  // Agent methods
  | 'agent.requestPermissions'
  | 'agent.permissions.list'
  | 'agent.capabilities'
  | 'agent.tools.list'
  | 'agent.tools.call'
  | 'agent.browser.activeTab.readability'
  | 'agent.browser.activeTab.click'
  | 'agent.browser.activeTab.fill'
  | 'agent.browser.activeTab.select'
  | 'agent.browser.activeTab.scroll'
  | 'agent.browser.activeTab.getElement'
  | 'agent.browser.activeTab.waitForSelector'
  | 'agent.browser.activeTab.screenshot'
  // Extension 2: Navigation and Tabs
  | 'agent.browser.navigate'
  | 'agent.browser.waitForNavigation'
  | 'agent.browser.tabs.list'
  | 'agent.browser.tabs.create'
  | 'agent.browser.tabs.get'
  | 'agent.browser.tabs.close'
  // Extension 2: Spawned tab operations (operate on tabs we created)
  | 'agent.browser.tab.readability'
  | 'agent.browser.tab.click'
  | 'agent.browser.tab.fill'
  | 'agent.browser.tab.scroll'
  | 'agent.browser.tab.screenshot'
  | 'agent.browser.tab.navigate'
  // Extension 2: Web Fetch
  | 'agent.fetch'
  // Extension 3: Multi-Agent
  | 'agents.register'
  | 'agents.unregister'
  | 'agents.getInfo'
  | 'agents.discover'
  | 'agents.list'
  | 'agents.invoke'
  | 'agents.send'
  | 'agents.subscribe'
  | 'agents.broadcast'
  | 'agents.unsubscribe'
  | 'agents.registerMessageHandler'
  | 'agents.unregisterMessageHandler'
  | 'agents.registerInvocationHandler'
  | 'agents.unregisterInvocationHandler'
  | 'agents.orchestrate.pipeline'
  | 'agents.orchestrate.parallel'
  | 'agents.orchestrate.route'
  | 'agents.orchestrate.supervisor'
  // Extension 3: Remote A2A
  | 'agents.remote.connect'
  | 'agents.remote.disconnect'
  | 'agents.remote.list'
  | 'agents.remote.ping'
  | 'agents.remote.discover'
  // BYOC methods
  | 'agent.mcp.discover'
  | 'agent.mcp.register'
  | 'agent.mcp.unregister'
  | 'agent.chat.canOpen'
  | 'agent.chat.open'
  | 'agent.chat.close';

export interface TransportRequest {
  id: string;
  type: MessageType;
  payload?: unknown;
}

export interface TransportResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: ApiError;
}

export interface TransportStreamEvent {
  id: string;
  event: RunEvent | StreamToken;
  done?: boolean;
}
