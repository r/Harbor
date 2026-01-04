/**
 * Harbor JS AI Provider - Internal API
 * 
 * This module provides the same API surface as window.ai and window.agent
 * but for use within extension pages (which can't use content scripts).
 * 
 * This is the reference implementation that the extension chat uses.
 * It demonstrates best practices for using the Harbor APIs.
 * 
 * Usage:
 *   import { ai, agent } from './provider/internal-api';
 *   const session = await ai.createTextSession();
 */

import browser from 'webextension-polyfill';
import type {
  PermissionScope,
  PermissionGrantResult,
  PermissionStatus,
  ToolDescriptor,
  ActiveTabReadability,
  TextSessionOptions,
  StreamToken,
  RunEvent,
  ApiError,
} from './types';

// =============================================================================
// Tool Router - Built-in intelligent tool selection
// =============================================================================
// Session Storage
// =============================================================================

interface SessionState {
  id: string;
  options: TextSessionOptions;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  createdAt: number;
  updatedAt: number;
}

const sessions = new Map<string, SessionState>();
let sessionCounter = 0;

// Persist sessions to browser.storage for recovery across page reloads
async function persistSession(session: SessionState): Promise<void> {
  const key = `session_${session.id}`;
  await browser.storage.local.set({ [key]: session });
}

async function loadSession(sessionId: string): Promise<SessionState | null> {
  const key = `session_${sessionId}`;
  const result = await browser.storage.local.get(key);
  return result[key] as SessionState | null;
}

async function deleteStoredSession(sessionId: string): Promise<void> {
  const key = `session_${sessionId}`;
  await browser.storage.local.remove(key);
}

// =============================================================================
// Helpers
// =============================================================================

function generateId(): string {
  return `internal-${Date.now()}-${++sessionCounter}`;
}

