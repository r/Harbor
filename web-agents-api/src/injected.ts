/**
 * Web Agents API - Injected Script
 *
 * This script is injected into web pages to expose:
 * - window.ai - Text generation API (Chrome Prompt API compatible)
 * - window.agent - Tools, browser access, and tool calling capabilities
 *
 * APIs are gated by feature flags configured in the Web Agents API sidebar.
 */

// Make this a module to avoid global scope conflicts
export {};

// =============================================================================
// Feature Flags
// =============================================================================

interface FeatureFlags {
  textGeneration: boolean;
  toolCalling: boolean;
  toolAccess: boolean;
  browserInteraction: boolean;
  browserControl: boolean;
  multiAgent: boolean;
}

// Read feature flags from injected JSON element
function getFeatureFlags(): FeatureFlags {
  const defaults: FeatureFlags = {
    textGeneration: true,
    toolCalling: false,
    toolAccess: true,
    browserInteraction: false,
    browserControl: false,
    multiAgent: false,
  };

  try {
    const flagsElement = document.getElementById('web-agents-api-flags');
    if (flagsElement?.textContent) {
      const parsed = JSON.parse(flagsElement.textContent) as Partial<FeatureFlags>;
      return { ...defaults, ...parsed };
    }
  } catch {
    // Ignore parse errors, use defaults
  }

  return defaults;
}

const FEATURE_FLAGS = getFeatureFlags();

/**
 * Create a function that throws ERR_FEATURE_DISABLED for disabled features.
 */
function featureDisabled(featureName: string): () => never {
  return () => {
    const err = new Error(`Feature "${featureName}" is not enabled. Enable it in Web Agents API settings.`);
    (err as Error & { code?: string }).code = 'ERR_FEATURE_DISABLED';
    throw err;
  };
}

/**
 * Create an async function that rejects with ERR_FEATURE_DISABLED for disabled features.
 */
function featureDisabledAsync(featureName: string): () => Promise<never> {
  return async () => {
    const err = new Error(`Feature "${featureName}" is not enabled. Enable it in Web Agents API settings.`);
    (err as Error & { code?: string }).code = 'ERR_FEATURE_DISABLED';
    throw err;
  };
}

// =============================================================================
// Types
// =============================================================================

type PermissionScope =
  | 'model:prompt'
  | 'model:tools'
  | 'model:list'
  | 'mcp:tools.list'
  | 'mcp:tools.call'
  | 'mcp:servers.register'
  | 'browser:activeTab.read'
  | 'browser:activeTab.interact'
  | 'browser:activeTab.screenshot'
  | 'browser:tabs.create'
  | 'browser:tabs.read'
  | 'browser:navigate'
  | 'agents:register'
  | 'agents:invoke'
  | 'chat:open'
  | 'web:fetch';

type PermissionGrant = 'granted-once' | 'granted-always' | 'denied' | 'not-granted';

interface PermissionGrantResult {
  granted: boolean;
  scopes: Record<PermissionScope, PermissionGrant>;
  allowedTools?: string[];
}

interface PermissionStatus {
  origin: string;
  scopes: Record<PermissionScope, PermissionGrant>;
  allowedTools?: string[];
}

interface TextSessionOptions {
  model?: string;
  provider?: string;
  temperature?: number;
  systemPrompt?: string;
}

interface StreamToken {
  type: 'token' | 'done' | 'error';
  token?: string;
  error?: { code: string; message: string };
}

interface LLMProviderInfo {
  id: string;
  type: string;
  name: string;
  available: boolean;
  models?: string[];
  isDefault: boolean;
}

interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  serverId?: string;
}

interface PageToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

/** Registry of page-provided tools, keyed by name. */
const pageTools = new Map<string, PageToolDescriptor>();

// Session types
interface SessionCapabilities {
  llm: { allowed: boolean; provider?: string; model?: string };
  tools: { allowed: boolean; allowedTools: string[] };
  browser: { readActiveTab: boolean; interact: boolean; screenshot: boolean };
  limits?: { maxToolCalls?: number; expiresAt?: number };
}

interface SessionUsage {
  promptCount: number;
  toolCallCount: number;
}

interface SessionSummary {
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
  usage: SessionUsage;
}

interface CreateSessionOptions {
  name?: string;
  reason?: string;
  capabilities: {
    llm?: { provider?: string; model?: string };
    tools?: string[];
    browser?: ('read' | 'interact' | 'screenshot')[];
  };
  limits?: {
    maxToolCalls?: number;
    ttlMinutes?: number;
  };
  options?: {
    systemPrompt?: string;
    temperature?: number;
  };
}

interface CreateSessionResult {
  success: boolean;
  sessionId?: string;
  capabilities?: SessionCapabilities;
  error?: { code: string; message: string };
}

// =============================================================================
// Transport Layer
// =============================================================================

const CHANNEL = 'web_agents_api';

interface TransportResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

interface TransportStreamEvent {
  id: string;
  event: StreamToken;
  done?: boolean;
}

const pendingRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }
>();

const streamListeners = new Map<string, (event: StreamToken, done: boolean) => void>();

// Initialize transport
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;

  const data = event.data as {
    channel?: string;
    response?: TransportResponse;
    streamEvent?: TransportStreamEvent;
  };

  if (data?.channel !== CHANNEL) return;

  // Handle regular response
  if (data.response) {
    const pending = pendingRequests.get(data.response.id);
    if (pending) {
      pendingRequests.delete(data.response.id);
      if (data.response.ok) {
        pending.resolve(data.response.result);
      } else {
        const err = new Error(data.response.error?.message || 'Request failed');
        (err as Error & { code?: string }).code = data.response.error?.code;
        pending.reject(err);
      }
    }
  }

  // Handle stream event
  if (data.streamEvent) {
    const eventType = (data.streamEvent.event as { type?: string })?.type;
    const hasListener = streamListeners.has(data.streamEvent.id);
    
    // Log ALL events to debug ID mismatch
    if (!hasListener || eventType !== 'token') {
      console.log('[Web Agents API:Injected] Stream event arrived:', {
        eventId: data.streamEvent.id,
        eventType,
        done: data.streamEvent.done,
        hasListener,
        registeredIds: Array.from(streamListeners.keys()),
      });
    }
    
    const listener = streamListeners.get(data.streamEvent.id);
    if (listener) {
      listener(data.streamEvent.event, data.streamEvent.done || false);
      if (data.streamEvent.done) {
        console.log('[Web Agents API:Injected] Stream complete, removing listener:', data.streamEvent.id);
        streamListeners.delete(data.streamEvent.id);
      }
    } else {
      console.warn('[Web Agents API:Injected] ⚠️ NO LISTENER for event ID:', data.streamEvent.id, 'registered IDs:', Array.from(streamListeners.keys()));
    }
  }
});

