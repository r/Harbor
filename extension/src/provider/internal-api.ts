/**
 * Harbor JS AI Provider - Internal API
 * 
 * This module provides the same API surface as window.ai and window.agent
 * but for use within extension pages (which can't use content scripts).
 * 
 * This file uses the shared API core with special handling for:
 * - Permission bypass (extension pages always have permissions)
 * - Direct browser API access for activeTab.readability
 * 
 * Usage:
 *   import { ai, agent } from './provider/internal-api';
 *   const session = await ai.createTextSession();
 */

import browser from 'webextension-polyfill';
import { createInternalTransport } from './internal-transport';
import { createAiApi, createAgentApi, createApiError } from './api-core';
import type {
  PermissionScope,
  PermissionGrantResult,
  PermissionStatus,
  ActiveTabReadability,
  RunEvent,
} from './types';

// =============================================================================
// Create Transport and Base APIs
// =============================================================================

const transport = createInternalTransport();
const baseAiApi = createAiApi(transport);
const baseAgentApi = createAgentApi(transport);

// =============================================================================
// Extension-Specific Overrides
// =============================================================================

/**
 * Extension pages always have all permissions granted.
 * Override the permission methods to return granted status.
 */
const permissionOverrides = {
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
};

/**
 * Direct browser API access for activeTab.readability.
 * Extension pages can use browser.tabs and browser.scripting directly.
 */
const browserOverrides = {
  activeTab: {
    async readability(): Promise<ActiveTabReadability> {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];
      
      if (!activeTab?.id || !activeTab.url) {
        throw createApiError('ERR_INTERNAL', 'No active tab found');
      }
      
      const url = new URL(activeTab.url);
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw createApiError('ERR_PERMISSION_DENIED', 'Cannot read from this type of page');
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
        throw createApiError('ERR_INTERNAL', 'Failed to extract content');
      }
      
      return results[0].result as ActiveTabReadability;
    },
  },
};

/**
 * Override agent.run to use direct browser.runtime.sendMessage for better reliability
 * in extension context. This avoids the port-based streaming which can be flaky.
 */