function createError(code: ApiError['code'], message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

// =============================================================================
// Chrome AI API Compatibility Types
// =============================================================================

type AICapabilityAvailability = 'readily' | 'after-download' | 'no';

interface AILanguageModelCapabilities {
  available: AICapabilityAvailability;
  defaultTopK?: number;
  maxTopK?: number;
  defaultTemperature?: number;
}

interface AILanguageModelCreateOptions {
  systemPrompt?: string;
  initialPrompts?: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
  topK?: number;
  signal?: AbortSignal;
}

// =============================================================================
// Session Interface
// =============================================================================

interface TextSessionHandle {
  sessionId: string;
  prompt(input: string): Promise<string>;
  promptStreaming(input: string): AsyncIterable<StreamToken>;
  destroy(): Promise<void>;
  clone(): Promise<TextSessionHandle>;
  /** Get the current message history */
  getHistory(): Array<{ role: string; content: string }>;
  /** Clear message history while keeping the session */
  clearHistory(): void;
}

// =============================================================================
// window.ai Implementation
// =============================================================================

/**
 * Create a session handle with all methods.
 */
function createSessionHandle(sessionId: string, options: TextSessionOptions): TextSessionHandle {
  return {
    sessionId,
    
    async prompt(input: string): Promise<string> {
      const sess = sessions.get(sessionId);
      if (!sess) throw createError('ERR_SESSION_NOT_FOUND', 'Session not found');
      
      sess.messages.push({ role: 'user', content: input });
      sess.updatedAt = Date.now();
      
      const response = await browser.runtime.sendMessage({
        type: 'llm_chat',
        messages: sess.messages.map(m => ({ role: m.role, content: m.content })),
        temperature: sess.options.temperature,
      }) as { type: string; response?: { message?: { content?: string } }; error?: { message: string } };
      
      if (response.type === 'error' || !response.response?.message?.content) {
        throw createError('ERR_MODEL_FAILED', response.error?.message || 'LLM request failed');
      }
      
      const content = response.response.message.content;
      sess.messages.push({ role: 'assistant', content });
      sess.updatedAt = Date.now();
      await persistSession(sess);
      
      return content;
    },
    
    promptStreaming(input: string): AsyncIterable<StreamToken> {
      const sess = sessions.get(sessionId);
      if (!sess) throw createError('ERR_SESSION_NOT_FOUND', 'Session not found');
      
      return {
        async *[Symbol.asyncIterator]() {
          sess.messages.push({ role: 'user', content: input });
          sess.updatedAt = Date.now();
          
          const response = await browser.runtime.sendMessage({
            type: 'llm_chat',
            messages: sess.messages.map(m => ({ role: m.role, content: m.content })),
            temperature: sess.options.temperature,
          }) as { type: string; response?: { message?: { content?: string } }; error?: { message: string } };
          
          if (response.type === 'error' || !response.response?.message?.content) {
            yield { type: 'error', error: { code: 'ERR_MODEL_FAILED', message: response.error?.message || 'LLM request failed' } };
            return;
          }
          
          const content = response.response.message.content;
          sess.messages.push({ role: 'assistant', content });
          sess.updatedAt = Date.now();
          await persistSession(sess);
          
          // Simulate streaming by yielding word by word
          const words = content.split(/(\s+)/);
          for (const word of words) {
            if (word) {
              yield { type: 'token', token: word };
              await new Promise(r => setTimeout(r, 15));
            }
          }
          yield { type: 'done' };
        }
      };
    },
    
    async destroy(): Promise<void> {
      sessions.delete(sessionId);
      await deleteStoredSession(sessionId);
    },
    
    async clone(): Promise<TextSessionHandle> {
      const sess = sessions.get(sessionId);
      if (!sess) throw createError('ERR_SESSION_NOT_FOUND', 'Session not found');
      
      // Create a new session with the same options
      const newSessionId = generateId();
      const newSession: SessionState = {
        id: newSessionId,
        options: { ...sess.options },
        messages: [...sess.messages],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      
      sessions.set(newSessionId, newSession);
      await persistSession(newSession);
      
      return createSessionHandle(newSessionId, newSession.options);
    },
    
    getHistory(): Array<{ role: string; content: string }> {
      const sess = sessions.get(sessionId);
      return sess ? [...sess.messages] : [];
    },
    
    clearHistory(): void {
      const sess = sessions.get(sessionId);
      if (sess) {
        // Keep only system prompt if present
        const systemMsg = sess.messages.find(m => m.role === 'system');
        sess.messages = systemMsg ? [systemMsg] : [];
        sess.updatedAt = Date.now();
        persistSession(sess);
      }
    },
  };
}

export const ai = {
  /**
   * Chrome Compatibility: Check if a text session can be created.
   * In internal API context, always returns 'readily'.
   */
  async canCreateTextSession(): Promise<AICapabilityAvailability> {
    return 'readily';
  },
  
  /**
   * Create a new text generation session.
   * Sessions maintain conversation history and can be persisted.
   */
  async createTextSession(options?: TextSessionOptions): Promise<TextSessionHandle> {
    const sessionId = generateId();
    const sessionOptions = options || {};
    const session: SessionState = {
      id: sessionId,
      options: sessionOptions,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    if (options?.systemPrompt) {
      session.messages.push({ role: 'system', content: options.systemPrompt });
    }
    
    sessions.set(sessionId, session);
    await persistSession(session);
    
    return createSessionHandle(sessionId, sessionOptions);
  },
  
  /**
   * Chrome Prompt API compatible namespace: ai.languageModel
   * Provides the newer Chrome AI API surface.
   */
  languageModel: {
    /**
     * Check capabilities of the language model.
     */
    async capabilities(): Promise<AILanguageModelCapabilities> {
      return {
        available: 'readily',
        defaultTemperature: 1.0,
        defaultTopK: 40,
        maxTopK: 100,
      };
    },
    
    /**
     * Create a new language model session.
     * Chrome Compatibility: Maps to createTextSession.
     */
    async create(options?: AILanguageModelCreateOptions): Promise<TextSessionHandle> {
      const harborOptions: TextSessionOptions = {
        systemPrompt: options?.systemPrompt,
        temperature: options?.temperature,
      };
      
      const sessionId = generateId();
      const session: SessionState = {
        id: sessionId,
        options: harborOptions,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      
      if (options?.systemPrompt) {
        session.messages.push({ role: 'system', content: options.systemPrompt });
      }
      
      sessions.set(sessionId, session);
      await persistSession(session);
      
      const handle = createSessionHandle(sessionId, harborOptions);
      
      // If initial prompts provided, replay them
      if (options?.initialPrompts && options.initialPrompts.length > 0) {
        for (const msg of options.initialPrompts) {
          if (msg.role === 'user') {
            await handle.prompt(msg.content);
          }
        }
      }
      
      return handle;
    },
  },
  
  /**
   * Restore a previously created session by ID.
   * Returns null if session not found.
   */
  async restoreSession(sessionId: string): Promise<TextSessionHandle | null> {
    // Check memory first
    let session = sessions.get(sessionId);
    
    // Try loading from storage
    if (!session) {
      session = await loadSession(sessionId) || undefined;
      if (session) {
        sessions.set(sessionId, session);
      }
    }
    
    if (!session) {
      return null;
    }
    
    return createSessionHandle(session.id, session.options);
  },
};

// =============================================================================
// window.agent Implementation
// =============================================================================

export const agent = {
  // Extension pages always have permissions, so this is a no-op
  async requestPermissions(_options: {
    scopes: PermissionScope[];
    reason?: string;
  }): Promise<PermissionGrantResult> {
    // In extension context, all permissions are granted
    const scopes: Record<PermissionScope, 'granted-always'> = {
      'model:prompt': 'granted-always',
      'model:tools': 'granted-always',
      'mcp:tools.list': 'granted-always',
      'mcp:tools.call': 'granted-always',
      'browser:activeTab.read': 'granted-always',
      'web:fetch': 'granted-always',
    };
    return { granted: true, scopes };
  },
  
  permissions: {
    async list(): Promise<PermissionStatus> {
      return {
        origin: 'extension',
        scopes: {
          'model:prompt': 'granted-always',
          'model:tools': 'granted-always',
          'mcp:tools.list': 'granted-always',
          'mcp:tools.call': 'granted-always',
          'browser:activeTab.read': 'granted-always',
          'web:fetch': 'granted-always',
        },
      };
    },
  },
  
  tools: {
    async list(): Promise<ToolDescriptor[]> {
      let connectionsResponse: { type: string; connections?: Array<{ serverId: string; serverName: string; toolCount: number }>; error?: { message: string } } | undefined;
      
      try {
        connectionsResponse = await browser.runtime.sendMessage({
          type: 'mcp_list_connections',
        }) as typeof connectionsResponse;
      } catch (err) {
        console.log('[tools.list] Failed to get connections:', err);
        return [];
      }
      
      // Handle undefined or error response
      if (!connectionsResponse || connectionsResponse.type === 'error' || !connectionsResponse.connections) {
        return [];
      }
      
      const allTools: ToolDescriptor[] = [];
      
      for (const conn of connectionsResponse.connections) {
        try {
          const toolsResponse = await browser.runtime.sendMessage({
            type: 'mcp_list_tools',
            server_id: conn.serverId,
          }) as { type: string; tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
          
          if (toolsResponse?.tools) {
            for (const tool of toolsResponse.tools) {
              allTools.push({
                name: `${conn.serverId}/${tool.name}`,
                description: tool.description,
                inputSchema: tool.inputSchema,
                serverId: conn.serverId,
              });
            }
          }
        } catch (err) {
          console.log(`[tools.list] Failed to get tools for ${conn.serverId}:`, err);
        }
      }
      
      return allTools;
    },
    
    async call(options: { tool: string; args: Record<string, unknown> }): Promise<unknown> {
      const { tool, args } = options;
      
      const slashIndex = tool.indexOf('/');
      if (slashIndex === -1) {
        throw createError('ERR_TOOL_NOT_ALLOWED', 'Tool name must be in format "serverId/toolName"');
      }
      
      const serverId = tool.slice(0, slashIndex);
      const toolName = tool.slice(slashIndex + 1);
      
      const response = await browser.runtime.sendMessage({
        type: 'mcp_call_tool',
        server_id: serverId,
        tool_name: toolName,
        arguments: args,
      }) as { type: string; result?: unknown; error?: { message: string } };
      
      if (response.type === 'error') {
        throw createError('ERR_TOOL_FAILED', response.error?.message || 'Tool call failed');
      }
      
      return response.result;
    },
  },
  
  browser: {
    activeTab: {
      async readability(): Promise<ActiveTabReadability> {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const activeTab = tabs[0];
        
        if (!activeTab?.id || !activeTab.url) {
          throw createError('ERR_INTERNAL', 'No active tab found');
        }
        
        const url = new URL(activeTab.url);
        if (!['http:', 'https:'].includes(url.protocol)) {
          throw createError('ERR_PERMISSION_DENIED', 'Cannot read from this type of page');
        }
        
        const results = await browser.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: () => {
            const clone = document.cloneNode(true) as Document;
            const removeSelectors = [
              'script', 'style', 'noscript', 'iframe', 'nav', 'footer', 'header', 'aside',
              '.nav', '.navigation', '.menu', '.sidebar', '.footer', '.header', '.ad', '.ads',
            ];
            for (const sel of removeSelectors) {
              clone.querySelectorAll(sel).forEach(el => el.remove());
            }
            const main = clone.querySelector('main, article, [role="main"], .content') || clone.body;
            let text = main?.textContent || '';
            text = text.replace(/\s+/g, ' ').trim();
            if (text.length > 50000) text = text.slice(0, 50000) + '\n\n[Truncated...]';
            return { url: window.location.href, title: document.title, text };
          },
        });
        
        if (!results?.[0]?.result) {
          throw createError('ERR_INTERNAL', 'Failed to extract content');
        }
        
        return results[0].result as ActiveTabReadability;
      },
    },
  },
  
  /**
   * Run an autonomous agent task with access to tools.
   * 
   * Uses the bridge orchestrator for proper text-based tool call parsing
   * and consistent behavior with the injected provider.
   * 
   * @param options.task - The task description
   * @param options.tools - Optional array of allowed tool names (overrides router)
   * @param options.useAllTools - If true, disable tool router and use all tools
   * @param options.requireCitations - Include source citations in output
   * @param options.maxToolCalls - Maximum tool invocations (default: 5)
   */
  run(options: {
    task: string;
    tools?: string[];
    useAllTools?: boolean;
    requireCitations?: boolean;
    maxToolCalls?: number;
  }): AsyncIterable<RunEvent> {
    const { task, requireCitations = false, maxToolCalls = 5 } = options;
    
    return {
      async *[Symbol.asyncIterator]() {
        console.log('🔧 internal-api agent.run - using bridge orchestrator');
        yield { type: 'status', message: 'Initializing agent...' };
        
        // Get connected MCP servers
        let connectionsResponse: { type: string; connections?: Array<{ serverId: string; serverName: string; toolCount: number }>; error?: { message: string } } | undefined;
        try {
          connectionsResponse = await browser.runtime.sendMessage({
            type: 'mcp_list_connections',
          }) as typeof connectionsResponse;
          console.log('[AgentRun] Connections response:', connectionsResponse);
        } catch (err) {
          console.log('[AgentRun] Failed to get connections:', err);
          yield { type: 'error', error: { code: 'ERR_INTERNAL', message: 'Failed to connect to bridge. Is the Harbor bridge running?' } };
          return;
        }
        
        // Handle error response or undefined
        if (!connectionsResponse) {
          console.log('[AgentRun] Connections response is undefined - bridge may not be connected');
          yield { type: 'error', error: { code: 'ERR_INTERNAL', message: 'No response from bridge. Please check that the Harbor bridge is running.' } };
          return;
        }
        
        if (connectionsResponse.type === 'error') {
          console.log('[AgentRun] Connections response error:', connectionsResponse);
          const errorMsg = connectionsResponse.error?.message || 'Unknown error listing MCP connections';
          yield { type: 'error', error: { code: 'ERR_INTERNAL', message: `Bridge error: ${errorMsg}` } };
          return;
        }
        
        // Check if we have any connected servers
        const connections = connectionsResponse.connections || [];
        if (connections.length === 0) {
          console.log('[AgentRun] No MCP servers connected');
          yield { type: 'error', error: { code: 'ERR_INTERNAL', message: 'No MCP servers connected. Please start and connect at least one server in the Harbor sidebar.' } };
          return;
        }
        
        const enabledServers = connections.map(c => c.serverId);
        const totalTools = connections.reduce((sum, c) => sum + c.toolCount, 0);
        
        yield { type: 'status', message: `Found ${totalTools} tools from ${enabledServers.length} servers` };
        
        // Build custom system prompt if needed
        let systemPrompt: string | undefined;
        if (requireCitations) {
          systemPrompt = 'You are a helpful AI assistant. When using information from tools, cite your sources.';
        }
        
        // Create a temporary chat session with the connected servers
        const createResponse = await browser.runtime.sendMessage({
          type: 'chat_create_session',
          enabled_servers: enabledServers,
          name: `Agent task: ${task.substring(0, 30)}...`,
          system_prompt: systemPrompt,
          max_iterations: maxToolCalls,
        }) as { type: string; session?: { id: string }; error?: { message: string } };
        
        if (createResponse.type === 'error' || !createResponse.session?.id) {
          yield { type: 'error', error: { code: 'ERR_INTERNAL', message: createResponse.error?.message || 'Failed to create session' } };
          return;
        }
        
        const sessionId = createResponse.session.id;
        console.log('[AgentRun] Created session:', sessionId);
        
        yield { type: 'status', message: 'Processing...' };
        
        try {
          // Send the message - the bridge orchestrator handles everything
          const chatResponse = await browser.runtime.sendMessage({
            type: 'chat_send_message',
            session_id: sessionId,
            message: task,
            // use_tool_router defaults to false - LLM sees all tools and decides
          }) as { 
            type: string;
            response?: string;
            steps?: Array<{
              type: 'llm_response' | 'tool_calls' | 'tool_results' | 'error' | 'final';
              content?: string;
              toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
              toolResults?: Array<{ toolCallId: string; toolName: string; serverId: string; content: string; isError: boolean }>;
              error?: string;
            }>;
            iterations?: number;
            reachedMaxIterations?: boolean;
            error?: { message: string };
          };
          
          if (chatResponse.type === 'error') {
            yield { type: 'error', error: { code: 'ERR_INTERNAL', message: chatResponse.error?.message || 'Chat failed' } };
            return;
          }
          
          // Stream the orchestration steps
          const citations: Array<{ source: 'tool'; ref: string; excerpt: string }> = [];
          
          if (chatResponse.steps) {
            for (const step of chatResponse.steps) {
              if (step.type === 'tool_calls' && step.toolCalls) {
                for (const tc of step.toolCalls) {
                  yield { type: 'tool_call', tool: tc.name, args: tc.arguments };
                }
              }
              
              if (step.type === 'tool_results' && step.toolResults) {
                for (const tr of step.toolResults) {
                  // Use full prefixed name to match tool_call event
                  const fullToolName = tr.serverId ? `${tr.serverId}__${tr.toolName}` : tr.toolName;
                  yield { 
                    type: 'tool_result', 
                    tool: fullToolName,
                    result: tr.content,
                    error: tr.isError ? { code: 'ERR_TOOL_FAILED' as const, message: tr.content } : undefined,
                  };
                  
                  if (requireCitations && !tr.isError) {
                    citations.push({
                      source: 'tool',
                      ref: `${tr.serverId}/${tr.toolName}`,
                      excerpt: tr.content.slice(0, 200),
                    });
                  }
                }
              }
              
              if (step.type === 'error' && step.error) {
                yield { type: 'error', error: { code: 'ERR_INTERNAL', message: step.error } };
                return;
              }
            }
          }
          
          // Get the final response
          const finalOutput = chatResponse.response || '';
          
          // Stream the output token by token
          const tokens = finalOutput.split(/(\s+)/);
          for (const token of tokens) {
            if (token) {
              yield { type: 'token', token };
              await new Promise(r => setTimeout(r, 10));
            }
          }
          
          yield { 
            type: 'final', 
            output: finalOutput,
            citations: requireCitations && citations.length > 0 ? citations : undefined,
          };
          
          if (chatResponse.reachedMaxIterations) {
            console.log('[AgentRun] Warning: reached max iterations');
          }
          
        } finally {
          // Clean up the temporary session
          browser.runtime.sendMessage({
            type: 'chat_delete_session',
            session_id: sessionId,
          }).catch(() => {
            // Ignore cleanup errors
          });
        }
      },
    };
  },
};

