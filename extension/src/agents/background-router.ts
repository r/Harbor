/**
 * Background Router
 *
 * Routes messages from content scripts to appropriate handlers.
 * Handles the Web Agent API (window.ai/window.agent) requests from web pages.
 */

import type {
  MessageType,
  TransportResponse,
  TransportStreamEvent,
  PermissionScope,
  PermissionGrantResult,
  PermissionStatus,
  RequestPermissionsOptions,
  ToolDescriptor,
  RunEvent,
  StreamToken,
  ApiError,
} from './types';
import {
  getPermissionStatus,
  checkPermissions,
  requestPermissions,
  handlePermissionPromptResponse,
  isToolAllowed,
  SCOPE_DESCRIPTIONS,
} from '../policy/permissions';
import { listServersWithStatus, callTool } from '../mcp/host';
import { bridgeRequest } from '../llm/bridge-client';

const DEBUG = true;

function log(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[Harbor Router]', ...args);
  }
}

// =============================================================================
// State Management
// =============================================================================

// Active text sessions
const textSessions = new Map<string, {
  sessionId: string;
  origin: string;
  options: Record<string, unknown>;
  history: Array<{ role: string; content: string }>;
  createdAt: number;
}>();

// Session ID counter
let sessionIdCounter = 0;

function generateSessionId(): string {
  return `session-${Date.now()}-${++sessionIdCounter}`;
}

// =============================================================================
// Message Types
// =============================================================================

interface RequestContext {
  id: string;
  type: MessageType;
  payload: unknown;
  origin: string;
  tabId?: number;
}

type ResponseSender = {
  sendResponse: (response: TransportResponse) => void;
  sendStreamEvent: (event: TransportStreamEvent) => void;
};

// =============================================================================
// Permission Helpers
// =============================================================================

async function requirePermission(
  ctx: RequestContext,
  sender: ResponseSender,
  scope: PermissionScope,
): Promise<boolean> {
  const result = await checkPermissions(ctx.origin, [scope], ctx.tabId);
  if (result.granted) {
    return true;
  }

  sender.sendResponse({
    id: ctx.id,
    ok: false,
    error: {
      code: 'ERR_SCOPE_REQUIRED',
      message: `Permission "${scope}" is required. Call agent.requestPermissions() first.`,
      details: { requiredScope: scope, missingScopes: result.missingScopes },
    },
  });
  return false;
}

// =============================================================================
// Request Handlers
// =============================================================================

async function handleRequestPermissions(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const payload = ctx.payload as RequestPermissionsOptions;
  log('handleRequestPermissions:', ctx.origin, payload);

  const result = await requestPermissions(ctx.origin, payload, ctx.tabId);
  log('Permission result:', result);

  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result,
  });
}

async function handleListPermissions(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const status = await getPermissionStatus(ctx.origin, ctx.tabId);
  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: status,
  });
}

async function handleToolsList(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'mcp:tools.list'))) {
    return;
  }

  try {
    const servers = await listServersWithStatus();
    const tools: ToolDescriptor[] = [];

    for (const server of servers) {
      if (server.running && server.tools) {
        for (const tool of server.tools) {
          tools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            serverId: server.id,
          });
        }
      }
    }

    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: tools,
    });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to list tools',
      },
    });
  }
}

async function handleToolsCall(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'mcp:tools.call'))) {
    return;
  }

  const payload = ctx.payload as { tool: string; args: Record<string, unknown> };

  // Check if tool is allowed
  const allowed = await isToolAllowed(ctx.origin, payload.tool);
  if (!allowed) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_TOOL_NOT_ALLOWED',
        message: `Tool "${payload.tool}" is not in the allowed list`,
      },
    });
    return;
  }

  try {
    // Parse tool name to get serverId
    const parts = payload.tool.split('/');
    let serverId: string;
    let toolName: string;

    if (parts.length >= 2) {
      serverId = parts[0];
      toolName = parts.slice(1).join('/');
    } else {
      // Try to find the tool in any server
      const servers = await listServersWithStatus();
      const found = servers.find(s => s.running && s.tools?.some(t => t.name === payload.tool));
      if (!found) {
        sender.sendResponse({
          id: ctx.id,
          ok: false,
          error: {
            code: 'ERR_TOOL_NOT_ALLOWED',
            message: `Tool "${payload.tool}" not found in any running server`,
          },
        });
        return;
      }
      serverId = found.id;
      toolName = payload.tool;
    }

    const result = await callTool(serverId, toolName, payload.args);
    sender.sendResponse({
      id: ctx.id,
      ok: result.ok,
      result: result.result,
      error: result.error ? { code: 'ERR_TOOL_FAILED', message: result.error } : undefined,
    });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Tool call failed',
      },
    });
  }
}

