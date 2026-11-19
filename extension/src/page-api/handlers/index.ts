/**
 * Handler Registry
 * 
 * Central registry for all message handlers. Replaces the large switch statement
 * with a clean handler lookup pattern.
 */

import type { RequestContext, HandlerResponse, MessageHandler, HandlerRegistry } from './types';
export * from './types';

// Import all handlers
import {
  handleAiCanCreateTextSession,
  handleAiCreateTextSession,
  handleSessionPrompt,
  handleSessionDestroy,
  handleLanguageModelCapabilities,
  handleProvidersList,
  handleProvidersGetActive,
  handleProvidersListConfiguredModels,
  handleProvidersGetConfiguredModelsMetadata,
  resolveTextSession,
  recordExplicitPrompt,
  forgetTextSession,
} from './ai-handlers';

import {
  handleRequestPermissions,
  handlePermissionsList,
  hasPermission,
  getPermissions,
} from './permission-handlers';

import {
  handleToolsList,
  handleToolsCall,
} from './tool-handlers';

import {
  handleSessionsCreate,
  handleSessionsGet,
  handleSessionsList,
  handleSessionsTerminate,
} from './session-handlers';

import {
  handleMcpDiscover,
  handleMcpRegister,
  handleMcpUnregister,
} from './mcp-handlers';

import {
  handleChatCanOpen,
  handleChatOpen,
  handleChatClose,
} from './chat-handlers';

import {
  handleBrowserClick,
  handleBrowserFill,
  handleBrowserSelect,
  handleBrowserScroll,
  handleBrowserScreenshot,
  handleBrowserGetElements,
  handleBrowserReadability,
  handleBrowserNavigate,
  handleBrowserFetch,
} from './browser-handlers';

import {
  handleTabsCreate,
  handleTabsList,
  handleTabsClose,
  handleSpawnedTabReadability,
  handleSpawnedTabGetHtml,
  handleSpawnedTabWaitForLoad,
  restoreSpawnedTabs,
  trackSpawnedTab,
  untrackSpawnedTab,
  isSpawnedTab,
  getAllSpawnedTabs,
  handleTabRemoved,
} from './tab-handlers';

import {
  handleAgentsRegister,
  handleAgentsUnregister,
  handleAgentsGetInfo,
  handleAgentsDiscover,
  handleAgentsList,
  handleAgentsInvoke,
  handleAgentsSend,
  handleAgentsSubscribe,
  handleAgentsUnsubscribe,
  handleAgentsBroadcast,
  handleAgentsPipeline,
  handleAgentsParallel,
  handleAgentsRoute,
  handleIncomingInvocation,
  resolveInvocationResponse,
  cleanupAgentsForTab,
  registeredAgents,
  agentInvocationTabs,
} from './agent-handlers';

import { executeScriptInTab, browserAPI } from '../../browser-compat';
import { featureRefusal, getFeatureFlags } from '../policy/feature-flags';

// =============================================================================
// Handler Registry
// =============================================================================

const handlers: HandlerRegistry = new Map<string, MessageHandler>();

// AI handlers
handlers.set('ai.canCreateTextSession', handleAiCanCreateTextSession);
handlers.set('ai.createTextSession', handleAiCreateTextSession);
handlers.set('ai.languageModel.create', handleAiCreateTextSession); // Alias
handlers.set('session.prompt', handleSessionPrompt);
handlers.set('session.destroy', handleSessionDestroy);
handlers.set('ai.languageModel.capabilities', handleLanguageModelCapabilities);
handlers.set('ai.providers.list', handleProvidersList);
handlers.set('ai.providers.getActive', handleProvidersGetActive);
handlers.set('ai.providers.listConfiguredModels', handleProvidersListConfiguredModels);
handlers.set('ai.providers.getConfiguredModelsMetadata', handleProvidersGetConfiguredModelsMetadata);

// Permission handlers
handlers.set('agent.requestPermissions', handleRequestPermissions);
handlers.set('agent.permissions.list', handlePermissionsList);

// Tool handlers
handlers.set('agent.tools.list', handleToolsList);
handlers.set('agent.tools.call', handleToolsCall);

// Session handlers (explicit sessions)
handlers.set('agent.sessions.create', handleSessionsCreate);
handlers.set('agent.sessions.get', handleSessionsGet);
handlers.set('agent.sessions.list', handleSessionsList);
handlers.set('agent.sessions.terminate', handleSessionsTerminate);

// MCP handlers
handlers.set('agent.mcp.discover', handleMcpDiscover);
handlers.set('agent.mcp.register', handleMcpRegister);
handlers.set('agent.mcp.unregister', handleMcpUnregister);

