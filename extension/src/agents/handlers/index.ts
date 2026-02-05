/**
 * Handler exports for background router.
 */

// Types
export type { RequestContext, ResponseSender, RequestHandler } from './router-types';

// Helpers
export { log, requirePermission } from './helpers';

// Permission handlers
export {
  handleRequestPermissions,
  handleListPermissions,
} from './permissions';

// Tools handlers
export {
  handleToolsList,
  handleToolsCall,
} from './tools';

// AI session handlers
export {
  handleCanCreateTextSession,
  handleCreateTextSession,
  handleSessionPrompt,
  handleSessionDestroy,
  handleLanguageModelCapabilities,
  handleProvidersList,
  handleRuntimeGetCapabilities,
} from './ai-sessions';

// Capabilities handler
export { handleAgentCapabilities } from './capabilities';

// Browser active-tab handlers
export {
  handleActiveTabReadability,
  handleActiveTabClick,
  handleActiveTabFill,
  handleActiveTabSelect,
  handleActiveTabScroll,
  handleActiveTabGetElement,
  handleActiveTabWaitForSelector,
  handleActiveTabScreenshot,
} from './browser-active-tab';

// Browser tabs handlers
export {
  handleBrowserNavigate,
  handleBrowserWaitForNavigation,
  handleTabsList,
  handleTabsGet,
  handleTabsCreate,
  handleTabsClose,
  handleSpawnedTabReadability,
  handleSpawnedTabGetHtml,
  handleSpawnedTabClick,
  handleSpawnedTabFill,
  handleSpawnedTabScroll,
  handleSpawnedTabScreenshot,
  handleSpawnedTabNavigate,
  handleSpawnedTabWaitForNavigation,
} from './browser-tabs';

// Web fetch handler
export { handleAgentFetch } from './web-fetch';

// Chat handlers
export {
  handleChatCanOpen,
  handleChatOpen,
  handleChatClose,
} from './chat';

// MCP website handlers
export {
  handleMcpDiscover,
  handleMcpRegister,
  handleMcpUnregister,
} from './mcp-website';

// Multi-agent handlers
export {
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
} from './multi-agent';

// Agent run handler
export { handleAgentRun } from './agent-run';