function sendRequest<T>(type: string, payload?: unknown): Promise<T> {
  const id = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });

    window.postMessage({ channel: CHANNEL, request: { id, type, payload } }, '*');

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        const err = new Error('Request timeout');
        (err as Error & { code?: string }).code = 'ERR_TIMEOUT';
        reject(err);
      }
    }, 30000);
  });
}

function createStreamIterable<T extends StreamToken>(
  type: string,
  payload?: unknown,
): AsyncIterable<T> {
  const id = crypto.randomUUID();

  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const queue: T[] = [];
      let resolveNext: ((result: IteratorResult<T>) => void) | null = null;
      let done = false;
      let error: Error | null = null;

      // Register stream listener before sending request
      console.log('[Web Agents API:Injected] Registering stream listener:', id, 'for type:', type);
      let tokenCount = 0;
      streamListeners.set(id, (event, isDone) => {
        tokenCount++;
        if (tokenCount <= 3 || isDone) {
          console.log('[Web Agents API:Injected] Listener received event #' + tokenCount + ':', {
            id,
            eventType: (event as { type?: string }).type,
            hasToken: !!(event as { token?: string }).token,
            isDone,
          });
        }
        if (isDone) {
          console.log('[Web Agents API:Injected] Stream DONE, total tokens:', tokenCount);
          done = true;
          streamListeners.delete(id);
        }

        // Check for error event
        if ('type' in event && event.type === 'error') {
          error = new Error(event.error?.message || 'Stream error');
          (error as Error & { code?: string }).code = event.error?.code || 'ERR_INTERNAL';
          done = true;
        }

        if (resolveNext && !error) {
          resolveNext({ done: false, value: event as T });
          resolveNext = null;
        } else if (!error) {
          queue.push(event as T);
        }
      });

      // Send the request
      window.postMessage({ channel: CHANNEL, request: { id, type, payload } }, '*');

      return {
        async next(): Promise<IteratorResult<T>> {
          if (error) {
            throw error;
          }

          if (queue.length > 0) {
            return { done: false, value: queue.shift()! };
          }

          if (done) {
            return { done: true, value: undefined };
          }

          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },

        async return(): Promise<IteratorResult<T>> {
          done = true;
          streamListeners.delete(id);
          // Send abort signal
          window.postMessage({ channel: CHANNEL, abort: { id } }, '*');
          return { done: true, value: undefined };
        },
      };
    },
  };
}

// =============================================================================
// TextSession Implementation
// =============================================================================

interface TextSession {
  readonly sessionId: string;
  prompt(input: string): Promise<string>;
  promptStreaming(input: string): AsyncIterable<string>;
  destroy(): void;
}

function createTextSessionObject(sessionId: string): TextSession {
  return Object.freeze({
    sessionId,

    async prompt(input: string): Promise<string> {
      return sendRequest<string>('session.prompt', { sessionId, input });
    },

    promptStreaming(input: string): AsyncIterable<string> {
      console.log('[Web Agents API:Injected] promptStreaming called for session:', sessionId);
      const tokenIterable = createStreamIterable<StreamToken>('session.promptStreaming', { sessionId, input });
      
      // Transform to yield just the token strings
      return {
        [Symbol.asyncIterator]() {
          console.log('[Web Agents API:Injected] promptStreaming [Symbol.asyncIterator] called');
          const tokenIterator = tokenIterable[Symbol.asyncIterator]();
          let yieldCount = 0;
          
          return {
            async next(): Promise<IteratorResult<string>> {
              console.log('[Web Agents API:Injected] promptStreaming next() called, waiting for tokenIterator...');
              const result = await tokenIterator.next();
              console.log('[Web Agents API:Injected] promptStreaming got result:', {
                done: result.done,
                valueType: result.value?.type,
                hasToken: !!result.value?.token,
              });
              if (result.done) {
                console.log('[Web Agents API:Injected] promptStreaming iterator done, yielded:', yieldCount);
                return { done: true, value: undefined };
              }
              if (result.value.type === 'token' && result.value.token) {
                yieldCount++;
                return { done: false, value: result.value.token };
              }
              if (result.value.type === 'done') {
                console.log('[Web Agents API:Injected] promptStreaming received done event, yielded:', yieldCount);
                return { done: true, value: undefined };
              }
              if (result.value.type === 'error') {
                throw new Error(result.value.error?.message || 'Stream error');
              }
              // Continue to next token
              return this.next();
            },
            
            async return(): Promise<IteratorResult<string>> {
              await tokenIterator.return?.();
              return { done: true, value: undefined };
            },
          };
        },
      };
    },

    destroy(): void {
      sendRequest('session.destroy', { sessionId }).catch(() => {});
    },
  });
}

// =============================================================================
// window.ai Implementation
// =============================================================================

