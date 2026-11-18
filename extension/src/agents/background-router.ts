/**
 * Background Router
 *
 * Routes messages from content scripts to appropriate handlers.
 * Handles the Web Agent API (window.ai/window.agent) requests from web pages.
 */

import { browserAPI } from '../browser-compat';
import type { MessageType } from './types';
import type { RequestContext, ResponseSender } from './handlers/router-types';
import { handlePermissionPromptResponse } from '../policy/permissions';
import { initializeAgentRegistry } from '../multi-agent/registry';

// Import all handlers
import {
  log,
  // Chat handlers
  handleChatCanOpen,
  handleChatOpen,
  handleChatClose,
  // MCP website handlers
  handleMcpDiscover,
  handleMcpRegister,
  handleMcpUnregister,
  // Multi-agent handlers
  handleAgentsRegister,
  handleAgentsUnregister,
  handleAgentsGetInfo,
  handleAgentsDiscover,
  handleAgentsList,
  handleAgentsInvoke,
  handleAgentsSend,
  handleAgentsSubscribe,
  handleAgentsUnsubscribe,
  handleAgentsRegisterMessageHandler,
  handleAgentsUnregisterMessageHandler,
  handleAgentsRegisterInvocationHandler,
  handleAgentsUnregisterInvocationHandler,
  handleOrchestratePipeline,
  handleOrchestrateParallel,
  handleOrchestrateRoute,
  handleOrchestrateSupervisor,
  handleRemoteConnect,
  handleRemoteDisconnect,
  handleRemoteList,
  handleRemotePing,
  handleRemoteDiscover,
} from './handlers';

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
    // Chat API
    case 'agent.chat.canOpen':
      return handleChatCanOpen(ctx, sender);
    case 'agent.chat.open':
      return handleChatOpen(ctx, sender);
    case 'agent.chat.close':
      return handleChatClose(ctx, sender);

    // Extension 3: Multi-Agent
    case 'agents.register':
      return handleAgentsRegister(ctx, sender);
    case 'agents.unregister':
      return handleAgentsUnregister(ctx, sender);
    case 'agents.getInfo':
      return handleAgentsGetInfo(ctx, sender);
    case 'agents.discover':
      return handleAgentsDiscover(ctx, sender);
    case 'agents.list':
      return handleAgentsList(ctx, sender);
    case 'agents.invoke':
      return handleAgentsInvoke(ctx, sender);
    case 'agents.send':
      return handleAgentsSend(ctx, sender);
    case 'agents.subscribe':
      return handleAgentsSubscribe(ctx, sender);
    case 'agents.unsubscribe':
      return handleAgentsUnsubscribe(ctx, sender);
    case 'agents.registerMessageHandler':
      return handleAgentsRegisterMessageHandler(ctx, sender);
    case 'agents.unregisterMessageHandler':
      return handleAgentsUnregisterMessageHandler(ctx, sender);
    case 'agents.registerInvocationHandler':
      return handleAgentsRegisterInvocationHandler(ctx, sender);
    case 'agents.unregisterInvocationHandler':
      return handleAgentsUnregisterInvocationHandler(ctx, sender);
    case 'agents.orchestrate.pipeline':
      return handleOrchestratePipeline(ctx, sender);
    case 'agents.orchestrate.parallel':
      return handleOrchestrateParallel(ctx, sender);
    case 'agents.orchestrate.route':
      return handleOrchestrateRoute(ctx, sender);
    case 'agents.orchestrate.supervisor':
      return handleOrchestrateSupervisor(ctx, sender);

    // Extension 3: Remote A2A
    case 'agents.remote.connect':
      return handleRemoteConnect(ctx, sender);
    case 'agents.remote.disconnect':
      return handleRemoteDisconnect(ctx, sender);
    case 'agents.remote.list':
      return handleRemoteList(ctx, sender);
    case 'agents.remote.ping':
      return handleRemotePing(ctx, sender);
    case 'agents.remote.discover':
      return handleRemoteDiscover(ctx, sender);

    // Regular methods not yet implemented
    case 'session.clone':
    case 'ai.providers.getActive':
    case 'ai.providers.add':
    case 'ai.providers.remove':
    case 'ai.providers.setDefault':
    case 'ai.providers.setTypeDefault':
    case 'ai.runtime.getBest':
      return handleNotImplemented(ctx, sender);

    // MCP server registration (from websites)
    case 'agent.mcp.discover':
      return handleMcpDiscover(ctx, sender);
    case 'agent.mcp.register':
      return handleMcpRegister(ctx, sender);
    case 'agent.mcp.unregister':
      return handleMcpUnregister(ctx, sender);

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
  _sender: { id?: string; url?: string; tab?: { id?: number } },
  sendResponse: (response?: unknown) => void,
): boolean {
  if (message?.type !== 'permission_prompt_response') {
    return false;
  }

  log('Permission prompt response received');

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

  // Initialize agent registry for Extension 3
  initializeAgentRegistry();

  // Listen for permission prompt responses
  browserAPI.runtime.onMessage.addListener(handlePermissionPromptMessage);

  // agent.* and agents.* page calls reach routeAgentMessage() in-process,
  // called directly by page-api/harbor-core.ts.
  log('Router initialized');
}

/**
 * Handle an `agent.*`/`agents.*` message. page-api/harbor-core.ts calls this
 * in-process for every page call of that shape, always passing the page's
 * own origin (and tabId, when relevant) in `payload`, which
 * page-api/background.ts sets from the connecting port's sender — never
 * from a page-supplied field. A call with no `payload.origin` is rejected
 * outright rather than attributed to anything else.
 */
export function routeAgentMessage(
  message: { type: string; payload?: unknown; requestId?: string },
  sendResponse: (response: { ok: boolean; result?: unknown; error?: string }) => void,
): void {
  log('Agent message:', message.type);

  const payload = message.payload as { origin?: string; tabId?: number } | undefined;
  const pageOrigin = payload?.origin;

  if (!pageOrigin) {
    sendResponse({ ok: false, error: 'Missing origin' });
    return;
  }

  const ctx: RequestContext = {
    id: message.requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: message.type as MessageType,
    payload: message.payload,
    origin: pageOrigin,
    tabId: payload?.tabId,
  };

  // Create a sender wrapper that uses sendResponse
  const responseSender: ResponseSender = {
    sendResponse: (response) => {
      sendResponse({
        ok: response.ok,
        result: response.result,
        error: response.error?.message || (response.ok ? undefined : 'Unknown error'),
      });
    },
    sendStreamEvent: () => {
      // Streaming not supported through this entry point.
      log('Streaming not supported for agent router calls');
    },
  };

  // Route the message
  routeMessage(ctx, responseSender).catch((error) => {
    log('Error routing agent message:', error);
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  });
}

