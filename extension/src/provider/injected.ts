/**
 * Harbor JS AI Provider - Injected Script
 * 
 * This script runs in the page context and creates the window.ai and window.agent APIs.
 * It communicates with the content script via window.postMessage.
 */

import type {
  ApiError,
  PermissionScope,
  PermissionGrant,
  PermissionGrantResult,
  PermissionStatus,
  ToolDescriptor,
  ActiveTabReadability,
  TextSessionOptions,
  StreamToken,
  AgentRunOptions,
  RunEvent,
  Citation,
  ProviderMessage,
  PROVIDER_MESSAGE_NAMESPACE,
} from './types';

// Use a unique namespace for our messages
const NAMESPACE = 'harbor-provider';

// Request ID counter
let requestIdCounter = 0;

// Pending requests waiting for responses
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

// Stream listeners for streaming responses
const streamListeners = new Map<string, {
  onToken: (token: StreamToken) => void;
  onEvent: (event: RunEvent) => void;
}>();

// =============================================================================
// Message Handling
// =============================================================================

function generateRequestId(): string {
  return `${Date.now()}-${++requestIdCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function sendMessage(type: string, payload?: unknown): string {
  const requestId = generateRequestId();
  const message: ProviderMessage = {
    namespace: NAMESPACE as typeof PROVIDER_MESSAGE_NAMESPACE,
    type: type as ProviderMessage['type'],
    requestId,
    payload,
  };
  
  window.postMessage(message, '*');
  return requestId;
}

function sendRequest<T>(type: string, payload?: unknown, timeoutMs = 30000): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = sendMessage(type, payload);
    
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(createApiError('ERR_TIMEOUT', 'Request timed out'));
    }, timeoutMs);
    
    pendingRequests.set(requestId, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timeout,
    });
  });
}

// Listen for responses from content script
window.addEventListener('message', (event) => {
  // Only accept messages from same window
  if (event.source !== window) return;
  
  const data = event.data;
  if (!data || data.namespace !== NAMESPACE) return;
  
  // Check if this is a response to a pending request
  const pending = pendingRequests.get(data.requestId);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingRequests.delete(data.requestId);
    
    if (data.type === 'error') {
      pending.reject(createApiError(
        data.payload?.error?.code || 'ERR_INTERNAL',
        data.payload?.error?.message || 'Unknown error',
        data.payload?.error?.details
      ));
    } else {
      pending.resolve(data.payload);
    }
    return;
  }
  
  // Check for streaming events
  const streamRequestId = data.payload?.requestId;
  const listener = streamListeners.get(streamRequestId);
  if (listener) {
    if (data.type === 'text_session_stream_token') {
      listener.onToken(data.payload.token);
    } else if (data.type === 'text_session_stream_done') {
      listener.onToken({ type: 'done' });
      streamListeners.delete(streamRequestId);
    } else if (data.type === 'agent_run_event') {
      listener.onEvent(data.payload.event);
      if (data.payload.event.type === 'final' || data.payload.event.type === 'error') {
        streamListeners.delete(streamRequestId);
      }
    }
  }
});

// =============================================================================
// Error Helpers
// =============================================================================

function createApiError(code: ApiError['code'], message: string, details?: unknown): Error & { code: string; details?: unknown } {
  const error = new Error(message) as Error & { code: string; details?: unknown };
  error.code = code;
  error.details = details;
  return error;
}

// =============================================================================
// window.ai API Implementation
// =============================================================================

interface TextSessionImpl {
  sessionId: string;
  destroyed: boolean;
}

const aiApi = {
  /**
   * Create a new text generation session.
   * Requires "model:prompt" permission scope.
   */
  async createTextSession(options?: TextSessionOptions): Promise<{
    sessionId: string;
    prompt(input: string): Promise<string>;
    promptStreaming(input: string): AsyncIterable<StreamToken>;
    destroy(): Promise<void>;
  }> {
    const result = await sendRequest<{ sessionId: string }>('create_text_session', { options });
    
    const session: TextSessionImpl = {
      sessionId: result.sessionId,
      destroyed: false,
    };
    
    return {
      sessionId: session.sessionId,
      
      async prompt(input: string): Promise<string> {
        if (session.destroyed) {
          throw createApiError('ERR_SESSION_NOT_FOUND', 'Session has been destroyed');
        }
        
        const promptResult = await sendRequest<{ result: string }>('text_session_prompt', {
          sessionId: session.sessionId,
          input,
          streaming: false,
        }, 180000); // 3 minute timeout for LLM
        
        return promptResult.result;
      },
      
      promptStreaming(input: string): AsyncIterable<StreamToken> {
        if (session.destroyed) {
          throw createApiError('ERR_SESSION_NOT_FOUND', 'Session has been destroyed');
        }
        
        const requestId = sendMessage('text_session_prompt_streaming', {
          sessionId: session.sessionId,
          input,
          streaming: true,
        });
        
        return {
          [Symbol.asyncIterator](): AsyncIterator<StreamToken> {
            const queue: StreamToken[] = [];
            let resolveNext: ((value: IteratorResult<StreamToken>) => void) | null = null;
            let done = false;
            
            streamListeners.set(requestId, {
              onToken(token: StreamToken) {
                if (token.type === 'done' || token.type === 'error') {
                  done = true;
                }
                
                if (resolveNext) {
                  if (token.type === 'done') {
                    resolveNext({ done: true, value: undefined as unknown as StreamToken });
                  } else {
                    resolveNext({ done: false, value: token });
                  }
                  resolveNext = null;
                } else {
                  queue.push(token);
                }
              },
              onEvent() {}, // Not used for text sessions
            });
            
            return {
              async next(): Promise<IteratorResult<StreamToken>> {
                if (queue.length > 0) {
                  const token = queue.shift()!;
                  if (token.type === 'done') {
                    return { done: true, value: undefined as unknown as StreamToken };
                  }
                  return { done: false, value: token };
                }
                
                if (done) {
                  return { done: true, value: undefined as unknown as StreamToken };
                }
                
                return new Promise((resolve) => {
                  resolveNext = resolve;
                });
              },
            };
          },
        };
      },
      
      async destroy(): Promise<void> {
        if (session.destroyed) return;
        
        session.destroyed = true;
        await sendRequest('text_session_destroy', { sessionId: session.sessionId });
      },
    };
  },
};

// =============================================================================
// window.agent API Implementation
// =============================================================================

const agentApi = {
  /**
   * Request permission scopes from the user.
   * @param options.scopes - Permission scopes to request
   * @param options.reason - Optional reason to show the user
   * @param options.tools - Optional specific tools needed (for mcp:tools.call)
   */
  async requestPermissions(options: {
    scopes: PermissionScope[];
    reason?: string;
    tools?: string[];
  }): Promise<PermissionGrantResult> {
    return sendRequest<PermissionGrantResult>('request_permissions', options, 120000); // 2 min for user interaction
  },
  
  /**
   * Permission management namespace.
   */
  permissions: {
    /**
     * List current permission status for this origin.
     */
    async list(): Promise<PermissionStatus> {
      return sendRequest<PermissionStatus>('list_permissions');
    },
  },
  
  /**
   * MCP tools namespace.
   */
  tools: {
    /**
     * List available tools from connected MCP servers.
     * Requires "mcp:tools.list" permission scope.
     */
    async list(): Promise<ToolDescriptor[]> {
      const result = await sendRequest<{ tools: ToolDescriptor[] }>('tools_list');
      return result.tools;
    },
    
    /**
     * Call a specific tool.
     * Requires "mcp:tools.call" permission scope.
     */
    async call(options: { tool: string; args: Record<string, unknown> }): Promise<unknown> {
      const result = await sendRequest<{ success: boolean; result?: unknown; error?: ApiError }>(
        'tools_call',
        options,
        60000 // 1 minute timeout for tool calls
      );
      
      if (!result.success && result.error) {
        throw createApiError(result.error.code, result.error.message, result.error.details);
      }
      
      return result.result;
    },
  },
  
  /**
   * Browser API namespace.
   */
  browser: {
    activeTab: {
      /**
       * Extract readable content from the active tab.
       * Requires "browser:activeTab.read" permission scope.
       * May require user gesture.
       */
      async readability(): Promise<ActiveTabReadability> {
        return sendRequest<ActiveTabReadability>('active_tab_read', undefined, 30000);
      },
    },
  },
  
  /**
   * Run an autonomous agent task.
   * Requires "model:tools" permission plus any tool/browser permissions needed.
   */
  run(options: AgentRunOptions): AsyncIterable<RunEvent> {
    const requestId = sendMessage('agent_run', {
      task: options.task,
      tools: options.tools,
      requireCitations: options.requireCitations,
      maxToolCalls: options.maxToolCalls,
    });
    
    // Handle abort signal
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        sendMessage('agent_run_abort', { requestId });
      });
    }
    
    return {
      [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
        const queue: RunEvent[] = [];
        let resolveNext: ((value: IteratorResult<RunEvent>) => void) | null = null;
        let done = false;
        
        streamListeners.set(requestId, {
          onToken() {}, // Not used for agent run
          onEvent(event: RunEvent) {
            if (event.type === 'final' || event.type === 'error') {
              done = true;
            }
            
            if (resolveNext) {
              resolveNext({ done: false, value: event });
              resolveNext = null;
              
              // If this was the final event, next call will return done
            } else {
              queue.push(event);
            }
          },
        });
        
        return {
          async next(): Promise<IteratorResult<RunEvent>> {
            if (queue.length > 0) {
              const event = queue.shift()!;
              return { done: false, value: event };
            }
            
            if (done && queue.length === 0) {
              return { done: true, value: undefined as unknown as RunEvent };
            }
            
            return new Promise((resolve) => {
              resolveNext = resolve;
            });
          },
        };
      },
    };
  },
};

// =============================================================================
// Export to Window
// =============================================================================

// Create frozen, non-configurable APIs
const frozenAi = Object.freeze(aiApi);
const frozenAgent = Object.freeze({
  ...agentApi,
  permissions: Object.freeze(agentApi.permissions),
  tools: Object.freeze(agentApi.tools),
  browser: Object.freeze({
    activeTab: Object.freeze(agentApi.browser.activeTab),
  }),
});

// Define on window
Object.defineProperty(window, 'ai', {
  value: frozenAi,
  writable: false,
  configurable: false,
  enumerable: true,
});

Object.defineProperty(window, 'agent', {
  value: frozenAgent,
  writable: false,
  configurable: false,
  enumerable: true,
});

// Signal that the provider is ready
window.dispatchEvent(new CustomEvent('harbor-provider-ready'));

console.log('[Harbor] JS AI Provider v1 loaded');

