/**
 * Bridge API - Direct function calls to the native bridge.
 * 
 * This module is separate from background.ts to avoid circular imports
 * with background-router.ts. It uses the shared native connection from
 * native-connection.ts.
 */

import { 
  sendToBridge, 
  generateRequestId, 
  CHAT_TIMEOUT_MS 
} from './native-connection';

// =============================================================================
// Exported API Functions
// =============================================================================

export interface McpConnection {
  serverId: string;
  serverName: string;
  toolCount: number;
  connectionInfo?: unknown;
  connectedAt?: number;
}

export interface McpConnectionsResponse {
  type: string;
  connections?: McpConnection[];
  error?: { message: string };
}

export async function getMcpConnections(): Promise<McpConnectionsResponse> {
  try {
    const response = await sendToBridge({
      type: 'mcp_list_connections',
      request_id: generateRequestId(),
    });
    return response as McpConnectionsResponse;
  } catch (err) {
    console.error('[BridgeAPI] getMcpConnections error:', err);
    return { type: 'error', error: { message: err instanceof Error ? err.message : 'Failed to list connections' } };
  }
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ListToolsResponse {
  type: string;
  tools?: McpTool[];
  error?: { message: string };
}

export async function listMcpTools(serverId: string): Promise<ListToolsResponse> {
  try {
    const response = await sendToBridge({
      type: 'mcp_list_tools',
      request_id: generateRequestId(),
      server_id: serverId,
    });
    return response as ListToolsResponse;
  } catch (err) {
    console.error('[BridgeAPI] listMcpTools error:', err);
    return { type: 'error', error: { message: err instanceof Error ? err.message : 'Failed to list tools' } };
  }
}

export interface ChatSession {
  id: string;
  name?: string;
  enabledServers: string[];
  systemPrompt?: string;
  createdAt: number;
  config?: { maxIterations?: number };
}

export interface PluginToolDefinition {
  pluginId: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface PendingPluginToolCall {
  id: string;
  pluginId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface PluginToolResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}

export interface CreateChatSessionResponse {
  type: string;
  session?: ChatSession;
  error?: { message: string };
}

export async function createChatSession(options: {
  enabledServers: string[];
  pluginTools?: PluginToolDefinition[];
  name?: string;
  systemPrompt?: string;
  maxIterations?: number;
}): Promise<CreateChatSessionResponse> {
  try {
    const response = await sendToBridge({
      type: 'chat_create_session',
      request_id: generateRequestId(),
      enabled_servers: options.enabledServers,
      plugin_tools: options.pluginTools,
      name: options.name,
      system_prompt: options.systemPrompt,
      max_iterations: options.maxIterations,
    });
    return response as CreateChatSessionResponse;
  } catch (err) {
    console.error('[BridgeAPI] createChatSession error:', err);
    return { type: 'error', error: { message: err instanceof Error ? err.message : 'Failed to create session' } };
  }
}

export interface ChatSendMessageResponse {
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
  paused?: boolean;
  pendingPluginToolCalls?: PendingPluginToolCall[];
  error?: { message: string };
}

export async function sendChatMessage(options: {
  sessionId: string;
  message: string;
  useToolRouter?: boolean;
}): Promise<ChatSendMessageResponse> {
  try {
    const response = await sendToBridge({
      type: 'chat_send_message',
      request_id: generateRequestId(),
      session_id: options.sessionId,
      message: options.message,
      use_tool_router: options.useToolRouter,
    }, CHAT_TIMEOUT_MS);
    return response as ChatSendMessageResponse;
  } catch (err) {
    console.error('[BridgeAPI] sendChatMessage error:', err);
    return { type: 'error', error: { message: err instanceof Error ? err.message : 'Failed to send message' } };
  }
}

export async function continueChatWithPluginResults(options: {
  sessionId: string;
  pluginResults: PluginToolResult[];
}): Promise<ChatSendMessageResponse> {
  try {
    const response = await sendToBridge({
      type: 'chat_continue_with_plugin_results',
      request_id: generateRequestId(),
      session_id: options.sessionId,
      plugin_results: options.pluginResults,
    }, CHAT_TIMEOUT_MS);
    return response as ChatSendMessageResponse;
  } catch (err) {
    console.error('[BridgeAPI] continueChatWithPluginResults error:', err);
    return { type: 'error', error: { message: err instanceof Error ? err.message : 'Failed to continue chat' } };
  }
}

export async function deleteChatSession(sessionId: string): Promise<void> {
  try {
    await sendToBridge({
      type: 'chat_delete_session',
      request_id: generateRequestId(),
      session_id: sessionId,
    });
  } catch (err) {
    // Ignore cleanup errors
    console.log('[BridgeAPI] deleteChatSession error (ignored):', err);
  }
}

