/**
 * Harbor Extension API
 * 
 * This module handles external messages from other extensions.
 * It provides a typed API for LLM, MCP, and system operations.
 * 
 * Other extensions call Harbor via:
 *   chrome.runtime.sendMessage(HARBOR_EXTENSION_ID, { type: '...', payload: {...} })
 */

import { browserAPI } from './browser-compat';
import { bridgeRequest, bridgeStreamRequest, getBridgeConnectionState, checkBridgeHealth } from './llm/bridge-client';
import { listServersWithStatus, callTool, startServer, stopServer, listTools } from './mcp/host';
import { isNativeBridgeReady } from './llm/native-bridge';
import { listAllProviders, getRuntimeCapabilities } from './llm/provider-registry';
import { SessionRegistry } from './sessions';
import type { CreateSessionOptions, SessionSummary } from './sessions';

// =============================================================================
// Types
// =============================================================================

export interface ExtensionApiRequest {
  type: string;
  payload?: unknown;
  requestId?: string; // For correlating streaming responses
}

export interface ExtensionApiResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface StreamChunk {
  type: 'stream';
  requestId: string;
  event: {
    type: 'token' | 'done' | 'error';
    token?: string;
    finish_reason?: string;
    model?: string;
    error?: { code: number; message: string };
  };
}

// Message types for the extension API
type MessageType =
  // LLM Operations
  | 'llm.chat'
  | 'llm.chatStream'
  | 'llm.listProviders'
  | 'llm.getActiveProvider'
  | 'llm.configureProvider'
  | 'llm.listModels'
  | 'llm.listConfiguredModels'
  // MCP Operations
  | 'mcp.listServers'
  | 'mcp.listTools'
  | 'mcp.callTool'
  | 'mcp.startServer'
  | 'mcp.stopServer'
  // Session Operations
  | 'session.create'
  | 'session.createImplicit'
  | 'session.get'
  | 'session.list'
  | 'session.terminate'
  | 'session.recordUsage'
  // System
  | 'system.health'
  | 'system.getCapabilities'
  | 'system.getVersion';

// =============================================================================
// Helpers
// =============================================================================

function log(...args: unknown[]): void {
  console.log('[Harbor ExtAPI]', ...args);
}

function error(...args: unknown[]): void {
  console.error('[Harbor ExtAPI]', ...args);
}

function success(result?: unknown): ExtensionApiResponse {
  return { ok: true, result };
}

function failure(err: unknown): ExtensionApiResponse {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: message };
}

// =============================================================================
// Handlers
// =============================================================================