const aiApi = Object.freeze({
  async canCreateTextSession(): Promise<'readily' | 'after-download' | 'no'> {
    return sendRequest<'readily' | 'after-download' | 'no'>('ai.canCreateTextSession');
  },

  async createTextSession(options: TextSessionOptions = {}): Promise<TextSession> {
    const sessionId = await sendRequest<string>('ai.createTextSession', options);
    return createTextSessionObject(sessionId);
  },

  languageModel: Object.freeze({
    async capabilities(): Promise<{
      available: 'readily' | 'after-download' | 'no';
      defaultTopK?: number;
      maxTopK?: number;
      defaultTemperature?: number;
    }> {
      return sendRequest('ai.languageModel.capabilities');
    },

    async create(options: {
      systemPrompt?: string;
      temperature?: number;
      topK?: number;
    } = {}): Promise<TextSession> {
      const sessionOptions: TextSessionOptions = {
        systemPrompt: options.systemPrompt,
        temperature: options.temperature,
      };
      const sessionId = await sendRequest<string>('ai.languageModel.create', {
        ...sessionOptions,
        topK: options.topK,
      });
      return createTextSessionObject(sessionId);
    },
  }),

  providers: Object.freeze({
    async list(): Promise<LLMProviderInfo[]> {
      return sendRequest<LLMProviderInfo[]>('ai.providers.list');
    },

    async getActive(): Promise<{ provider: string | null; model: string | null }> {
      return sendRequest('ai.providers.getActive');
    },

    /** List configured models (Harbor named aliases, e.g. "llama", "gpt"). */
    async listConfiguredModels(): Promise<Array<{ name: string; model_id: string; is_default?: boolean }>> {
      return sendRequest<Array<{ name: string; model_id: string; is_default?: boolean }>>(
        'ai.providers.listConfiguredModels'
      );
    },

    /** Metadata for configured models (companion to listConfiguredModels). Use model_id to correlate; includes is_local. */
    async getConfiguredModelsMetadata(): Promise<Array<{ model_id: string; is_local: boolean }>> {
      return sendRequest<Array<{ model_id: string; is_local: boolean }>>(
        'ai.providers.getConfiguredModelsMetadata'
      );
    },
  }),
});

// =============================================================================
// AgentSession Implementation
// =============================================================================

interface AgentSession {
  readonly sessionId: string;
  readonly capabilities: SessionCapabilities;
  prompt(input: string): Promise<string>;
  promptStreaming(input: string): AsyncIterable<string>;
  callTool(tool: string, args?: Record<string, unknown>): Promise<unknown>;
  listAllowedTools(): string[];
  terminate(): Promise<void>;
}

function createAgentSessionObject(
  sessionId: string,
  capabilities: SessionCapabilities,
): AgentSession {
  return Object.freeze({
    sessionId,
    capabilities,

    async prompt(input: string): Promise<string> {
      if (!capabilities.llm.allowed) {
        throw new Error('Session does not have LLM access');
      }
      return sendRequest<string>('session.prompt', { sessionId, input });
    },

    promptStreaming(input: string): AsyncIterable<string> {
      if (!capabilities.llm.allowed) {
        throw new Error('Session does not have LLM access');
      }
      const tokenIterable = createStreamIterable<StreamToken>('session.promptStreaming', { sessionId, input });
      
      return {
        [Symbol.asyncIterator]() {
          const tokenIterator = tokenIterable[Symbol.asyncIterator]();
          
          return {
            async next(): Promise<IteratorResult<string>> {
              const result = await tokenIterator.next();
              if (result.done) {
                return { done: true, value: undefined };
              }
              if (result.value.type === 'token' && result.value.token) {
                return { done: false, value: result.value.token };
              }
              if (result.value.type === 'done') {
                return { done: true, value: undefined };
              }
              if (result.value.type === 'error') {
                throw new Error(result.value.error?.message || 'Stream error');
              }
              return this.next();
            },
            
            async return(): Promise<IteratorResult<string>> {
              await tokenIterator.return?.();
              return { done: true, value: undefined };
            },
          };
        },
      };
    },

    async callTool(tool: string, args?: Record<string, unknown>): Promise<unknown> {
      if (!capabilities.tools.allowed) {
        throw new Error('Session does not have tool access');
      }
      if (!capabilities.tools.allowedTools.includes(tool)) {
        throw new Error(`Tool ${tool} not allowed in this session`);
      }
      return sendRequest('agent.tools.call', { tool, args, sessionId });
    },

    listAllowedTools(): string[] {
      return capabilities.tools.allowedTools;
    },

    async terminate(): Promise<void> {
      await sendRequest('agent.sessions.terminate', { sessionId });
    },
  });
}

// =============================================================================
// Browser API Implementation
// =============================================================================

// Browser API types
interface ReadabilityContent {
  title: string;
  content: string;
  textContent: string;
  excerpt: string;
  byline: string | null;
  siteName: string | null;
}

