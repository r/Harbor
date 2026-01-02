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

/**
 * Routing rules for common MCP servers.
 * Maps keywords to server ID patterns.
 */
const ROUTING_RULES: Array<{
  keywords: string[];
  serverPatterns: string[];
  priority: number;
}> = [
  // GitHub
  {
    keywords: ['github', 'repo', 'repository', 'repositories', 'commit', 'commits', 'pull request', 'pr', 'issue', 'issues', 'branch', 'branches', 'fork', 'star', 'gist'],
    serverPatterns: ['github'],
    priority: 10,
  },
  // Filesystem
  {
    keywords: ['file', 'files', 'folder', 'folders', 'directory', 'directories', 'read', 'write', 'create', 'delete', 'move', 'copy', 'path', 'disk', 'storage', 'document', 'documents'],
    serverPatterns: ['filesystem', 'fs'],
    priority: 10,
  },
  // Memory/Knowledge
  {
    keywords: ['remember', 'memory', 'memories', 'recall', 'forget', 'knowledge', 'store', 'stored', 'save', 'saved', 'entity', 'entities', 'relation', 'relations', 'graph'],
    serverPatterns: ['memory', 'knowledge'],
    priority: 10,
  },
  // Slack
  {
    keywords: ['slack', 'channel', 'channels', 'message', 'messages', 'dm', 'workspace'],
    serverPatterns: ['slack'],
    priority: 10,
  },
  // Database
  {
    keywords: ['database', 'db', 'sql', 'query', 'table', 'tables', 'postgres', 'postgresql', 'mysql', 'sqlite', 'mongo', 'mongodb'],
    serverPatterns: ['database', 'postgres', 'mysql', 'sqlite', 'mongo', 'db'],
    priority: 10,
  },
  // Web/Browser
  {
    keywords: ['web', 'website', 'url', 'browse', 'browser', 'scrape', 'fetch', 'http', 'html', 'page', 'search online'],
    serverPatterns: ['web', 'browser', 'puppeteer', 'playwright'],
    priority: 10,
  },
  // Search
  {
    keywords: ['search', 'find', 'lookup', 'google', 'brave', 'bing'],
    serverPatterns: ['search', 'brave', 'google'],
    priority: 5,
  },
];

/**
 * Analyze a message and determine which tools are relevant.
 * This reduces cognitive load on local LLMs by presenting only relevant tools.
 */
