export { handleAgentGatewayRequest } from './handler';
export {
  AgentGatewayControlPlane,
  initializeAgentGatewayControlPlane,
} from './control-plane';
export {
  agentGatewayRegistry,
  endSession,
  getAgentGatewayAuthoritySnapshot,
  invalidateGatewayAuthority,
  invalidatePairedClientAuthority,
  initializeAgentGateway,
  pauseSession,
  persistAgentGatewayState,
  revokePairedClient,
  resumeSession,
  setGatewayEnabled,
  startSession,
  syncPairedClients,
} from './registry';
export type {
  AgentGatewayAuthoritySnapshot,
  PairedClientMetadata,
  StartAgentGatewaySessionInput,
} from './registry';
export type {
  AgentGatewayRequest,
  AgentGatewayResponse,
  AgentGatewaySession,
  PairedAgentGatewayClient,
} from './types';
