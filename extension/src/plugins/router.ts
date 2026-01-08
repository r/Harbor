/**
 * Harbor Plugin System - Router
 *
 * Handles extension-to-extension messaging with plugins.
 * Manages request/response correlation, timeouts, and message routing.
 */

import browser from 'webextension-polyfill';
import type {
  PluginMessageEnvelope,
  PluginMessageType,
  PluginMessagePayload,
  PluginDescriptor,
  PluginToolCallPayload,
  PluginToolResultPayload,
  PluginToolErrorPayload,
  PluginErrorCode,
} from './types';
import {
  PLUGIN_PROTOCOL_VERSION,
  PLUGIN_NAMESPACE,
  PLUGIN_REGISTER_TIMEOUT_MS,
  PLUGIN_TOOL_CALL_TIMEOUT_MS,
  PLUGIN_PING_TIMEOUT_MS,
  PLUGIN_HEARTBEAT_INTERVAL_MS,
  isValidPluginMessage,
  isCompatibleProtocolVersion,
  createPluginMessage,
  generatePluginRequestId,
} from './types';
import {
  isPluginAllowed,
  registerPlugin,
  unregisterPlugin,
  getPlugin,
  getActivePlugins,
  recordPluginActivity,
  recordFailedPing,
  updatePluginStatus,
  disablePlugin,
  enablePlugin,
} from './registry';

// =============================================================================
// Types
// =============================================================================

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  type: PluginMessageType;
  pluginId: string;
  createdAt: number;
}

// =============================================================================
// State
// =============================================================================

// Pending requests awaiting responses
const pendingRequests = new Map<string, PendingRequest>();

// Heartbeat interval handle
let heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;

// Router initialization flag
let isInitialized = false;

// Debug logging flag
const DEBUG = true;

function log(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[PluginRouter]', ...args);
  }
}

// =============================================================================
// Request/Response Correlation
// =============================================================================

/**
 * Send a message to a plugin and wait for a response.
 */