async function handleCanCreateTextSession(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  // Check if bridge is connected
  try {
    const result = await bridgeRequest<{ models: unknown[] }>('llm.list_configured_models');
    const available = result.models && result.models.length > 0 ? 'readily' : 'no';
    sender.sendResponse({ id: ctx.id, ok: true, result: available });
  } catch {
    sender.sendResponse({ id: ctx.id, ok: true, result: 'no' });
  }
}

async function handleCreateTextSession(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'model:prompt'))) {
    return;
  }

  const payload = (ctx.payload || {}) as Record<string, unknown>;
  const sessionId = generateSessionId();

  textSessions.set(sessionId, {
    sessionId,
    origin: ctx.origin,
    options: payload,
    history: payload.systemPrompt
      ? [{ role: 'system', content: payload.systemPrompt as string }]
      : [],
    createdAt: Date.now(),
  });

  sender.sendResponse({ id: ctx.id, ok: true, result: sessionId });
}

async function handleSessionPrompt(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'model:prompt'))) {
    return;
  }

  const payload = ctx.payload as { sessionId: string; input: string };
  const session = textSessions.get(payload.sessionId);

  if (!session) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_SESSION_NOT_FOUND', message: 'Session not found' },
    });
    return;
  }

  if (session.origin !== ctx.origin) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Session belongs to different origin' },
    });
    return;
  }

  try {
    // Add user message to history
    session.history.push({ role: 'user', content: payload.input });

    // Call LLM
    const result = await bridgeRequest<{
      response?: { role: string; content: string };
      message?: { role: string; content: string };
      content?: string;
    }>('llm.chat', {
      messages: session.history,
      model: session.options.model,
    });

    const content = result.response?.content || result.message?.content || result.content || '';

    // Add assistant response to history
    session.history.push({ role: 'assistant', content });

    sender.sendResponse({ id: ctx.id, ok: true, result: content });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_MODEL_FAILED',
        message: error instanceof Error ? error.message : 'Model request failed',
      },
    });
  }
}

async function handleSessionDestroy(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const payload = ctx.payload as { sessionId: string };
  const session = textSessions.get(payload.sessionId);

  if (session && session.origin === ctx.origin) {
    textSessions.delete(payload.sessionId);
  }

  sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
}

async function handleLanguageModelCapabilities(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  try {
    const result = await bridgeRequest<{ models: unknown[] }>('llm.list_configured_models');
    const available = result.models && result.models.length > 0 ? 'readily' : 'no';
    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: {
        available,
        defaultTemperature: 0.7,
        defaultTopK: 40,
        maxTopK: 100,
      },
    });
  } catch {
    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: { available: 'no' },
    });
  }
}

async function handleProviderslist(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'model:list'))) {
    return;
  }

  try {
    const result = await bridgeRequest<{ providers: unknown[] }>('llm.list_providers');
    sender.sendResponse({ id: ctx.id, ok: true, result: result.providers });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to list providers',
      },
    });
  }
}

// =============================================================================
// Not Implemented Handlers
// =============================================================================

function handleNotImplemented(ctx: RequestContext, sender: ResponseSender): void {
  sender.sendResponse({
    id: ctx.id,
    ok: false,
    error: {
      code: 'ERR_NOT_IMPLEMENTED',
      message: `Method "${ctx.type}" is not yet implemented`,
    },
  });
}

// =============================================================================
// Message Router
// =============================================================================