interface BrowserElement {
  ref: string;
  role: string;
  text?: string;
  placeholder?: string;
  value?: string;
  checked?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

// Create browser API object
function createBrowserApi() {
  return Object.freeze({
    activeTab: Object.freeze({
      /**
       * Get readable content from the current page using readability parser.
       */
      readability: FEATURE_FLAGS.browserInteraction || FEATURE_FLAGS.browserControl
        ? async function(): Promise<ReadabilityContent> {
            return sendRequest<ReadabilityContent>('agent.browser.activeTab.readability');
          }
        : featureDisabledAsync('browserInteraction'),

      /**
       * Get visible interactive elements on the page.
       */
      getElements: FEATURE_FLAGS.browserInteraction
        ? async function(): Promise<BrowserElement[]> {
            return sendRequest<BrowserElement[]>('agent.browser.activeTab.getElements');
          }
        : featureDisabledAsync('browserInteraction'),

      /**
       * Click an element by ref.
       */
      click: FEATURE_FLAGS.browserInteraction
        ? async function(ref: string): Promise<{ success: boolean }> {
            return sendRequest('agent.browser.activeTab.click', { ref });
          }
        : featureDisabledAsync('browserInteraction'),

      /**
       * Fill a form field.
       */
      fill: FEATURE_FLAGS.browserInteraction
        ? async function(ref: string, value: string): Promise<{ success: boolean }> {
            return sendRequest('agent.browser.activeTab.fill', { ref, value });
          }
        : featureDisabledAsync('browserInteraction'),

      /**
       * Scroll the page.
       */
      scroll: FEATURE_FLAGS.browserInteraction
        ? async function(direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<{ success: boolean }> {
            return sendRequest('agent.browser.activeTab.scroll', { direction, amount });
          }
        : featureDisabledAsync('browserInteraction'),

      /**
       * Select an option from a dropdown.
       */
      select: FEATURE_FLAGS.browserInteraction
        ? async function(ref: string, value: string): Promise<{ success: boolean }> {
            return sendRequest('agent.browser.activeTab.select', { ref, value });
          }
        : featureDisabledAsync('browserInteraction'),

      /**
       * Take a screenshot.
       */
      screenshot: FEATURE_FLAGS.browserInteraction
        ? async function(): Promise<{ dataUrl: string }> {
            return sendRequest('agent.browser.activeTab.screenshot');
          }
        : featureDisabledAsync('browserInteraction'),
    }),

    /**
     * Navigate to a URL.
     */
    navigate: FEATURE_FLAGS.browserControl
      ? async function(url: string): Promise<{ success: boolean }> {
          return sendRequest('agent.browser.navigate', { url });
        }
      : featureDisabledAsync('browserControl'),

    /**
     * Fetch a URL (CORS-bypassing).
     */
    fetch: FEATURE_FLAGS.browserControl
      ? async function(url: string, options?: RequestInit): Promise<{ body: string; status: number; headers: Record<string, string> }> {
          return sendRequest('agent.browser.fetch', { url, options });
        }
      : featureDisabledAsync('browserControl'),

    /**
     * Tab management (browserControl required).
     */
    tabs: FEATURE_FLAGS.browserControl
      ? Object.freeze({
          async list(): Promise<Array<{
            id: number;
            url: string;
            title: string;
            active: boolean;
            index: number;
            windowId: number;
            favIconUrl?: string;
            status?: 'loading' | 'complete';
            canControl: boolean;
          }>> {
            return sendRequest('agent.browser.tabs.list');
          },
          async create(options: {
            url: string;
            active?: boolean;
            index?: number;
            windowId?: number;
          }): Promise<{
            id: number;
            url: string;
            title: string;
            active: boolean;
            index: number;
            windowId: number;
            canControl: boolean;
          }> {
            return sendRequest('agent.browser.tabs.create', options);
          },
          async close(tabId: number): Promise<boolean> {
            return sendRequest('agent.browser.tabs.close', { tabId });
          },
        })
      : {
          list: featureDisabledAsync('browserControl'),
          create: featureDisabledAsync('browserControl'),
          close: featureDisabledAsync('browserControl'),
        },

    /**
     * Spawned tab operations - for tabs this origin created.
     */
    tab: FEATURE_FLAGS.browserControl
      ? Object.freeze({
          /**
           * Extract readable content from a tab this origin created.
           */
          async readability(tabId: number): Promise<{
            title: string;
            url: string;
            content: string;
            text: string;
            length: number;
          }> {
            return sendRequest('agent.browser.tab.readability', { tabId });
          },

          /**
           * Get HTML content from a tab this origin created.
           * @param tabId - The tab ID
           * @param selector - Optional CSS selector to scope the HTML extraction
           */
          async getHtml(tabId: number, selector?: string): Promise<{
            html: string;
            url: string;
            title: string;
          }> {
            return sendRequest('agent.browser.tab.getHtml', { tabId, selector });
          },

          /**
           * Wait for a tab to finish loading.
           * @param tabId - The tab ID
           * @param options - Optional timeout in milliseconds (default 30000)
           */
          async waitForLoad(tabId: number, options?: { timeout?: number }): Promise<void> {
            return sendRequest('agent.browser.tab.waitForLoad', { tabId, ...options });
          },
        })
      : {
          readability: featureDisabledAsync('browserControl'),
          getHtml: featureDisabledAsync('browserControl'),
          waitForLoad: featureDisabledAsync('browserControl'),
        },
  });
}

// =============================================================================
// Multi-Agent Types (for injected script)
// =============================================================================

interface AgentRegisterOptions {
  name: string;
  description?: string;
  capabilities?: string[];
  tags?: string[];
  acceptsInvocations?: boolean;
  acceptsMessages?: boolean;
}

interface RegisteredAgent {
  id: string;
  name: string;
  description?: string;
  capabilities: string[];
  tags: string[];
  status: 'active' | 'suspended' | 'terminated';
  origin: string;
  acceptsInvocations: boolean;
  acceptsMessages: boolean;
  registeredAt: number;
  lastActiveAt: number;
}

interface AgentSummary {
  id: string;
  name: string;
  description?: string;
  capabilities: string[];
  tags: string[];
  status: 'active' | 'suspended' | 'terminated';
  sameOrigin: boolean;
  isRemote: boolean;
}

interface AgentDiscoveryQuery {
  name?: string;
  capabilities?: string[];
  tags?: string[];
  includeSameOrigin?: boolean;
  includeCrossOrigin?: boolean;
}

interface AgentInvocationRequest {
  task: string;
  input?: unknown;
  timeout?: number;
}

interface AgentInvocationResponse {
  success: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  executionTime?: number;
}

interface AgentMessage {
  id: string;
  from: string;
  to: string;
  type: 'request' | 'response' | 'event' | 'error';
  payload: unknown;
  correlationId?: string;
  timestamp: number;
}

interface PipelineStep {
  agentId: string;
  task: string;
  inputTransform?: string;
  outputTransform?: string;
}

interface ParallelTask {
  agentId: string;
  task: string;
  input?: unknown;
}

// Store for message and invocation handlers
const agentMessageHandlers: Array<(message: AgentMessage) => void> = [];
const agentInvocationHandlers: Array<(request: AgentInvocationRequest & { from: string }) => Promise<unknown>> = [];
const agentEventSubscriptions = new Map<string, Array<(event: { type: string; data: unknown; source: string }) => void>>();

// Current agent ID (set after registration)
let currentAgentId: string | null = null;

/**
 * Create the multi-agent API object.
 */
function createMultiAgentApi() {
  return Object.freeze({
    /**
     * Register this page as an agent.
     * 
     * @example
     * const agent = await window.agent.agents.register({
     *   name: 'Researcher',
     *   capabilities: ['search', 'summarize'],
     *   acceptsInvocations: true,
     * });
     */
    async register(options: AgentRegisterOptions): Promise<RegisteredAgent> {
      const result = await sendRequest<RegisteredAgent>('agent.agents.register', options);
      currentAgentId = result.id;
      
      // Set up event listener for incoming messages/invocations
      setupAgentEventListener();
      
      return result;
    },

    /**
     * Unregister this agent.
     */
    async unregister(agentId?: string): Promise<void> {
      const idToUnregister = agentId || currentAgentId;
      if (!idToUnregister) {
        throw new Error('Agent not registered');
      }
      await sendRequest('agent.agents.unregister', { agentId: idToUnregister });
      if (idToUnregister === currentAgentId) {
        currentAgentId = null;
      }
    },

    /**
     * Get information about an agent by ID.
     */
    async getInfo(agentId: string): Promise<RegisteredAgent | null> {
      return sendRequest<RegisteredAgent | null>('agent.agents.getInfo', { agentId });
    },

    /**
     * Discover agents matching a query.
     * 
     * @example
     * const result = await window.agent.agents.discover({
     *   capabilities: ['search'],
     *   includeSameOrigin: true,
     * });
     * console.log('Found agents:', result.agents);
     */
    async discover(query: AgentDiscoveryQuery = {}): Promise<{ agents: AgentSummary[]; total: number }> {
      return sendRequest('agent.agents.discover', query);
    },

    /**
     * List all registered agents visible to this origin.
     */
    async list(): Promise<AgentSummary[]> {
      const result = await sendRequest<{ agents: AgentSummary[] }>('agent.agents.list');
      return result.agents;
    },

    /**
     * Invoke another agent to perform a task.
     * 
     * @example
     * const response = await window.agent.agents.invoke(researcherId, {
     *   task: 'research',
     *   input: { topic: 'AI safety' },
     *   timeout: 30000,
     * });
     */
    async invoke(agentId: string, request: AgentInvocationRequest): Promise<AgentInvocationResponse> {
      return sendRequest('agent.agents.invoke', { agentId, request });
    },

    /**
     * Send a message to another agent.
     */
    async send(agentId: string, payload: unknown): Promise<{ delivered: boolean }> {
      return sendRequest('agent.agents.send', { agentId, payload });
    },

    /**
     * Register a handler for incoming messages.
     * 
     * @example
     * window.agent.agents.onMessage((message) => {
     *   console.log('Received from', message.from, ':', message.payload);
     * });
     */
    onMessage(handler: (message: AgentMessage) => void): () => void {
      agentMessageHandlers.push(handler);
      return () => {
        const index = agentMessageHandlers.indexOf(handler);
        if (index >= 0) agentMessageHandlers.splice(index, 1);
      };
    },

    /**
     * Register a handler for incoming invocations.
     * 
     * @example
     * window.agent.agents.onInvoke(async (request) => {
     *   if (request.task === 'research') {
     *     return { findings: ['...'] };
     *   }
     *   throw new Error('Unknown task');
     * });
     */
    onInvoke(handler: (request: AgentInvocationRequest & { from: string }) => Promise<unknown>): () => void {
      agentInvocationHandlers.push(handler);
      return () => {
        const index = agentInvocationHandlers.indexOf(handler);
        if (index >= 0) agentInvocationHandlers.splice(index, 1);
      };
    },

    /**
     * Subscribe to events of a specific type.
     */
    async subscribe(eventType: string, handler: (event: { type: string; data: unknown; source: string }) => void): Promise<void> {
      if (!agentEventSubscriptions.has(eventType)) {
        agentEventSubscriptions.set(eventType, []);
        // Tell background we're subscribing to this event type
        await sendRequest('agent.agents.subscribe', { eventType });
      }
      agentEventSubscriptions.get(eventType)!.push(handler);
    },

    /**
     * Unsubscribe from events of a specific type.
     */
    async unsubscribe(eventType: string, handler?: (event: { type: string; data: unknown; source: string }) => void): Promise<void> {
      const handlers = agentEventSubscriptions.get(eventType);
      if (!handlers) return;
      
      if (handler) {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      } else {
        handlers.length = 0;
      }
      
      if (handlers.length === 0) {
        agentEventSubscriptions.delete(eventType);
        await sendRequest('agent.agents.unsubscribe', { eventType });
      }
    },

    /**
     * Broadcast an event to all subscribed agents.
     */
    async broadcast(eventType: string, data: unknown): Promise<{ delivered: number }> {
      return sendRequest('agent.agents.broadcast', { eventType, data });
    },

    /**
     * Orchestration patterns for multi-agent workflows.
     */
    orchestrate: Object.freeze({
      /**
       * Execute a pipeline of agents sequentially.
       * Each step's output becomes the next step's input.
       * 
       * @example
       * const result = await window.agent.agents.orchestrate.pipeline({
       *   steps: [
       *     { agentId: researcherId, task: 'research' },
       *     { agentId: writerId, task: 'write' },
       *   ],
       * }, { topic: 'AI' });
       */
      async pipeline(
        config: { steps: PipelineStep[] },
        initialInput: unknown,
      ): Promise<{ success: boolean; result: unknown; stepResults: unknown[] }> {
        return sendRequest('agent.agents.orchestrate.pipeline', { config, initialInput });
      },

      /**
       * Execute multiple agents in parallel.
       * 
       * @example
       * const result = await window.agent.agents.orchestrate.parallel({
       *   tasks: [
       *     { agentId: agent1, task: 'analyze', input: data },
       *     { agentId: agent2, task: 'validate', input: data },
       *   ],
       *   combineStrategy: 'array',
       * });
       */
      async parallel(
        config: { tasks: ParallelTask[]; combineStrategy?: 'array' | 'merge' | 'first' },
      ): Promise<{ success: boolean; results: unknown[]; combined: unknown }> {
        return sendRequest('agent.agents.orchestrate.parallel', { config });
      },

      /**
       * Route input to an agent based on conditions.
       * 
       * @example
       * const result = await window.agent.agents.orchestrate.route({
       *   routes: [
       *     { condition: 'type:technical', agentId: techAgent },
       *     { condition: 'type:creative', agentId: creativeAgent },
       *   ],
       *   defaultAgentId: generalAgent,
       * }, input, 'process');
       */
      async route(
        config: { routes: Array<{ condition: string; agentId: string }>; defaultAgentId?: string },
        input: unknown,
        task: string,
      ): Promise<AgentInvocationResponse> {
        return sendRequest('agent.agents.orchestrate.route', { config, input, task });
      },
    }),
  });
}

// Track processed invocations at the page level to prevent duplicates
const processedPageInvocations = new Set<string>();

// Track if event listener is already set up
let eventListenerSetUp = false;

/**
 * Set up listener for agent events (messages, invocations, broadcasts).
 * Only sets up once, no matter how many times called.
 */
function setupAgentEventListener() {
  if (eventListenerSetUp) {
    console.log('[Web Agents API Page] Event listener already set up, skipping');
    return;
  }
  eventListenerSetUp = true;
  console.log('[Web Agents API Page] Setting up event listener');
  
  // Listen for agent events from the content script
  window.addEventListener('message', async (event: MessageEvent) => {
    if (event.source !== window) return;
    
    const data = event.data as {
      channel?: string;
      agentEvent?: {
        type: 'message' | 'invocation' | 'broadcast';
        message?: AgentMessage;
        invocation?: AgentInvocationRequest & { from: string; invocationId: string };
        broadcast?: { type: string; data: unknown; source: string };
      };
    };
    
    if (data?.channel !== 'web_agents_api' || !data.agentEvent) return;
    
    const { type, message, invocation, broadcast } = data.agentEvent;
    
    if (type === 'message' && message) {
      // Dispatch to message handlers
      for (const handler of agentMessageHandlers) {
        try {
          handler(message);
        } catch (e) {
          console.error('[Web Agents API] Message handler error:', e);
        }
      }
    } else if (type === 'invocation' && invocation) {
      // Deduplicate invocations
      const invocationId = invocation.invocationId;
      if (processedPageInvocations.has(invocationId)) {
        console.log('[Web Agents API Page] DUPLICATE invocation, skipping:', invocationId);
        return;
      }
      processedPageInvocations.add(invocationId);
      // Clean up after 60 seconds
      setTimeout(() => processedPageInvocations.delete(invocationId), 60000);
      
      console.log('[Web Agents API Page] Processing invocation:', invocation.task, invocationId);
      
      // Dispatch to invocation handlers and send response
      let result: unknown;
      let error: { code: string; message: string } | undefined;
      
      for (const handler of agentInvocationHandlers) {
        try {
          result = await handler(invocation);
          break; // Use first handler's result
        } catch (e) {
          error = {
            code: 'ERR_HANDLER_FAILED',
            message: e instanceof Error ? e.message : 'Handler failed',
          };
        }
      }
      
      // Send response back
      window.postMessage({
        channel: 'web_agents_api',
        agentInvocationResponse: {
          invocationId: invocation.invocationId,
          success: !error,
          result,
          error,
        },
      }, '*');
    } else if (type === 'broadcast' && broadcast) {
      // Dispatch to event subscribers
      const handlers = agentEventSubscriptions.get(broadcast.type);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(broadcast);
          } catch (e) {
            console.error('[Web Agents API] Event handler error:', e);
          }
        }
      }
    }
  });
}

