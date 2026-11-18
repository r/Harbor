/**
 * Bridge Handlers
 * 
 * Handlers for native bridge status and communication.
 */

import { registerHandler } from './types';
import { getBridgeConnectionState, checkBridgeHealth } from '../llm/bridge-client';
import { getConnectionState as getNativeConnectionState, connectNativeBridge } from '../llm/native-bridge';

export function registerBridgeHandlers(): void {
  // Get bridge status
  registerHandler('bridge_get_status', (_message, _sender, sendResponse) => {
    const state = getBridgeConnectionState();
    sendResponse({ ok: true, ...state });
    return true;
  });

  // Check bridge health (on failure, try reconnect so switching back to Harbor restores connection)
  registerHandler('bridge_check_health', (_message, _sender, sendResponse) => {
    checkBridgeHealth()
      .then(() => {
        const state = getBridgeConnectionState();
        sendResponse({ ok: true, connected: state.connected, bridgeReady: state.bridgeReady, error: state.error });
      })
      .catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.toLowerCase().includes('not connected') || msg.toLowerCase().includes('bridge not connected')) {
          connectNativeBridge();
        }
        const state = getBridgeConnectionState();
        sendResponse({
          ok: state.bridgeReady,
          connected: state.connected,
          bridgeReady: state.bridgeReady,
          error: state.error || msg,
        });
      });
    return true;
  });

  // Get native bridge status
  registerHandler('native_bridge_status', (_message, _sender, sendResponse) => {
    const state = getNativeConnectionState();
    sendResponse({ ok: true, ...state });
    return true;
  });
}
