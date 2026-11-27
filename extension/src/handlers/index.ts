/**
 * Handler Registry
 * 
 * Central registration point for all Harbor message handlers.
 */

export * from './types';

import { registerServerHandlers } from './server-handlers';
import { registerBridgeHandlers } from './bridge-handlers';
import { registerLlmHandlers } from './llm-handlers';
import { registerOAuthHandlers } from './oauth-handlers';
import { registerPermissionHandlers } from './permission-handlers';
import { registerSessionHandlers } from './session-handlers';
import { registerRemoteServerHandlers } from './remote-server-handlers';
import { registerPageChatHandlers } from './page-chat-handlers';
import { registerAuditHandlers } from './audit-handlers';
import { registerAgentTurnHandlers } from './agent-turn-handlers';
import { registerAcpAgentHandlers } from './acp-agent-handlers';
import { registerOutsideAgentHandlers } from './agent-tabs-handlers';

/**
 * Initialize all message handlers.
 * Call this once during extension startup.
 */
export function initializeHandlers(): void {
  registerServerHandlers();
  registerBridgeHandlers();
  registerLlmHandlers();
  registerOAuthHandlers();
  registerPermissionHandlers();
  registerSessionHandlers();
  registerRemoteServerHandlers();
  registerPageChatHandlers();
  registerAuditHandlers();
  registerAgentTurnHandlers();
  registerAcpAgentHandlers();
  registerOutsideAgentHandlers();

  console.log('[Harbor] All message handlers registered');
}

// Re-export individual registrations for selective use
export {
  registerServerHandlers,
  registerBridgeHandlers,
  registerLlmHandlers,
  registerOAuthHandlers,
  registerPermissionHandlers,
  registerSessionHandlers,
  registerRemoteServerHandlers,
  registerPageChatHandlers,
  registerAuditHandlers,
  registerAgentTurnHandlers,
  registerAcpAgentHandlers,
};