// =============================================================================
// window.agent Implementation
// =============================================================================

const agentApi = Object.freeze({
  async requestPermissions(options: {
    scopes: PermissionScope[];
    reason?: string;
    tools?: string[];
  }): Promise<PermissionGrantResult> {
    return sendRequest<PermissionGrantResult>('agent.requestPermissions', options);
  },

  permissions: Object.freeze({
    async list(): Promise<PermissionStatus> {
      return sendRequest<PermissionStatus>('agent.permissions.list');
    },
  }),

  tools: FEATURE_FLAGS.toolAccess
    ? Object.freeze({
        async list(): Promise<ToolDescriptor[]> {
          // 1. Fetch MCP tools from background/Harbor
          const mcpTools = await sendRequest<ToolDescriptor[]>('agent.tools.list');

          // 2. Build page tool descriptors (serverId: 'page', prefixed name)
          const pageToolDescriptors: ToolDescriptor[] = Array.from(pageTools.values()).map(pt => ({
            name: `page/${pt.name}`,
            description: pt.description,
            inputSchema: pt.inputSchema,
            serverId: 'page',
          }));

          // 3. Merge: MCP tools first, page tools appended
          return [...mcpTools, ...pageToolDescriptors];
        },

        async call(options: { tool: string; args?: Record<string, unknown> }): Promise<unknown> {
          const { tool, args = {} } = options;

          // Check if this is a page tool (serverId 'page' prefix or bare name match)
          let pageToolName: string | null = null;
          if (tool.startsWith('page/')) {
            pageToolName = tool.slice('page/'.length);
          } else if (pageTools.has(tool)) {
            // Bare name also works if it matches a registered page tool
            pageToolName = tool;
          }

          if (pageToolName) {
            const descriptor = pageTools.get(pageToolName);
            if (!descriptor) {
              const err = new Error(`Page tool "${pageToolName}" not found`);
              (err as Error & { code?: string }).code = 'ERR_TOOL_NOT_FOUND';
              throw err;
            }

            // Execute the handler in page context
            try {
              return await Promise.resolve(descriptor.handler(args));
            } catch (e) {
              const err = new Error(e instanceof Error ? e.message : 'Page tool failed');
              (err as Error & { code?: string }).code = 'ERR_TOOL_FAILED';
              throw err;
            }
          }

          // Not a page tool — forward to background (MCP) as before
          return sendRequest('agent.tools.call', options);
        },
      })
    : {
        list: featureDisabledAsync('toolAccess'),
        call: featureDisabledAsync('toolAccess'),
      },

  browser: createBrowserApi(),

  /**
   * MCP (Model Context Protocol) server management.
   * Allows websites to register MCP servers that provide tools to the user's AI.
   */
  mcp: Object.freeze({
    /**
     * Discover MCP servers declared on this page via <link rel="mcp-server">.
     * 
     * @example
     * const servers = await window.agent.mcp.discover();
     * console.log('Found MCP servers:', servers);
     */
    async discover(): Promise<Array<{
      url: string;
      name?: string;
      description?: string;
      tools?: string[];
      transport?: string;
    }>> {
      return sendRequest('agent.mcp.discover');
    },

    /**
     * Register an MCP server with the browser.
     * 
     * @example
     * const result = await window.agent.mcp.register({
     *   url: 'http://localhost:3001/mcp',
     *   name: 'My Shop Assistant',
     *   tools: ['search_products', 'add_to_cart'],
     *   transport: 'sse',
     * });
     */
    async register(options: {
      url: string;
      name: string;
      description?: string;
      tools?: string[];
      transport?: 'sse' | 'stdio' | 'streamable-http';
    }): Promise<{ success: boolean; serverId?: string; error?: { code: string; message: string } }> {
      return sendRequest('agent.mcp.register', options);
    },

    /**
     * Unregister a previously registered MCP server.
     */
    async unregister(serverId: string): Promise<{ success: boolean }> {
      return sendRequest('agent.mcp.unregister', { serverId });
    },
  }),

  /**
   * Browser chat UI management.
   * Allows websites to open the user's AI chat with custom configuration.
   */
  chat: Object.freeze({
    /**
     * Check if the browser chat can be opened.
     */
    async canOpen(): Promise<{ available: boolean; reason?: string }> {
      return sendRequest('agent.chat.canOpen');
    },

    /**
     * Open the browser's chat UI with optional configuration.
     * 
     * @example
     * const result = await window.agent.chat.open({
     *   systemPrompt: 'You are a helpful shopping assistant...',
     *   tools: ['server-id/search_products', 'server-id/add_to_cart'],
     *   style: { accentColor: '#ff9900', theme: 'light' },
     * });
     */
    async open(options?: {
      systemPrompt?: string;
      initialMessage?: string;
      tools?: string[];
      style?: {
        theme?: 'light' | 'dark' | 'auto';
        accentColor?: string;
        position?: 'right' | 'left';
      };
    }): Promise<{ success: boolean; chatId?: string; error?: { code: string; message: string } }> {
      return sendRequest('agent.chat.open', options);
    },

    /**
     * Close a chat opened by this origin.
     */
    async close(chatId: string): Promise<{ success: boolean }> {
      return sendRequest('agent.chat.close', { chatId });
    },
  }),

  /**
   * Run an autonomous agent that can use tools to complete a task.
   * 
   * @example
   * for await (const event of window.agent.run({
   *   task: 'What is the current time?',
   *   maxToolCalls: 3
   * })) {
   *   if (event.type === 'tool_call') {
   *     console.log('Using tool:', event.tool);
   *   }
   *   if (event.type === 'final') {
   *     console.log('Response:', event.output);
   *   }
   * }
   */
  run: FEATURE_FLAGS.toolCalling
    ? function(options: {
        task: string;
        maxToolCalls?: number;
        systemPrompt?: string;
      }): AsyncIterable<
        | { type: 'thinking'; content: string }
        | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
        | { type: 'tool_result'; tool: string; result: unknown }
        | { type: 'final'; output: string }
        | { type: 'error'; error: string }
      > {
        type AgentEvent =
          | { type: 'thinking'; content: string }
          | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
          | { type: 'tool_result'; tool: string; result: unknown }
          | { type: 'final'; output: string }
          | { type: 'error'; error: string };

        const tokenStream = createStreamIterable<StreamToken>('agent.run', options);

        return {
          [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
            const tokenIterator = tokenStream[Symbol.asyncIterator]();

            return {
              async next(): Promise<IteratorResult<AgentEvent>> {
                while (true) {
                  const result = await tokenIterator.next();
                  
                  if (result.done) {
                    return { done: true, value: undefined };
                  }

                  const token = result.value;
                  
                  if (token.type === 'done') {
                    return { done: true, value: undefined };
                  }

                  if (token.type === 'error') {
                    return {
                      done: false,
                      value: { type: 'error', error: token.error?.message || 'Unknown error' },
                    };
                  }

                  if (token.type === 'token' && token.token) {
                    try {
                      // Parse the JSON event from the token
                      const event = JSON.parse(token.token) as AgentEvent;
                      return { done: false, value: event };
                    } catch {
                      // If it's not JSON, skip this token
                      continue;
                    }
                  }
                }
              },

              async return(): Promise<IteratorResult<AgentEvent>> {
                await tokenIterator.return?.();
                return { done: true, value: undefined };
              },
            };
          },
        };
      }
    : featureDisabled('toolCalling'),

  // Session management API (explicit sessions)
  sessions: Object.freeze({
    /**
     * Create an explicit session with specified capabilities.
     * 
     * @example
     * const session = await agent.sessions.create({
     *   name: 'Recipe Assistant',
     *   capabilities: {
     *     llm: { provider: 'ollama' },
     *     tools: ['time-wasm/time.now'],
     *   },
     *   limits: { maxToolCalls: 10 },
     * });
     * 
     * const response = await session.prompt('What time is it?');
     */
    async create(options: CreateSessionOptions): Promise<AgentSession> {
      const result = await sendRequest<CreateSessionResult>('agent.sessions.create', options);
      
      if (!result.success || !result.sessionId || !result.capabilities) {
        const errorMsg = result.error?.message || 'Session creation failed';
        throw new Error(errorMsg);
      }
      
      return createAgentSessionObject(result.sessionId, result.capabilities);
    },

    /**
     * Get a session by ID.
     */
    async get(sessionId: string): Promise<SessionSummary | null> {
      return sendRequest<SessionSummary | null>('agent.sessions.get', { sessionId });
    },

    /**
     * List active sessions for this origin.
     */
    async list(): Promise<SessionSummary[]> {
      return sendRequest<SessionSummary[]>('agent.sessions.list');
    },

    /**
     * Terminate a session.
     */
    async terminate(sessionId: string): Promise<boolean> {
      const result = await sendRequest<{ terminated: boolean }>('agent.sessions.terminate', { sessionId });
      return result.terminated;
    },
  }),

  // Multi-agent API (Extension 3) — re-reads feature flags at call time so toggling in the sidebar takes effect without refresh.
  agents: (() => {
    const real = createMultiAgentApi();
    const check = () => {
      if (!getFeatureFlags().multiAgent) {
        const err = new Error('Feature "multiAgent" is not enabled. Enable it in Web Agents API settings.');
        (err as Error & { code?: string }).code = 'ERR_FEATURE_DISABLED';
        throw err;
      }
    };
    const checkAsync = async () => {
      if (!getFeatureFlags().multiAgent) {
        const err = new Error('Feature "multiAgent" is not enabled. Enable it in Web Agents API settings.');
        (err as Error & { code?: string }).code = 'ERR_FEATURE_DISABLED';
        throw err;
      }
    };
    return Object.freeze({
      register: async (options: AgentRegisterOptions) => {
        await checkAsync();
        return real.register(options);
      },
      unregister: async (agentId?: string) => {
        await checkAsync();
        return real.unregister(agentId);
      },
      getInfo: async (agentId: string) => {
        await checkAsync();
        return real.getInfo(agentId);
      },
      discover: async (query?: AgentDiscoveryQuery) => {
        await checkAsync();
        return real.discover(query);
      },
      list: async () => {
        await checkAsync();
        return real.list();
      },
      invoke: async (agentId: string, request: AgentInvocationRequest) => {
        await checkAsync();
        return real.invoke(agentId, request);
      },
      send: async (agentId: string, payload: unknown) => {
        await checkAsync();
        return real.send(agentId, payload);
      },
      onMessage: (handler: (message: AgentMessage) => void) => {
        check();
        return real.onMessage(handler);
      },
      onInvoke: (handler: (request: AgentInvocationRequest & { from: string }) => Promise<unknown>) => {
        check();
        return real.onInvoke(handler);
      },
      subscribe: async (eventType: string, handler: (event: { type: string; data: unknown; source: string }) => void) => {
        await checkAsync();
        return real.subscribe(eventType, handler);
      },
      unsubscribe: async (eventType: string, handler?: (event: { type: string; data: unknown; source: string }) => void) => {
        await checkAsync();
        return real.unsubscribe(eventType, handler);
      },
      broadcast: async (eventType: string, data: unknown) => {
        await checkAsync();
        return real.broadcast(eventType, data);
      },
      orchestrate: Object.freeze({
        pipeline: async (config: { steps: PipelineStep[] }, initialInput: unknown) => {
          await checkAsync();
          return real.orchestrate.pipeline(config, initialInput);
        },
        parallel: async (config: { tasks: ParallelTask[]; combineStrategy?: 'array' | 'merge' | 'first' }) => {
          await checkAsync();
          return real.orchestrate.parallel(config);
        },
        route: async (
          config: { routes: Array<{ condition: string; agentId: string }>; defaultAgentId?: string },
          input: unknown,
          task: string
        ) => {
          await checkAsync();
          return real.orchestrate.route(config, input, task);
        },
      }),
    });
  })(),
});