async function sendToPlugin<T extends PluginMessageType>(
  pluginId: string,
  type: T,
  payload: PluginMessagePayload<T>,
  timeoutMs: number = PLUGIN_TOOL_CALL_TIMEOUT_MS
): Promise<unknown> {
  const requestId = generatePluginRequestId();
  const message = createPluginMessage(type, payload, requestId);

  return new Promise((resolve, reject) => {
    // Set up timeout
    const timeoutId = setTimeout(() => {
      const pending = pendingRequests.get(requestId);
      if (pending) {
        pendingRequests.delete(requestId);
        reject(new Error(`Plugin request timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    // Store pending request
    pendingRequests.set(requestId, {
      resolve,
      reject,
      timeoutId,
      type,
      pluginId,
      createdAt: Date.now(),
    });

    // Send the message
    log('Sending to plugin:', pluginId, type, requestId);
    browser.runtime
      .sendMessage(pluginId, message)
      .catch((err) => {
        // Clean up pending request on send failure
        const pending = pendingRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timeoutId);
          pendingRequests.delete(requestId);
          reject(new Error(`Failed to send message to plugin: ${err.message}`));
        }
      });
  });
}

/**
 * Handle a response from a plugin.
 */
function handlePluginResponse(requestId: string, payload: unknown, error?: Error): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) {
    log('No pending request for:', requestId);
    return;
  }

  clearTimeout(pending.timeoutId);
  pendingRequests.delete(requestId);

  if (error) {
    pending.reject(error);
  } else {
    pending.resolve(payload);
  }
}

// =============================================================================
// Message Handlers
// =============================================================================

/**
 * Handle PLUGIN_REGISTER message from a plugin.
 */
async function handlePluginRegister(
  senderId: string,
  requestId: string,
  payload: { plugin: PluginDescriptor }
): Promise<void> {
  const { plugin } = payload;

  log('Plugin registration request from:', senderId, plugin.name);

  // Verify the sender ID matches the declared extension ID
  if (plugin.extensionId !== senderId) {
    log('Extension ID mismatch:', plugin.extensionId, '!==', senderId);
    await sendRegistrationAck(senderId, requestId, false, 'Extension ID mismatch');
    return;
  }

  // Check allowlist
  const allowed = await isPluginAllowed(senderId);
  if (!allowed) {
    log('Plugin not in allowlist:', senderId);
    await sendRegistrationAck(senderId, requestId, false, 'Plugin not in allowlist');
    return;
  }

  // Validate tools
  if (!Array.isArray(plugin.tools)) {
    await sendRegistrationAck(senderId, requestId, false, 'Invalid tools array');
    return;
  }

  // Register the plugin
  try {
    await registerPlugin(plugin);
    await sendRegistrationAck(senderId, requestId, true, undefined, senderId);
    log('Plugin registered successfully:', senderId, plugin.name);

    // Notify extension pages about new plugin
    broadcastPluginUpdate('plugin_registered', senderId);
  } catch (err) {
    log('Plugin registration failed:', err);
    await sendRegistrationAck(
      senderId,
      requestId,
      false,
      err instanceof Error ? err.message : 'Registration failed'
    );
  }
}

/**
 * Handle PLUGIN_UNREGISTER message from a plugin.
 */
async function handlePluginUnregister(senderId: string, requestId: string): Promise<void> {
  log('Plugin unregistration request from:', senderId);

  const success = await unregisterPlugin(senderId);

  // Send acknowledgment
  const ackMessage = createPluginMessage('PLUGIN_UNREGISTER_ACK', { success }, requestId);
  try {
    await browser.runtime.sendMessage(senderId, ackMessage);
  } catch (err) {
    log('Failed to send unregister ack:', err);
  }

  if (success) {
    // Notify extension pages
    broadcastPluginUpdate('plugin_unregistered', senderId);
  }
}

/**
 * Handle PLUGIN_TOOL_RESULT message from a plugin.
 */
function handlePluginToolResult(
  senderId: string,
  requestId: string,
  payload: PluginToolResultPayload
): void {
  log('Tool result from:', senderId, requestId);
  recordPluginActivity(senderId);
  handlePluginResponse(requestId, payload);
}

/**
 * Handle PLUGIN_TOOL_ERROR message from a plugin.
 */
function handlePluginToolError(
  senderId: string,
  requestId: string,
  payload: PluginToolErrorPayload
): void {
  log('Tool error from:', senderId, requestId, payload.code);
  recordPluginActivity(senderId);
  handlePluginResponse(requestId, null, new Error(`${payload.code}: ${payload.message}`));
}

/**
 * Handle PLUGIN_PONG message from a plugin.
 */
function handlePluginPong(senderId: string, requestId: string, payload: { healthy: boolean }): void {
  log('Pong from:', senderId, 'healthy:', payload.healthy);
  recordPluginActivity(senderId);
  handlePluginResponse(requestId, payload);
}

/**
 * Handle PLUGIN_TOOLS_LIST_RESULT message from a plugin.
 */
function handlePluginToolsListResult(
  senderId: string,
  requestId: string,
  payload: { tools: unknown[] }
): void {
  log('Tools list from:', senderId, payload.tools?.length, 'tools');
  recordPluginActivity(senderId);
  handlePluginResponse(requestId, payload);
}

// =============================================================================
// Outgoing Messages
// =============================================================================

/**
 * Send a registration acknowledgment.
 */
async function sendRegistrationAck(
  pluginId: string,
  requestId: string,
  success: boolean,
  error?: string,
  toolNamespace?: string
): Promise<void> {
  const ackMessage = createPluginMessage(
    'PLUGIN_REGISTER_ACK',
    { success, error, toolNamespace },
    requestId
  );

  try {
    await browser.runtime.sendMessage(pluginId, ackMessage);
  } catch (err) {
    log('Failed to send registration ack:', err);
  }
}

/**
 * Broadcast a plugin update to extension pages.
 */
function broadcastPluginUpdate(eventType: string, pluginId: string): void {
  browser.runtime
    .sendMessage({ type: 'plugin_update', eventType, pluginId })
    .catch(() => {
      // Ignore - no listeners
    });
}

// =============================================================================
// Plugin Communication API
// =============================================================================

/**
 * Call a tool on a plugin.
 */
export async function callPluginTool(
  pluginId: string,
  toolName: string,
  args: Record<string, unknown>,
  callingOrigin?: string
): Promise<unknown> {
  const plugin = await getPlugin(pluginId);
  if (!plugin) {
    throw new Error(`Plugin not registered: ${pluginId}`);
  }

  if (plugin.status !== 'active') {
    throw new Error(`Plugin is not active: ${pluginId} (status: ${plugin.status})`);
  }

  const payload: PluginToolCallPayload = {
    toolName,
    arguments: args,
    callingOrigin,
  };

  try {
    const result = await sendToPlugin(pluginId, 'PLUGIN_TOOL_CALL', payload, PLUGIN_TOOL_CALL_TIMEOUT_MS);
    return (result as PluginToolResultPayload).result;
  } catch (err) {
    // Record the failure
    if (err instanceof Error && err.message.includes('timed out')) {
      await recordFailedPing(pluginId);
    }
    throw err;
  }
}

/**
 * Ping a plugin to check if it's healthy.
 */
export async function pingPlugin(pluginId: string): Promise<boolean> {
  try {
    const result = (await sendToPlugin(
      pluginId,
      'PLUGIN_PING',
      {},
      PLUGIN_PING_TIMEOUT_MS
    )) as { healthy: boolean };
    return result.healthy;
  } catch (err) {
    log('Ping failed for:', pluginId, err);
    await recordFailedPing(pluginId);
    return false;
  }
}

/**
 * Request updated tools list from a plugin.
 */
export async function requestPluginTools(pluginId: string): Promise<unknown[]> {
  try {
    const result = (await sendToPlugin(
      pluginId,
      'PLUGIN_TOOLS_LIST',
      {},
      PLUGIN_REGISTER_TIMEOUT_MS
    )) as { tools: unknown[] };
    return result.tools;
  } catch (err) {
    log('Tools list request failed for:', pluginId, err);
    throw err;
  }
}

/**
 * Send PLUGIN_DISABLED notification to a plugin.
 */
export async function notifyPluginDisabled(pluginId: string, reason?: string): Promise<void> {
  try {
    const message = createPluginMessage('PLUGIN_DISABLED', { reason });
    await browser.runtime.sendMessage(pluginId, message);
  } catch (err) {
    log('Failed to notify plugin disabled:', pluginId, err);
  }
}

/**
 * Send PLUGIN_ENABLED notification to a plugin.
 */
export async function notifyPluginEnabled(pluginId: string): Promise<void> {
  try {
    const message = createPluginMessage('PLUGIN_ENABLED', {});
    await browser.runtime.sendMessage(pluginId, message);
  } catch (err) {
    log('Failed to notify plugin enabled:', pluginId, err);
  }
}

// =============================================================================
// Heartbeat
// =============================================================================

/**
 * Ping all active plugins to check health.
 */
async function heartbeat(): Promise<void> {
  const plugins = await getActivePlugins();

  for (const plugin of plugins) {
    try {
      const healthy = await pingPlugin(plugin.descriptor.extensionId);
      if (!healthy) {
        log('Plugin health check failed:', plugin.descriptor.extensionId);
      }
    } catch (err) {
      log('Plugin heartbeat error:', plugin.descriptor.extensionId, err);
    }
  }
}

/**
 * Start the heartbeat interval.
 */
export function startHeartbeat(): void {
  if (heartbeatIntervalId) {
    return;
  }

  heartbeatIntervalId = setInterval(heartbeat, PLUGIN_HEARTBEAT_INTERVAL_MS);
  log('Heartbeat started');
}

/**
 * Stop the heartbeat interval.
 */
export function stopHeartbeat(): void {
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
    log('Heartbeat stopped');
  }
}

// =============================================================================
// Message Listener Setup
// =============================================================================

/**
 * Handle incoming external messages from plugins.
 */
function handleExternalMessage(
  message: unknown,
  sender: browser.Runtime.MessageSender
): true | void {
  // Validate sender
  if (!sender.id) {
    log('Rejecting message without sender ID');
    return;
  }

  // Validate message format
  if (!isValidPluginMessage(message)) {
    log('Rejecting invalid message format from:', sender.id);
    return;
  }

  const envelope = message as PluginMessageEnvelope;

  // Check protocol version
  if (!isCompatibleProtocolVersion(envelope.protocolVersion)) {
    log('Rejecting incompatible protocol version:', envelope.protocolVersion);
    return;
  }

  const { type, requestId, payload } = envelope;
  const senderId = sender.id;

  log('Received external message:', type, 'from:', senderId);

  // Route the message
  switch (type) {
    case 'PLUGIN_REGISTER':
      handlePluginRegister(senderId, requestId, payload as { plugin: PluginDescriptor });
      return true;

    case 'PLUGIN_UNREGISTER':
      handlePluginUnregister(senderId, requestId);
      return true;

    case 'PLUGIN_TOOL_RESULT':
      handlePluginToolResult(senderId, requestId, payload as PluginToolResultPayload);
      return true;

    case 'PLUGIN_TOOL_ERROR':
      handlePluginToolError(senderId, requestId, payload as PluginToolErrorPayload);
      return true;

    case 'PLUGIN_PONG':
      handlePluginPong(senderId, requestId, payload as { healthy: boolean });
      return true;

    case 'PLUGIN_TOOLS_LIST_RESULT':
      handlePluginToolsListResult(senderId, requestId, payload as { tools: unknown[] });
      return true;

    default:
      log('Unknown message type:', type);
      return;
  }
}

/**
 * Initialize the plugin router.
 */
export function initializePluginRouter(): void {
  if (isInitialized) {
    log('Router already initialized');
    return;
  }

  // Set up external message listener
  browser.runtime.onMessageExternal.addListener(handleExternalMessage);

  // Start heartbeat
  startHeartbeat();

  isInitialized = true;
  log('Plugin router initialized');
}

/**
 * Shutdown the plugin router.
 */
export function shutdownPluginRouter(): void {
  if (!isInitialized) {
    return;
  }

  // Stop heartbeat
  stopHeartbeat();

  // Clear pending requests
  for (const [requestId, pending] of pendingRequests) {
    clearTimeout(pending.timeoutId);
    pending.reject(new Error('Router shutdown'));
  }
  pendingRequests.clear();

  isInitialized = false;
  log('Plugin router shutdown');
}

/**
 * Get router status.
 */
export function getRouterStatus(): {
  initialized: boolean;
  pendingRequests: number;
  heartbeatActive: boolean;
} {
  return {
    initialized: isInitialized,
    pendingRequests: pendingRequests.size,
    heartbeatActive: heartbeatIntervalId !== null,
  };
}

// =============================================================================
// Testing Utilities
// =============================================================================

/**
 * Clear all pending requests. For testing only.
 * @internal
 */
export function __clearPendingRequests(): void {
  for (const [, pending] of pendingRequests) {
    clearTimeout(pending.timeoutId);
  }
  pendingRequests.clear();
}

/**
 * Get pending requests. For testing only.
 * @internal
 */
export function __getPendingRequests(): Map<string, PendingRequest> {
  return pendingRequests;
}
