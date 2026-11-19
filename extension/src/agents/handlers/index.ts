/**
 * Handler exports for background router.
 */

// Types
export type { RequestContext, ResponseSender, RequestHandler } from './router-types';

// Helpers
export { log, requireAction } from './helpers';

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
  handleAgentsBroadcast,
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