// Chat handlers
handlers.set('agent.chat.canOpen', handleChatCanOpen);
handlers.set('agent.chat.open', handleChatOpen);
handlers.set('agent.chat.close', handleChatClose);

// Browser interaction handlers
handlers.set('agent.browser.activeTab.click', handleBrowserClick);
handlers.set('agent.browser.activeTab.fill', handleBrowserFill);
handlers.set('agent.browser.activeTab.select', handleBrowserSelect);
handlers.set('agent.browser.activeTab.scroll', handleBrowserScroll);
handlers.set('agent.browser.activeTab.screenshot', handleBrowserScreenshot);
handlers.set('agent.browser.activeTab.getElements', handleBrowserGetElements);
handlers.set('agent.browser.activeTab.readability', handleBrowserReadability);

// Top-level browser handlers (active tab)
handlers.set('agent.browser.navigate', handleBrowserNavigate);
handlers.set('agent.browser.fetch', handleBrowserFetch);

// Tab management handlers
handlers.set('agent.browser.tabs.create', handleTabsCreate);
handlers.set('agent.browser.tabs.list', handleTabsList);
handlers.set('agent.browser.tabs.close', handleTabsClose);

// Spawned tab handlers
handlers.set('agent.browser.tab.readability', handleSpawnedTabReadability);
handlers.set('agent.browser.tab.getHtml', handleSpawnedTabGetHtml);
handlers.set('agent.browser.tab.waitForLoad', handleSpawnedTabWaitForLoad);

// Multi-agent handlers
handlers.set('agent.agents.register', handleAgentsRegister);
handlers.set('agent.agents.unregister', handleAgentsUnregister);
handlers.set('agent.agents.getInfo', handleAgentsGetInfo);
handlers.set('agent.agents.discover', handleAgentsDiscover);
handlers.set('agent.agents.list', handleAgentsList);
handlers.set('agent.agents.invoke', handleAgentsInvoke);
handlers.set('agent.agents.send', handleAgentsSend);
handlers.set('agent.agents.subscribe', handleAgentsSubscribe);
handlers.set('agent.agents.unsubscribe', handleAgentsUnsubscribe);
handlers.set('agent.agents.broadcast', handleAgentsBroadcast);
handlers.set('agent.agents.orchestrate.pipeline', handleAgentsPipeline);
handlers.set('agent.agents.orchestrate.parallel', handleAgentsParallel);
handlers.set('agent.agents.orchestrate.route', handleAgentsRoute);

// =============================================================================
// Router
// =============================================================================

/**
 * Route a message to its handler.
 * Returns undefined if no handler is found (for streaming handlers).
 */
export async function routeMessage(ctx: RequestContext): HandlerResponse {
  const handler = handlers.get(ctx.type);
  
  // Enforce the setting at the receiver: a page can send transport messages
  // directly, without going through the injected API's disabled wrapper.
  const refusal = handler ? featureRefusal(ctx.type, await getFeatureFlags()) : null;
  if (refusal) {
    return { id: ctx.id, ok: false, error: refusal };
  }

  if (handler) {
    return handler(ctx);
  }
  
  // Unknown message type
  return {
    id: ctx.id,
    ok: false,
    error: { code: 'ERR_INTERNAL', message: `Unknown message type: ${ctx.type}` },
  };
}

/**
 * Check if a message type has a registered handler.
 */
export function hasHandler(type: string): boolean {
  return handlers.has(type);
}

/**
 * List of message types that require streaming (not handled by routeMessage).
 */
export const STREAMING_MESSAGE_TYPES = ['session.promptStreaming', 'agent.run'] as const;

/**
 * Check if a message type is a streaming message.
 */
export function isStreamingMessage(type: string): boolean {
  return STREAMING_MESSAGE_TYPES.includes(type as typeof STREAMING_MESSAGE_TYPES[number]);
}

// =============================================================================
// Re-exports for external use
// =============================================================================

// Permission utilities
export {
  hasPermission,
  getPermissions,
};

// AI utilities
export { resolveTextSession, recordExplicitPrompt, forgetTextSession };

// Tab utilities
export {
  restoreSpawnedTabs,
  trackSpawnedTab,
  untrackSpawnedTab,
  isSpawnedTab,
  getAllSpawnedTabs,
  handleTabRemoved,
};

// Agent utilities
export {
  handleIncomingInvocation,
  resolveInvocationResponse,
  cleanupAgentsForTab,
  registeredAgents,
  agentInvocationTabs,
};

// Browser compat
export { executeScriptInTab, browserAPI };