function routeTools(message: string, tools: ToolDescriptor[]): {
  filteredTools: ToolDescriptor[];
  matchedKeywords: string[];
  wasRouted: boolean;
} {
  const messageLower = message.toLowerCase();
  const matchedKeywords: string[] = [];
  const matchedPatterns = new Set<string>();
  
  // Check each rule for keyword matches
  for (const rule of ROUTING_RULES.sort((a, b) => b.priority - a.priority)) {
    for (const keyword of rule.keywords) {
      if (messageLower.includes(keyword.toLowerCase())) {
        matchedKeywords.push(keyword);
        rule.serverPatterns.forEach(p => matchedPatterns.add(p));
      }
    }
  }
  
  // If no keywords matched, return all tools
  if (matchedPatterns.size === 0) {
    return {
      filteredTools: tools,
      matchedKeywords: [],
      wasRouted: false,
    };
  }
  
  // Filter tools to those matching the patterns
  const filteredTools = tools.filter(tool => {
    const serverIdLower = (tool.serverId || tool.name.split('/')[0]).toLowerCase();
    for (const pattern of matchedPatterns) {
      if (serverIdLower.includes(pattern.toLowerCase())) {
        return true;
      }
    }
    return false;
  });
  
  // If no tools matched, return all tools
  if (filteredTools.length === 0) {
    return {
      filteredTools: tools,
      matchedKeywords,
      wasRouted: false,
    };
  }
  
  return {
    filteredTools,
    matchedKeywords,
    wasRouted: true,
  };
}

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
   * The tool router is automatically enabled to select relevant tools
   * based on the task content. This improves performance with local LLMs
   * by reducing the number of tools presented.
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
    const { task, tools: allowedTools, useAllTools = false, requireCitations = false, maxToolCalls = 5 } = options;
    
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'status', message: 'Initializing agent...' };
        
        // Get available tools
        let availableTools = await agent.tools.list();
        
        // Filter if specific tools requested (explicit override)
        if (allowedTools && allowedTools.length > 0) {
          availableTools = availableTools.filter(t => allowedTools.includes(t.name));
          yield { type: 'status', message: `Using ${availableTools.length} specified tools` };
        } else if (!useAllTools && availableTools.length > 5) {
          // Apply tool router for intelligent selection
          const routing = routeTools(task, availableTools);
          if (routing.wasRouted) {
            availableTools = routing.filteredTools;
            yield { type: 'status', message: `Router: selected ${availableTools.length} tools (${routing.matchedKeywords.slice(0, 3).join(', ')})` };
          } else {
            yield { type: 'status', message: `Found ${availableTools.length} tools` };
          }
        } else {
          yield { type: 'status', message: `Found ${availableTools.length} tools` };
        }
        
        // Build system prompt
        const systemPrompt = `You are a helpful AI assistant with access to tools.
Your task is to help the user by using the available tools when needed.
Always explain what you're doing and why.
${requireCitations ? 'Cite your sources when using information from tools.' : ''}

Available tools:
${availableTools.map(t => `- ${t.name}: ${t.description || 'No description'}`).join('\n')}
`;
        
        const messages: Array<{ role: string; content: string }> = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: task },
        ];
        
        let toolCallCount = 0;
        const citations: Array<{ source: 'tool'; ref: string; excerpt: string }> = [];
        
        while (toolCallCount < maxToolCalls) {
          // Build tools for LLM
          const llmTools = availableTools.map(t => ({
            type: 'function',
            function: {
              name: t.name.replace('/', '_'),
              description: t.description,
              parameters: t.inputSchema || { type: 'object', properties: {} },
            },
          }));
          
          const llmResponse = await browser.runtime.sendMessage({
            type: 'llm_chat',
            messages,
            tools: llmTools.length > 0 ? llmTools : undefined,
          }) as {
            type: string;
            response?: {
              message?: {
                content?: string;
                tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
              };
            };
            error?: { message: string };
          };
          
          if (llmResponse.type === 'error' || !llmResponse.response?.message) {
            yield { type: 'error', error: { code: 'ERR_MODEL_FAILED', message: llmResponse.error?.message || 'LLM failed' } };
            return;
          }
          
          const message = llmResponse.response.message;
          
          // Handle tool calls
          if (message.tool_calls && message.tool_calls.length > 0) {
            for (const toolCall of message.tool_calls) {
              if (toolCallCount >= maxToolCalls) break;
              toolCallCount++;
              
              const toolName = toolCall.function.name.replace('_', '/');
              let args: Record<string, unknown> = {};
              try { args = JSON.parse(toolCall.function.arguments); } catch { /* empty */ }
              
              yield { type: 'tool_call', tool: toolName, args };
              
              let result: unknown;
              let error: ApiError | undefined;
              
              try {
                result = await agent.tools.call({ tool: toolName, args });
                
                if (requireCitations) {
                  citations.push({
                    source: 'tool',
                    ref: toolName,
                    excerpt: String(result).slice(0, 200),
                  });
                }
              } catch (err) {
                error = { code: 'ERR_TOOL_FAILED' as const, message: String(err) };
                result = `Error: ${err}`;
              }
              
              yield { type: 'tool_result', tool: toolName, result, error };
              
              messages.push({ role: 'assistant', content: `Calling tool: ${toolName}` });
              messages.push({ role: 'user', content: `Tool result: ${typeof result === 'string' ? result : JSON.stringify(result)}` });
            }
            continue;
          }
          
          // Final response
          const output = message.content || '';
          
          // Stream tokens
          const words = output.split(/(\s+)/);
          for (const word of words) {
            if (word) {
              yield { type: 'token', token: word };
              await new Promise(r => setTimeout(r, 10));
            }
          }
          
          yield {
            type: 'final',
            output,
            citations: requireCitations && citations.length > 0 ? citations : undefined,
          };
          
          return;
        }
        
        yield { type: 'error', error: { code: 'ERR_INTERNAL', message: `Max tool calls (${maxToolCalls}) reached` } };
      },
    };
  },
};