async function handleLlmChat(payload: unknown): Promise<ExtensionApiResponse> {
  const { messages, model, max_tokens, temperature, system, tools } = payload as {
    messages?: Array<{ role: string; content: string }>;
    model?: string;
    max_tokens?: number;
    temperature?: number;
    system?: string;
    tools?: Array<{ name: string; description: string; input_schema: unknown }>;
  };

  if (!messages || messages.length === 0) {
    return failure('Missing messages');
  }

  try {
    // Build request with optional tools
    const request: Record<string, unknown> = { messages, model, max_tokens, temperature, system };
    if (tools && tools.length > 0) {
      request.tools = tools;
      log('LLM chat with tools:', tools.map(t => t.name));
    }

    const result = await bridgeRequest<{
      response?: { role: string; content: string };
      message?: { content: string };
      content?: string;
      model?: string;
      choices?: Array<{
        message: {
          role: string;
          content: string;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
        finish_reason?: string;
      }>;
    }>('llm.chat', request);

    log('LLM chat result:', JSON.stringify(result).substring(0, 500));

    // If response has choices (OpenAI format with tool_calls), return full structure
    if (result.choices && result.choices.length > 0) {
      return success({ 
        content: result.choices[0].message.content || '',
        model: result.model,
        choices: result.choices,
      });
    }

    // Normalize simple response format
    const content = result.response?.content || result.message?.content || result.content || '';
    return success({ content, model: result.model });
  } catch (e) {
    return failure(e);
  }
}

async function handleLlmListProviders(): Promise<ExtensionApiResponse> {
  try {
    const result = await bridgeRequest<{ providers: unknown[]; default_provider?: string }>('llm.list_providers');
    return success({ providers: result.providers, default_provider: result.default_provider });
  } catch (e) {
    return failure(e);
  }
}

async function handleLlmGetActiveProvider(): Promise<ExtensionApiResponse> {
  try {
    const result = await bridgeRequest<{ default_model?: string; providers: Record<string, unknown> }>('llm.get_config');
    return success({ default_model: result.default_model, providers: result.providers });
  } catch (e) {
    return failure(e);
  }
}

async function handleLlmConfigureProvider(payload: unknown): Promise<ExtensionApiResponse> {
  const { id, provider, name, api_key, base_url, enabled } = payload as {
    id?: string;
    provider?: string;
    name?: string;
    api_key?: string;
    base_url?: string;
    enabled?: boolean;
  };

  if (!provider && !id) {
    return failure('Missing provider or id');
  }

  try {
    const result = await bridgeRequest<{ ok: boolean; id: string }>('llm.configure_provider', {
      id, provider, name, api_key, base_url, enabled,
    });
    return success({ id: result.id });
  } catch (e) {
    return failure(e);
  }
}

async function handleLlmListModels(): Promise<ExtensionApiResponse> {
  try {
    const result = await bridgeRequest<{ models: unknown[] }>('llm.list_models');
    return success({ models: result.models });
  } catch (e) {
    return failure(e);
  }
}

async function handleLlmListConfiguredModels(): Promise<ExtensionApiResponse> {
  try {
    const result = await bridgeRequest<{ models: unknown[] }>('llm.list_configured_models');
    return success({ models: result.models });
  } catch (e) {
    return failure(e);
  }
}

async function handleMcpListServers(): Promise<ExtensionApiResponse> {
  try {
    const servers = await listServersWithStatus();
    return success({ servers });
  } catch (e) {
    return failure(e);
  }
}

async function handleMcpListTools(payload: unknown): Promise<ExtensionApiResponse> {
  const { serverId } = (payload || {}) as { serverId?: string };

  try {
    if (serverId) {
      // List tools from specific server
      const tools = await listTools(serverId);
      return success({ tools });
    } else {
      // List tools from all running servers
      const servers = await listServersWithStatus();
      const allTools: Array<{ serverId: string; name: string; description?: string; inputSchema?: unknown }> = [];
      
      for (const server of servers) {
        if (server.running && server.tools) {
          for (const tool of server.tools) {
            allTools.push({
              serverId: server.id,
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            });
          }
        }
      }
      
      return success({ tools: allTools });
    }
  } catch (e) {
    return failure(e);
  }
}

async function handleMcpCallTool(payload: unknown): Promise<ExtensionApiResponse> {
  const { serverId, toolName, args } = payload as {
    serverId?: string;
    toolName?: string;
    args?: Record<string, unknown>;
  };

  if (!serverId || !toolName) {
    return failure('Missing serverId or toolName');
  }

  try {
    const result = await callTool(serverId, toolName, args || {});
    if (!result.ok) {
      return failure(result.error || 'Tool call failed');
    }
    return success({ result: result.result });
  } catch (e) {
    return failure(e);
  }
}

async function handleMcpStartServer(payload: unknown): Promise<ExtensionApiResponse> {
  const { serverId } = payload as { serverId?: string };

  if (!serverId) {
    return failure('Missing serverId');
  }

  try {
    const started = await startServer(serverId);
    return success({ started });
  } catch (e) {
    return failure(e);
  }
}

async function handleMcpStopServer(payload: unknown): Promise<ExtensionApiResponse> {
  const { serverId } = payload as { serverId?: string };

  if (!serverId) {
    return failure('Missing serverId');
  }

  try {
    const stopped = stopServer(serverId);
    return success({ stopped });
  } catch (e) {
    return failure(e);
  }
}

async function handleSystemHealth(): Promise<ExtensionApiResponse> {
  try {
    const bridgeState = getBridgeConnectionState();
    const bridgeHealthy = await checkBridgeHealth();
    
    return success({
      healthy: bridgeHealthy,
      bridge: {
        connected: bridgeState.connected,
        ready: bridgeState.bridgeReady,
        error: bridgeState.error,
      },
    });
  } catch (e) {
    return failure(e);
  }
}

async function handleSystemGetCapabilities(): Promise<ExtensionApiResponse> {
  try {
    const capabilities = await getRuntimeCapabilities();
    const bridgeReady = isNativeBridgeReady();
    
    return success({
      bridgeReady,
      capabilities,
      features: {
        llm: bridgeReady,
        mcp: true,
        oauth: bridgeReady,
        streaming: bridgeReady,
      },
    });
  } catch (e) {
    return failure(e);
  }
}

function handleSystemGetVersion(): ExtensionApiResponse {
  return success({
    version: '0.1.0',
    extensionId: browserAPI.runtime.id,
  });
}

// =============================================================================
// Session Handlers
// =============================================================================

/**
 * Create an explicit session with specified capabilities.
 */
async function handleSessionCreate(payload: unknown): Promise<ExtensionApiResponse> {
  const { origin, tabId, options } = payload as {
    origin?: string;
    tabId?: number;
    options?: CreateSessionOptions;
  };

  if (!origin) {
    return failure('Missing origin');
  }

  if (!options) {
    return failure('Missing session options');
  }

  try {
    // TODO: Check origin permissions before creating session
    // For now, we'll create the session and let the caller handle permission checking
    
    // Get allowed tools for this origin (if tools requested)
    // TODO: Integrate with permission system to get actual allowed tools
    const allowedTools = options.capabilities?.tools || [];

    const result = SessionRegistry.createExplicitSession(origin, options, allowedTools, tabId);
    
    if (result.success) {
      return success({
        sessionId: result.sessionId,
        capabilities: result.capabilities,
      });
    } else {
      return failure(result.error?.message || 'Session creation failed');
    }
  } catch (e) {
    return failure(e);
  }
}

/**
 * Create an implicit session (from ai.createTextSession).
 */
async function handleSessionCreateImplicit(payload: unknown): Promise<ExtensionApiResponse> {
  const { origin, tabId, options } = payload as {
    origin?: string;
    tabId?: number;
    options?: { systemPrompt?: string; temperature?: number };
  };

  if (!origin) {
    return failure('Missing origin');
  }

  try {
    const session = SessionRegistry.createImplicitSession(origin, options || {}, tabId);
    return success({
      sessionId: session.sessionId,
      capabilities: session.capabilities,
    });
  } catch (e) {
    return failure(e);
  }
}

/**
 * Get a session by ID.
 */
async function handleSessionGet(payload: unknown): Promise<ExtensionApiResponse> {
  const { sessionId, origin } = payload as {
    sessionId?: string;
    origin?: string;
  };

  if (!sessionId) {
    return failure('Missing sessionId');
  }

  try {
    if (origin) {
      // Validate session belongs to origin
      const session = SessionRegistry.getValidatedSession(sessionId, origin);
      return success({ session: sessionToResponse(session) });
    } else {
      // Return session without origin validation (for internal use)
      const session = SessionRegistry.getSession(sessionId);
      if (!session) {
        return failure('Session not found');
      }
      return success({ session: sessionToResponse(session) });
    }
  } catch (e) {
    return failure(e);
  }
}

/**
 * List sessions with optional filters.
 */
async function handleSessionList(payload: unknown): Promise<ExtensionApiResponse> {
  const { origin, status, type, activeOnly } = (payload || {}) as {
    origin?: string;
    status?: 'active' | 'suspended' | 'terminated';
    type?: 'implicit' | 'explicit';
    activeOnly?: boolean;
  };

  try {
    const sessions = SessionRegistry.listSessions({ origin, status, type, activeOnly });
    return success({ sessions });
  } catch (e) {
    return failure(e);
  }
}

/**
 * Terminate a session.
 */
async function handleSessionTerminate(payload: unknown): Promise<ExtensionApiResponse> {
  const { sessionId, origin } = payload as {
    sessionId?: string;
    origin?: string;
  };

  if (!sessionId || !origin) {
    return failure('Missing sessionId or origin');
  }

  try {
    const terminated = SessionRegistry.terminateSession(sessionId, origin);
    return success({ terminated });
  } catch (e) {
    return failure(e);
  }
}

/**
 * Record usage for a session (prompt, tool call, etc.).
 */
async function handleSessionRecordUsage(payload: unknown): Promise<ExtensionApiResponse> {
  const { sessionId, type, detail } = payload as {
    sessionId?: string;
    type?: 'prompt' | 'tool' | 'browser';
    detail?: unknown;
  };

  if (!sessionId || !type) {
    return failure('Missing sessionId or type');
  }

  try {
    switch (type) {
      case 'prompt': {
        const { userMessage, assistantMessage } = detail as {
          userMessage?: string;
          assistantMessage?: string;
        };
        if (userMessage && assistantMessage) {
          SessionRegistry.recordPrompt(sessionId, userMessage, assistantMessage);
        }
        break;
      }
      case 'tool': {
        const { toolName } = detail as { toolName?: string };
        if (toolName) {
          const allowed = SessionRegistry.recordToolCall(sessionId, toolName);
          if (!allowed) {
            return failure('Tool call budget exceeded');
          }
        }
        break;
      }
      case 'browser': {
        const { action } = detail as { action?: 'read' | 'interact' | 'screenshot' };
        if (action) {
          SessionRegistry.recordBrowserAccess(sessionId, action);
        }
        break;
      }
    }
    
    // Touch the session to update lastActiveAt
    SessionRegistry.touchSession(sessionId);
    
    return success({ recorded: true });
  } catch (e) {
    return failure(e);
  }
}

/**
 * Convert internal session to external response format.
 */
function sessionToResponse(session: ReturnType<typeof SessionRegistry.getSession>): SessionSummary | null {
  if (!session) return null;
  
  return {
    sessionId: session.sessionId,
    type: session.type,
    origin: session.origin,
    status: session.status,
    name: session.name,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    capabilities: {
      hasLLM: session.capabilities.llm.allowed,
      toolCount: session.capabilities.tools.allowedTools.length,
      hasBrowserAccess:
        session.capabilities.browser.readActiveTab ||
        session.capabilities.browser.interact ||
        session.capabilities.browser.screenshot,
    },
    usage: session.usage,
  };
}

// =============================================================================
// Main Router
// =============================================================================

async function routeMessage(
  message: ExtensionApiRequest,
  sender: { id?: string; url?: string; tab?: { id?: number } },
): Promise<ExtensionApiResponse> {
  const { type, payload } = message;
  
  log(`Request from ${sender.id}: ${type}`);

  switch (type as MessageType) {
    // LLM Operations
    case 'llm.chat':
      return handleLlmChat(payload);
    case 'llm.listProviders':
      return handleLlmListProviders();
    case 'llm.getActiveProvider':
      return handleLlmGetActiveProvider();
    case 'llm.configureProvider':
      return handleLlmConfigureProvider(payload);
    case 'llm.listModels':
      return handleLlmListModels();
    case 'llm.listConfiguredModels':
      return handleLlmListConfiguredModels();

    // MCP Operations
    case 'mcp.listServers':
      return handleMcpListServers();
    case 'mcp.listTools':
      return handleMcpListTools(payload);
    case 'mcp.callTool':
      return handleMcpCallTool(payload);
    case 'mcp.startServer':
      return handleMcpStartServer(payload);
    case 'mcp.stopServer':
      return handleMcpStopServer(payload);

    // Session Operations
    case 'session.create':
      return handleSessionCreate(payload);
    case 'session.createImplicit':
      return handleSessionCreateImplicit(payload);
    case 'session.get':
      return handleSessionGet(payload);
    case 'session.list':
      return handleSessionList(payload);
    case 'session.terminate':
      return handleSessionTerminate(payload);
    case 'session.recordUsage':
      return handleSessionRecordUsage(payload);

    // System
    case 'system.health':
      return handleSystemHealth();
    case 'system.getCapabilities':
      return handleSystemGetCapabilities();
    case 'system.getVersion':
      return handleSystemGetVersion();

    default:
      return failure(`Unknown message type: ${type}`);
  }
}

// =============================================================================
// Streaming Handler (for llm.chatStream)
// =============================================================================

async function handleStreamingChat(
  message: ExtensionApiRequest,
  sender: { id?: string; url?: string; tab?: { id?: number } },
  port: ReturnType<typeof browserAPI.runtime.connect>,
): Promise<void> {
  const { payload, requestId } = message;
  const { messages, model, max_tokens, temperature, system } = (payload || {}) as {
    messages?: Array<{ role: string; content: string }>;
    model?: string;
    max_tokens?: number;
    temperature?: number;
    system?: string;
  };

  if (!messages || messages.length === 0) {
    port.postMessage({ type: 'stream', requestId, event: { type: 'error', error: { message: 'Missing messages' } } });
    return;
  }

  if (!requestId) {
    port.postMessage({ type: 'stream', requestId: '', event: { type: 'error', error: { message: 'Missing requestId for streaming' } } });
    return;
  }

  try {
    for await (const event of bridgeStreamRequest('llm.chat', { messages, model, max_tokens, temperature, system, stream: true })) {
      port.postMessage({ type: 'stream', requestId, event } as StreamChunk);
      if (event.type === 'done' || event.type === 'error') {
        break;
      }
    }
  } catch (e) {
    port.postMessage({
      type: 'stream',
      requestId,
      event: { type: 'error', error: { message: e instanceof Error ? e.message : String(e) } },
    } as StreamChunk);
  }
}

// =============================================================================
// Initialization
// =============================================================================

export function initializeExtensionApi(): void {
  log('Initializing extension API...');

  // Subscribe to session events and broadcast to sidebar
  SessionRegistry.subscribe((event) => {
    log('Session event:', event.type);
    // Broadcast to all extension pages (sidebar, etc.)
    browserAPI.runtime.sendMessage({
      type: event.type,
      ...(event.type === 'session_created' ? { session: event.session } : {}),
      ...(event.type === 'session_updated' ? { session: event.session } : {}),
      ...(event.type === 'session_terminated' ? { sessionId: event.sessionId, origin: event.origin } : {}),
    }).catch(() => {
      // Ignore errors - sidebar may not be open
    });
  });

  // Handle one-shot messages from other extensions
  browserAPI.runtime.onMessageExternal.addListener(
    (message: ExtensionApiRequest, sender, sendResponse) => {
      log('External message:', message.type, 'from', sender.id);

      // Streaming requests need a port connection, not sendMessage
      if (message.type === 'llm.chatStream') {
        sendResponse(failure('Use browser.runtime.connect for streaming requests'));
        return false;
      }

      // Route the message and send response
      routeMessage(message, sender)
        .then(sendResponse)
        .catch((e) => sendResponse(failure(e)));

      return true; // Keep channel open for async response
    }
  );

  // Handle port connections for streaming
  browserAPI.runtime.onConnectExternal.addListener((port) => {
    log('External port connection from:', port.sender?.id);

    port.onMessage.addListener((message: ExtensionApiRequest) => {
      if (message.type === 'llm.chatStream') {
        handleStreamingChat(message, port.sender!, port);
      } else {
        // Non-streaming requests via port
        routeMessage(message, port.sender!)
          .then((response) => port.postMessage({ type: 'response', ...response }))
          .catch((e) => port.postMessage({ type: 'response', ok: false, error: String(e) }));
      }
    });
  });

  log('Extension API initialized');
}
