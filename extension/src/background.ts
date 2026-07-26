/**
 * Harbor Extension - Background Script
 *
 * Main entry point for the extension's background service worker.
 * Initializes all modules and sets up message routing.
 */

import { browserAPI, getBrowserName, isSafari, isServiceWorker, serviceWorkerLifecycle, getFeatureSummary } from './browser-compat';
import { initializePolicyStore } from './policy/store';
import { initializeBridgeClient } from './llm/bridge-client';
import { rpcRequest, isNativeBridgeReady } from './llm/native-bridge';
import { initializeMcpHost, callTool } from './mcp/host';
import { cleanupExpiredGrants } from './policy/permissions';
import { initializeExtensionApi } from './extension-api';
import { initializeRouter } from './agents/background-router';
import { initializeHandlers } from './handlers';
import { initializeAgentGateway } from './agent-gateway';

console.log(`[Harbor] Extension starting on ${getBrowserName()}...`);
console.log('[Harbor] Browser features:', getFeatureSummary());

// =============================================================================
// Service Worker Lifecycle (Chrome MV3)
// =============================================================================

serviceWorkerLifecycle.onStartup(() => {
  console.log('[Harbor] Service worker startup - restoring state...');
  initializeBridgeClient();
});

serviceWorkerLifecycle.onInstalled((details) => {
  console.log(`[Harbor] Extension ${details.reason}${details.previousVersion ? ` from ${details.previousVersion}` : ''}`);
  if (details.reason === 'install') {
    console.log('[Harbor] First install - initializing...');
  } else if (details.reason === 'update') {
    console.log('[Harbor] Extension updated');
  }
});

serviceWorkerLifecycle.onSuspend(() => {
  console.log('[Harbor] Service worker suspending - saving state...');
});

// =============================================================================
// Module Initialization
// =============================================================================

initializePolicyStore();
initializeBridgeClient();
initializeMcpHost();
initializeExtensionApi();
initializeRouter();
void initializeAgentGateway();
cleanupExpiredGrants();

// Register all message handlers
initializeHandlers();

// =============================================================================
// Safari: Poll for pending tool calls from bridge (WASM servers run in extension)
// =============================================================================

if (isSafari()) {
  const POLL_INTERVAL = 500;
  
  async function pollPendingToolCalls() {
    if (!isNativeBridgeReady()) return;
    
    try {
      const response = await rpcRequest('mcp.poll_pending_calls', {}) as { calls?: Array<{
        call_id: string;
        serverId: string;
        toolName: string;
        args: Record<string, unknown>;
      }> };
      
      const calls = response?.calls || [];
      
      for (const call of calls) {
        console.log('[Harbor:Safari] Executing pending tool call:', call.call_id, call.serverId, call.toolName);
        
        try {
          const result = await callTool(call.serverId, call.toolName, call.args || {});
          await rpcRequest('mcp.submit_call_result', {
            call_id: call.call_id,
            result: result,
          });
          console.log('[Harbor:Safari] Tool call succeeded:', call.call_id);
        } catch (err) {
          await rpcRequest('mcp.submit_call_result', {
            call_id: call.call_id,
            error: err instanceof Error ? err.message : String(err),
          });
          console.error('[Harbor:Safari] Tool call failed:', call.call_id, err);
        }
      }
    } catch (err) {
      // Ignore poll errors (bridge may not be ready)
    }
  }
  
  setInterval(pollPendingToolCalls, POLL_INTERVAL);
  console.log('[Harbor:Safari] Started pending tool call polling');
}

// =============================================================================
// Debug Utilities
// =============================================================================

// Debug: log all incoming messages
browserAPI.runtime.onMessage.addListener((message) => {
  console.log('[Harbor] Incoming message:', message?.type, message);
  return false;
});

// Debug: expose callTool for console testing
(globalThis as Record<string, unknown>).debugCallTool = callTool;

console.log('[Harbor] Extension initialized.');
