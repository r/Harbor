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

export interface CreateChatSessionResponse {
  type: string;
  session?: ChatSession;
  error?: { message: string };
}

export async function createChatSession(options: {
  enabledServers: string[];
  name?: string;
  systemPrompt?: string;
  maxIterations?: number;
}): Promise<CreateChatSessionResponse> {
  try {
    const response = await sendToBridge({
      type: 'chat_create_session',
      request_id: generateRequestId(),
      enabled_servers: options.enabledServers,
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

// =============================================================================
// LLM Provider API
// =============================================================================

export interface LLMProviderInfo {
  id: string;
  name: string;
  available: boolean;
  baseUrl?: string;
  models?: string[];
  isDefault: boolean;
  supportsTools?: boolean;
}

export interface ListLLMProvidersResponse {
  type: string;
  providers?: LLMProviderInfo[];
  error?: { message: string };
}

export async function listLLMProviders(): Promise<ListLLMProvidersResponse> {
  try {
    const response = await sendToBridge({
      type: 'llm_list_providers',
      request_id: generateRequestId(),
    });
    return response as ListLLMProvidersResponse;
  } catch (err) {
    console.error('[BridgeAPI] listLLMProviders error:', err);
    return { type: 'error', error: { message: err instanceof Error ? err.message : 'Failed to list providers' } };
  }
}

export interface ActiveLLMConfig {
  provider: string | null;
  model: string | null;
}

export interface GetActiveLLMResponse {
  type: string;
  provider?: string | null;
  model?: string | null;
  error?: { message: string };
}

export async function getActiveLLM(): Promise<GetActiveLLMResponse> {
  try {
    const response = await sendToBridge({
      type: 'llm_get_active',
      request_id: generateRequestId(),
    });
    return response as GetActiveLLMResponse;
  } catch (err) {
    console.error('[BridgeAPI] getActiveLLM error:', err);
    return { type: 'error', error: { message: err instanceof Error ? err.message : 'Failed to get active LLM' } };
  }
}