// =============================================================================
// navigator.modelContext Polyfill (Web MCP)
// =============================================================================

/**
 * navigator.modelContext — Web MCP compatibility surface.
 *
 * Pages call:
 *   navigator.modelContext.addTool({ name, description, inputSchema, handler })
 *   navigator.modelContext.removeTool(name)
 *   navigator.modelContext.tools  // current snapshot
 */
const modelContext = Object.freeze({
  addTool(descriptor: PageToolDescriptor): void {
    if (!descriptor.name || typeof descriptor.handler !== 'function') {
      throw new TypeError('addTool requires { name: string, handler: function }');
    }
    if (pageTools.has(descriptor.name)) {
      console.warn(`[Web Agents API] page tool "${descriptor.name}" replaced`);
    }
    pageTools.set(descriptor.name, descriptor);
  },

  removeTool(name: string): boolean {
    return pageTools.delete(name);
  },

  get tools(): PageToolDescriptor[] {
    return Array.from(pageTools.values());
  },
});

// =============================================================================
// Register Global APIs
// =============================================================================

/**
 * Safely define a property on window.
 */
function safeDefineProperty(
  name: string,
  value: unknown,
): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(window, name);
    if (descriptor && !descriptor.configurable) {
      console.debug(`[Web Agents API] Skipping ${name} - already defined`);
      return false;
    }

    Object.defineProperty(window, name, {
      value,
      writable: false,
      configurable: true,
      enumerable: true,
    });
    return true;
  } catch (error) {
    console.debug(`[Web Agents API] Could not define window.${name}:`, error);
    return false;
  }
}