async function routeMessage(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  log('Routing message:', ctx.type, 'from', ctx.origin);

  switch (ctx.type) {
    // Permission methods
    case 'agent.requestPermissions':
      return handleRequestPermissions(ctx, sender);
    case 'agent.permissions.list':
      return handleListPermissions(ctx, sender);

    // Tool methods
    case 'agent.tools.list':
      return handleToolsList(ctx, sender);
    case 'agent.tools.call':
      return handleToolsCall(ctx, sender);

    // AI/Session methods
    case 'ai.canCreateTextSession':
      return handleCanCreateTextSession(ctx, sender);
    case 'ai.createTextSession':
    case 'ai.languageModel.create':
      return handleCreateTextSession(ctx, sender);
    case 'ai.languageModel.capabilities':
      return handleLanguageModelCapabilities(ctx, sender);
    case 'session.prompt':
      return handleSessionPrompt(ctx, sender);
    case 'session.destroy':
      return handleSessionDestroy(ctx, sender);

    // Provider methods
    case 'ai.providers.list':
      return handleProviderslist(ctx, sender);

    // Not yet implemented
    case 'session.promptStreaming':
    case 'session.clone':
    case 'ai.providers.getActive':
    case 'ai.providers.add':
    case 'ai.providers.remove':
    case 'ai.providers.setDefault':
    case 'ai.providers.setTypeDefault':
    case 'ai.runtime.getBest':
    case 'agent.browser.activeTab.readability':
    case 'agent.run':
    case 'agent.mcp.discover':
    case 'agent.mcp.register':
    case 'agent.mcp.unregister':
    case 'agent.chat.canOpen':
    case 'agent.chat.open':
    case 'agent.chat.close':
    case 'agent.addressBar.canProvide':
    case 'agent.addressBar.registerProvider':
    case 'agent.addressBar.registerToolShortcuts':
    case 'agent.addressBar.registerSiteProvider':
    case 'agent.addressBar.discover':
    case 'agent.addressBar.listProviders':
    case 'agent.addressBar.unregisterProvider':
    case 'agent.addressBar.setDefaultProvider':
    case 'agent.addressBar.getDefaultProvider':
    case 'agent.addressBar.query':
    case 'agent.addressBar.select':
      return handleNotImplemented(ctx, sender);

    default:
      sender.sendResponse({
        id: ctx.id,
        ok: false,
        error: {
          code: 'ERR_NOT_IMPLEMENTED',
          message: `Unknown method: ${ctx.type}`,
        },
      });
  }
}

// =============================================================================
// Port Connection Handler
// =============================================================================

function handlePortConnection(port: chrome.runtime.Port): void {
  if (port.name !== 'web-agent-transport') {
    return;
  }

  log('New web-agent-transport connection from tab:', port.sender?.tab?.id);

  const tabId = port.sender?.tab?.id;

  port.onMessage.addListener(async (message: {
    id: string;
    type: string;
    payload?: unknown;
    origin?: string;
  }) => {
    // Handle abort
    if (message.type === 'abort') {
      log('Abort signal received for:', message.id);
      // TODO: Implement abort handling for streaming requests
      return;
    }

    const ctx: RequestContext = {
      id: message.id,
      type: message.type as MessageType,
      payload: message.payload,
      origin: message.origin || 'unknown',
      tabId,
    };

    const sender: ResponseSender = {
      sendResponse: (response) => {
        try {
          port.postMessage(response);
        } catch (error) {
          log('Failed to send response:', error);
        }
      },
      sendStreamEvent: (event) => {
        try {
          port.postMessage(event);
        } catch (error) {
          log('Failed to send stream event:', error);
        }
      },
    };

    try {
      await routeMessage(ctx, sender);
    } catch (error) {
      log('Error routing message:', error);
      sender.sendResponse({
        id: ctx.id,
        ok: false,
        error: {
          code: 'ERR_INTERNAL',
          message: error instanceof Error ? error.message : 'Internal error',
        },
      });
    }
  });

  port.onDisconnect.addListener(() => {
    log('web-agent-transport disconnected from tab:', tabId);
  });
}

// =============================================================================
// Permission Prompt Response Handler
// =============================================================================

function handlePermissionPromptMessage(
  message: {
    type?: string;
    response?: {
      granted: boolean;
      grantType?: 'granted-once' | 'granted-always';
      allowedTools?: string[];
    };
  },
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  if (message?.type !== 'permission_prompt_response') {
    return false;
  }

  log('Permission prompt response:', message.response);

  if (message.response) {
    handlePermissionPromptResponse(message.response);
  }

  // Close the prompt window
  sendResponse({ ok: true });
  return true;
}

// =============================================================================
// Initialize Router
// =============================================================================

export function initializeRouter(): void {
  log('Initializing router...');

  // Listen for port connections from content scripts
  chrome.runtime.onConnect.addListener(handlePortConnection);

  // Listen for permission prompt responses
  chrome.runtime.onMessage.addListener(handlePermissionPromptMessage);

  log('Router initialized');
}