function createAgentRunOverride(): (options: {
  task: string;
  tools?: string[];
  useAllTools?: boolean;
  requireCitations?: boolean;
  maxToolCalls?: number;
}) => AsyncIterable<RunEvent> {
  return function run(options) {
    const { task, requireCitations = false, maxToolCalls = 5 } = options;
    
    return {
      async *[Symbol.asyncIterator]() {
        console.log('[InternalAPI] agent.run - using direct message approach');
        yield { type: 'status', message: 'Initializing agent...' };
        
        // Get connected MCP servers
        let connectionsResponse: { type: string; connections?: Array<{ serverId: string; serverName: string; toolCount: number }>; error?: { message: string } } | undefined;
        try {
          connectionsResponse = await browser.runtime.sendMessage({
            type: 'mcp_list_connections',
          }) as typeof connectionsResponse;
        } catch (err) {
          console.log('[InternalAPI] Failed to get connections:', err);
          yield { type: 'error', error: { code: 'ERR_INTERNAL', message: 'Failed to connect to bridge. Is the Harbor bridge running?' } };
          return;
        }

        // Get plugin tools
        let pluginToolsResponse: { type: string; tools?: Array<{ pluginId: string; name: string; originalName: string; description?: string; inputSchema?: Record<string, unknown> }> } | undefined;
        try {
          pluginToolsResponse = await browser.runtime.sendMessage({
            type: 'list_plugin_tools',
          }) as typeof pluginToolsResponse;
        } catch (err) {
          console.log('[InternalAPI] Failed to get plugin tools:', err);
          // Not fatal - continue without plugins
        }

        const connections = connectionsResponse?.connections || [];
        const pluginTools = pluginToolsResponse?.tools || [];

        if (!connectionsResponse || connectionsResponse.type === 'error') {
          if (pluginTools.length === 0) {
            yield { type: 'error', error: { code: 'ERR_INTERNAL', message: 'No response from bridge. Please check that the Harbor bridge is running.' } };
            return;
          }
          // Bridge not connected but we have plugins - continue
        }

        if (connections.length === 0 && pluginTools.length === 0) {
          yield { type: 'error', error: { code: 'ERR_INTERNAL', message: 'No MCP servers or plugins available. Please start an MCP server or install a plugin.' } };
          return;
        }

        const enabledServers = connections.map(c => c.serverId);
        const mcpToolCount = connections.reduce((sum, c) => sum + c.toolCount, 0);
        const totalTools = mcpToolCount + pluginTools.length;

        if (connections.length > 0 && pluginTools.length > 0) {
          yield { type: 'status', message: `Found ${totalTools} tools (${mcpToolCount} MCP, ${pluginTools.length} plugin)` };
        } else if (connections.length > 0) {
          yield { type: 'status', message: `Found ${mcpToolCount} tools from ${enabledServers.length} servers` };
        } else {
          yield { type: 'status', message: `Found ${pluginTools.length} plugin tools` };
        }

        // Create chat session with plugin tools
        // Map plugin tools to use originalName (the actual tool name the plugin expects)
        const mappedPluginTools = pluginTools.map(pt => ({
          pluginId: pt.pluginId,
          name: pt.originalName,  // Use original name, not namespaced name
          description: pt.description,
          inputSchema: pt.inputSchema,
        }));

        const createResponse = await browser.runtime.sendMessage({
          type: 'chat_create_session',
          enabled_servers: enabledServers,
          plugin_tools: mappedPluginTools,
          name: `Agent task: ${task.substring(0, 30)}...`,
          max_iterations: maxToolCalls,
        }) as { type: string; session?: { id: string }; error?: { message: string } };
        
        if (createResponse.type === 'error' || !createResponse.session?.id) {
          yield { type: 'error', error: { code: 'ERR_INTERNAL', message: createResponse.error?.message || 'Failed to create session' } };
          return;
        }
        
        const sessionId = createResponse.session.id;
        yield { type: 'status', message: 'Processing...' };
        
        try {
          // Type for chat responses
          type ChatResponse = {
            type: string;
            response?: string;
            steps?: Array<{
              type: 'llm_response' | 'tool_calls' | 'tool_results' | 'error' | 'final';
              content?: string;
              toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
              toolResults?: Array<{ toolCallId: string; toolName: string; serverId: string; content: string; isError: boolean }>;
              error?: string;
            }>;
            paused?: boolean;
            pendingPluginToolCalls?: Array<{
              id: string;
              pluginId: string;
              toolName: string;
              arguments: Record<string, unknown>;
            }>;
            error?: { message: string };
          };

          // Helper to process steps
          const processSteps = function* (response: ChatResponse, citations: Array<{ source: 'tool'; ref: string; excerpt: string }>) {
            if (response.steps) {
              for (const step of response.steps) {
                if (step.type === 'tool_calls' && step.toolCalls) {
                  for (const tc of step.toolCalls) {
                    yield { type: 'tool_call' as const, tool: tc.name, args: tc.arguments };
                  }
                }

                if (step.type === 'tool_results' && step.toolResults) {
                  for (const tr of step.toolResults) {
                    const fullToolName = tr.serverId ? `${tr.serverId}__${tr.toolName}` : tr.toolName;
                    yield {
                      type: 'tool_result' as const,
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
                  yield { type: 'error' as const, error: { code: 'ERR_INTERNAL' as const, message: step.error } };
                  return;
                }
              }
            }
          };

          // Send message and get orchestration result
          let chatResponse = await browser.runtime.sendMessage({
            type: 'chat_send_message',
            session_id: sessionId,
            message: task,
          }) as ChatResponse;

          if (chatResponse.type === 'error') {
            yield { type: 'error', error: { code: 'ERR_INTERNAL', message: chatResponse.error?.message || 'Chat failed' } };
            return;
          }

          // Process steps and yield events
          const citations: Array<{ source: 'tool'; ref: string; excerpt: string }> = [];

          // Process initial steps
          for (const event of processSteps(chatResponse, citations)) {
            yield event;
            if (event.type === 'error') return;
          }

          // Handle plugin tool calls - loop until no more paused states
          while (chatResponse.paused && chatResponse.pendingPluginToolCalls && chatResponse.pendingPluginToolCalls.length > 0) {
            console.log('[InternalAPI] Processing plugin tool calls:', chatResponse.pendingPluginToolCalls.length);

            const pluginResults: Array<{ toolCallId: string; content: string; isError: boolean }> = [];

            for (const ptc of chatResponse.pendingPluginToolCalls) {
              yield { type: 'tool_call', tool: `plugin__${ptc.toolName}`, args: ptc.arguments };

              try {
                const result = await browser.runtime.sendMessage({
                  type: 'execute_plugin_tool',
                  plugin_id: ptc.pluginId,
                  tool_name: ptc.toolName,
                  arguments: ptc.arguments,
                }) as { type: string; result?: unknown; error?: { message: string } };

                if (result.type === 'error') {
                  throw new Error(result.error?.message || 'Plugin tool failed');
                }

                const resultStr = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);

                pluginResults.push({
                  toolCallId: ptc.id,
                  content: resultStr,
                  isError: false,
                });

                yield {
                  type: 'tool_result',
                  tool: `plugin__${ptc.toolName}`,
                  result: resultStr,
                };

                if (requireCitations) {
                  citations.push({
                    source: 'tool',
                    ref: `plugin/${ptc.toolName}`,
                    excerpt: resultStr.slice(0, 200),
                  });
                }
              } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                console.log('[InternalAPI] Plugin tool error:', ptc.toolName, errorMsg);

                pluginResults.push({
                  toolCallId: ptc.id,
                  content: `Error: ${errorMsg}`,
                  isError: true,
                });

                yield {
                  type: 'tool_result',
                  tool: `plugin__${ptc.toolName}`,
                  result: `Error: ${errorMsg}`,
                  error: { code: 'ERR_TOOL_FAILED' as const, message: errorMsg },
                };
              }
            }

            // Continue orchestration with plugin results
            chatResponse = await browser.runtime.sendMessage({
              type: 'chat_continue_with_plugin_results',
              session_id: sessionId,
              plugin_results: pluginResults,
            }) as ChatResponse;

            if (chatResponse.type === 'error') {
              yield { type: 'error', error: { code: 'ERR_INTERNAL', message: chatResponse.error?.message || 'Chat continuation failed' } };
              return;
            }

            // Process continuation steps
            for (const event of processSteps(chatResponse, citations)) {
              yield event;
              if (event.type === 'error') return;
            }
          }

          // Yield final response
          const finalOutput = chatResponse.response || '';

          // Stream tokens for nice effect
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

        } finally {
          // Clean up session
          browser.runtime.sendMessage({
            type: 'chat_delete_session',
            session_id: sessionId,
          }).catch(() => {});
        }
      },
    };
  };
}

// =============================================================================
// Exported APIs with Overrides
// =============================================================================

export const ai = baseAiApi;

export const agent = {
  ...baseAgentApi,
  ...permissionOverrides,
  browser: browserOverrides,
  run: createAgentRunOverride(),
};