try {
  // Check if Chrome AI is already present
  const existingAi = (window as { ai?: unknown }).ai;
  const chromeAiDetected = existingAi !== undefined && existingAi !== null;

  // Register window.ai (skip if Chrome AI is present, or if textGeneration is disabled)
  if (FEATURE_FLAGS.textGeneration && !chromeAiDetected) {
    safeDefineProperty('ai', aiApi);
  } else if (!FEATURE_FLAGS.textGeneration) {
    console.debug('[Web Agents API] Text generation disabled, window.ai not registered.');
  } else {
    console.debug('[Web Agents API] Chrome AI detected, window.ai not overridden.');
  }

  // Register window.agent
  const existingAgent = (window as { agent?: unknown }).agent;
  if (existingAgent === undefined) {
    safeDefineProperty('agent', agentApi);
  }

  // Register navigator.modelContext (Web MCP polyfill)
  try {
    const existingModelContext = Object.getOwnPropertyDescriptor(navigator, 'modelContext');
    if (!existingModelContext) {
      Object.defineProperty(navigator, 'modelContext', {
        value: modelContext,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    }
  } catch (e) {
    console.debug('[Web Agents API] Could not define navigator.modelContext:', e);
  }

  // Dispatch ready event with feature flags info
  window.dispatchEvent(
    new CustomEvent('agent-ready', {
      detail: {
        version: '1.0.0',
        chromeAiDetected,
        features: {
          textGeneration: FEATURE_FLAGS.textGeneration,
          toolCalling: FEATURE_FLAGS.toolCalling,
          toolAccess: FEATURE_FLAGS.toolAccess,
          browserInteraction: FEATURE_FLAGS.browserInteraction,
          browserControl: FEATURE_FLAGS.browserControl,
          multiAgent: FEATURE_FLAGS.multiAgent,
        },
      },
    }),
  );
  
  console.debug('[Web Agents API] Registered with features:', FEATURE_FLAGS);
} catch (error) {
  console.warn('[Web Agents API] Failed to register API', error);
}
