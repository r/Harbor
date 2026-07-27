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
  // Typed-permission decisions surface these.
  | 'ERR_BLOCKED_BY_POLICY'
  | 'ERR_LABEL_FLOW_BLOCKED'
  | 'ERR_TOKEN_EXPIRED'
  | 'ERR_TOKEN_NOT_FOR_ORIGIN'
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
  | 'addressBar:suggest'
  | 'addressBar:context'
  | 'addressBar:history'
  | 'addressBar:execute'
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
}

export interface PermissionStatus {
  origin: string;
  scopes: Record<PermissionScope, PermissionGrant>;
  allowedTools?: string[];
}

export interface RequestPermissionsOptions {
  scopes: PermissionScope[];
  reason?: string;
  tools?: string[];
}

export interface StoredPermission {
  grant: PermissionGrant;
  grantedAt: number;
  expiresAt?: number; // For 'granted-once'
  tabId?: number; // For 'granted-once'
}

export interface StoredOriginPermissions {
  origin: string;
  scopes: Record<PermissionScope, StoredPermission>;
  allowedTools: string[];
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
  | 'ai.providers.getActive'
  | 'ai.providers.add'
  | 'ai.providers.remove'
  | 'ai.providers.setDefault'
  | 'ai.providers.setTypeDefault'
  | 'ai.runtime.getBest'
  | 'ai.runtime.getCapabilities'
  // Session methods
  | 'session.prompt'
  | 'session.promptStreaming'
  | 'session.destroy'
  | 'session.clone'
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
  | 'agent.browser.tab.getHtml'
  | 'agent.browser.tab.click'
  | 'agent.browser.tab.fill'
  | 'agent.browser.tab.scroll'
  | 'agent.browser.tab.screenshot'
  | 'agent.browser.tab.navigate'
  | 'agent.browser.tab.waitForNavigation'
  // Extension 2: Web Fetch
  | 'agent.fetch'
  | 'agent.run'
  // Extension 3: Multi-Agent
  | 'agents.register'
  | 'agents.unregister'
  | 'agents.getInfo'
  | 'agents.discover'
  | 'agents.list'
  | 'agents.invoke'
  | 'agents.send'
  | 'agents.subscribe'
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
  | 'agent.chat.close'
  // Address Bar methods
  | 'agent.addressBar.canProvide'
  | 'agent.addressBar.registerProvider'
  | 'agent.addressBar.registerToolShortcuts'
  | 'agent.addressBar.registerSiteProvider'
  | 'agent.addressBar.discover'
  | 'agent.addressBar.listProviders'
  | 'agent.addressBar.unregisterProvider'
  | 'agent.addressBar.setDefaultProvider'
  | 'agent.addressBar.getDefaultProvider'
  | 'agent.addressBar.query'
  | 'agent.addressBar.select';

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

// =============================================================================
// Required Permission Scopes per Method
// =============================================================================

export const REQUIRED_SCOPES: Partial<Record<MessageType, PermissionScope[]>> = {
  // Extension 1: Core AI
  'ai.createTextSession': ['model:prompt'],
  'ai.languageModel.create': ['model:prompt'],
  'ai.providers.list': ['model:list'],
  'ai.providers.getActive': ['model:list'],
  'ai.providers.add': ['model:list'],
  'ai.providers.remove': ['model:list'],
  'ai.providers.setDefault': ['model:list'],
  'ai.providers.setTypeDefault': ['model:list'],
  'session.prompt': ['model:prompt'],
  'session.promptStreaming': ['model:prompt'],
  // Extension 1: Tools
  'agent.tools.list': ['mcp:tools.list'],
  'agent.tools.call': ['mcp:tools.call'],
  // Extension 1: Browser (same-tab)
  'agent.browser.activeTab.readability': ['browser:activeTab.read'],
  'agent.browser.activeTab.click': ['browser:activeTab.interact'],
  'agent.browser.activeTab.fill': ['browser:activeTab.interact'],
  'agent.browser.activeTab.select': ['browser:activeTab.interact'],
  'agent.browser.activeTab.scroll': ['browser:activeTab.interact'],
  'agent.browser.activeTab.getElement': ['browser:activeTab.read'],
  'agent.browser.activeTab.waitForSelector': ['browser:activeTab.read'],
  'agent.browser.activeTab.screenshot': ['browser:activeTab.screenshot'],
  'agent.run': ['model:tools'],
  'agent.mcp.register': ['mcp:servers.register'],
  'agent.chat.open': ['chat:open'],
  'agent.addressBar.registerProvider': ['addressBar:suggest'],
  'agent.addressBar.registerToolShortcuts': ['addressBar:suggest', 'addressBar:execute'],
  'agent.addressBar.registerSiteProvider': ['addressBar:suggest'],
  // Extension 2: Navigation
  'agent.browser.navigate': ['browser:navigate'],
  'agent.browser.waitForNavigation': ['browser:navigate'],
  // Extension 2: Tabs
  'agent.browser.tabs.list': ['browser:tabs.read'],
  'agent.browser.tabs.create': ['browser:tabs.create'],
  'agent.browser.tabs.get': ['browser:tabs.read'],
  'agent.browser.tabs.close': ['browser:tabs.create'], // Can only close tabs we created
  // Extension 2: Spawned tab operations (requires tabs.create since you must have created the tab)
  'agent.browser.tab.readability': ['browser:tabs.create'],
  'agent.browser.tab.click': ['browser:tabs.create'],
  'agent.browser.tab.fill': ['browser:tabs.create'],
  'agent.browser.tab.scroll': ['browser:tabs.create'],
  'agent.browser.tab.screenshot': ['browser:tabs.create'],
  'agent.browser.tab.navigate': ['browser:tabs.create'],
  // Extension 2: Web Fetch
  'agent.fetch': ['web:fetch'],
};

// =============================================================================
// Address Bar Types
// =============================================================================

export type AddressBarTriggerType = 'prefix' | 'keyword' | 'regex' | 'always';

export interface AddressBarTrigger {
  type: AddressBarTriggerType;
  value: string;
  hint?: string;
}

export interface AddressBarQueryContext {
  query: string;
  trigger: AddressBarTrigger;
  currentTab?: {
    url: string;
    title: string;
    domain: string;
  };
  recentHistory?: {
    url: string;
    title: string;
    visitCount: number;
    lastVisit: number;
  }[];
  isTyping: boolean;
  timeSinceLastKeystroke: number;
}

export type AddressBarSuggestionType = 'url' | 'search' | 'tool' | 'action' | 'answer';

export interface AddressBarSuggestion {
  id: string;
  type: AddressBarSuggestionType;
  title: string;
  description?: string;
  icon?: string;
  url?: string;
  searchQuery?: string;
  searchEngine?: string;
  tool?: {
    name: string;
    args: Record<string, unknown>;
  };
  action?: AddressBarAction;
  answer?: {
    text: string;
    source?: string;
    copyable?: boolean;
  };
  confidence?: number;
  provider: string;
}

export type AddressBarAction =
  | { type: 'navigate'; url: string }
  | { type: 'search'; query: string; engine?: string }
  | { type: 'copy'; text: string; notify?: boolean }
  | { type: 'execute'; tool: string; args: Record<string, unknown> }
  | { type: 'show'; content: string; format: 'text' | 'markdown' | 'html' }
  | { type: 'agent'; task: string; tools?: string[] };

export type AddressBarResultHandler = 'inline' | 'popup' | 'navigate' | 'clipboard';

export interface ToolShortcut {
  trigger: string;
  tool: string;
  description: string;
  examples?: string[];
  argParser?: string; // Serialized function or built-in parser name
  useLLMParser?: boolean;
  llmParserPrompt?: string;
}

export interface ToolShortcutsOptions {
  shortcuts: ToolShortcut[];
  resultHandler: AddressBarResultHandler;
}

export interface AddressBarProviderOptions {
  id: string;
  name: string;
  description: string;
  triggers: AddressBarTrigger[];
  // Note: onQuery is handled via message passing, not stored
}

export interface SiteProviderOptions {
  origin: string;
  name: string;
  description: string;
  patterns: string[];
  icon?: string;
  endpoint?: string;
  // Note: onQuery is handled via message passing if no endpoint
}

export interface DeclaredAddressBarProvider {
  origin: string;
  name: string;
  description?: string;
  endpoint: string;
  patterns: string[];
  icon?: string;
}

export interface AddressBarProviderInfo {
  id: string;
  name: string;
  description: string;
  triggers: AddressBarTrigger[];
  isDefault: boolean;
  origin?: string;
  type: 'ai' | 'tool' | 'site';
}

export interface StoredAddressBarProvider {
  id: string;
  name: string;
  description: string;
  triggers: AddressBarTrigger[];
  origin: string;
  type: 'ai' | 'tool' | 'site';
  patterns?: string[];
  endpoint?: string;
  shortcuts?: ToolShortcut[];
  resultHandler?: AddressBarResultHandler;
  createdAt: number;
}
