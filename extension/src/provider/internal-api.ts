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
// Session Interface
// =============================================================================

interface TextSessionHandle {
  sessionId: string;
  prompt(input: string): Promise<string>;
  promptStreaming(input: string): AsyncIterable<StreamToken>;
  destroy(): Promise<void>;
  /** Get the current message history */
  getHistory(): Array<{ role: string; content: string }>;
  /** Clear message history while keeping the session */
  clearHistory(): void;
}

// =============================================================================
// window.ai Implementation
// =============================================================================

export const ai = {
  /**
   * Create a new text generation session.
   * Sessions maintain conversation history and can be persisted.
   */
  async createTextSession(options?: TextSessionOptions): Promise<TextSessionHandle> {
    const sessionId = generateId();
    const session: SessionState = {
      id: sessionId,
      options: options || {},
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    if (options?.systemPrompt) {
      session.messages.push({ role: 'system', content: options.systemPrompt });
    }
    
    sessions.set(sessionId, session);
    await persistSession(session);
    
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
    
    // Return same interface as createTextSession
    return {
      sessionId: session.id,
      
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
      
      getHistory(): Array<{ role: string; content: string }> {
        const sess = sessions.get(sessionId);
        return sess ? [...sess.messages] : [];
      },
      
      clearHistory(): void {
        const sess = sessions.get(sessionId);
        if (sess) {
          const systemMsg = sess.messages.find(m => m.role === 'system');
          sess.messages = systemMsg ? [systemMsg] : [];
          sess.updatedAt = Date.now();
          persistSession(sess);
        }
      },
    };
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
      const connectionsResponse = await browser.runtime.sendMessage({
        type: 'mcp_list_connections',
      }) as { type: string; connections?: Array<{ serverId: string; serverName: string; toolCount: number }> };
      
      if (!connectionsResponse.connections) {
        return [];
      }
      
      const allTools: ToolDescriptor[] = [];
      
      for (const conn of connectionsResponse.connections) {
        const toolsResponse = await browser.runtime.sendMessage({
          type: 'mcp_list_tools',
          server_id: conn.serverId,
        }) as { type: string; tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
        
        if (toolsResponse.tools) {
          for (const tool of toolsResponse.tools) {
            allTools.push({
              name: `${conn.serverId}/${tool.name}`,
              description: tool.description,
              inputSchema: tool.inputSchema,
              serverId: conn.serverId,
            });
          }
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
        const connectionsResponse = await browser.runtime.sendMessage({
          type: 'mcp_list_connections',
        }) as { type: string; connections?: Array<{ serverId: string; serverName: string; toolCount: number }> };
        
        const enabledServers = connectionsResponse.connections?.map(c => c.serverId) || [];
        const totalTools = connectionsResponse.connections?.reduce((sum, c) => sum + c.toolCount, 0) || 0;
        
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
            use_tool_router: true,
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
                  yield { 
                    type: 'tool_result', 
                    tool: tr.toolName,
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

