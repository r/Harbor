/**
 * Harbor Plugin System - Type Definitions
 *
 * Defines the protocol for extension-based plugins that provide tools to Harbor.
 * Protocol version: harbor-plugin/v1
 */

// =============================================================================
// Protocol Constants
// =============================================================================

export const PLUGIN_PROTOCOL_VERSION = 'harbor-plugin/v1';
export const PLUGIN_NAMESPACE = 'harbor-plugin';

// Default timeouts (in milliseconds)
export const PLUGIN_REGISTER_TIMEOUT_MS = 5000;
export const PLUGIN_TOOL_CALL_TIMEOUT_MS = 30000;
export const PLUGIN_PING_TIMEOUT_MS = 2000;
export const PLUGIN_HEARTBEAT_INTERVAL_MS = 60000;

// =============================================================================
// Message Envelope
// =============================================================================

/**
 * Base envelope for all plugin protocol messages.
 */
export interface PluginMessageEnvelope<T extends PluginMessageType = PluginMessageType> {
  /** Namespace identifier for Harbor plugin protocol */
  namespace: typeof PLUGIN_NAMESPACE;
  /** Protocol version (e.g., 'harbor-plugin/v1') */
  protocolVersion: typeof PLUGIN_PROTOCOL_VERSION;
  /** Message type */
  type: T;
  /** Unique request ID for correlation */
  requestId: string;
  /** Unix timestamp when message was created */
  timestamp: number;
  /** Message payload (type depends on message type) */
  payload: PluginMessagePayload<T>;
}

// =============================================================================
// Message Types
// =============================================================================

export type PluginMessageType =
  // Registration
  | 'PLUGIN_REGISTER'
  | 'PLUGIN_REGISTER_ACK'
  | 'PLUGIN_UNREGISTER'
  | 'PLUGIN_UNREGISTER_ACK'
  // Tool operations
  | 'PLUGIN_TOOLS_LIST'
  | 'PLUGIN_TOOLS_LIST_RESULT'
  | 'PLUGIN_TOOL_CALL'
  | 'PLUGIN_TOOL_RESULT'
  | 'PLUGIN_TOOL_ERROR'
  // Health/keepalive
  | 'PLUGIN_PING'
  | 'PLUGIN_PONG'
  // Hub notifications to plugins
  | 'PLUGIN_DISABLED'
  | 'PLUGIN_ENABLED';

// =============================================================================
// Tool Definition (Plugin-provided)
// =============================================================================

/**
 * Tool definition provided by a plugin.
 * Follows MCP tool schema with additional UI hints.
 */
export interface PluginToolDefinition {
  /** Tool name (unique within the plugin, e.g., 'echo') */
  name: string;
  /** Human-readable title */
  title: string;
  /** Description of what the tool does */
  description: string;
  /** JSON Schema for input parameters */
  inputSchema: JsonSchema;
  /** JSON Schema for output (optional) */
  outputSchema?: JsonSchema;
  /** UI hints for rendering (optional) */
  uiHints?: ToolUiHints;
}

/**
 * JSON Schema type (subset used for tool schemas).
 */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
}

/**
 * UI hints for tool rendering.
 */
export interface ToolUiHints {
  /** Icon identifier or URL */
  icon?: string;
  /** Category for grouping */
  category?: string;
  /** Whether this tool may have side effects */
  dangerous?: boolean;
  /** Estimated execution time category */
  speed?: 'instant' | 'fast' | 'slow';
}

// =============================================================================
// Plugin Descriptor
// =============================================================================

/**
 * Plugin metadata sent during registration.
 */
export interface PluginDescriptor {
  /** Firefox extension ID (must match manifest) */
  extensionId: string;
  /** Human-readable plugin name */
  name: string;
  /** Plugin version (semver) */
  version: string;
  /** Plugin description */
  description?: string;
  /** Plugin author */
  author?: string;
  /** Homepage or documentation URL */
  homepage?: string;
  /** Icon URL or data URI */
  icon?: string;
  /** Tools provided by this plugin */
  tools: PluginToolDefinition[];
}

// =============================================================================
// Message Payloads
// =============================================================================

// Helper type for payload mapping
export type PluginMessagePayload<T extends PluginMessageType> =
  T extends 'PLUGIN_REGISTER' ? PluginRegisterPayload :
  T extends 'PLUGIN_REGISTER_ACK' ? PluginRegisterAckPayload :
  T extends 'PLUGIN_UNREGISTER' ? PluginUnregisterPayload :
  T extends 'PLUGIN_UNREGISTER_ACK' ? PluginUnregisterAckPayload :
  T extends 'PLUGIN_TOOLS_LIST' ? PluginToolsListPayload :
  T extends 'PLUGIN_TOOLS_LIST_RESULT' ? PluginToolsListResultPayload :
  T extends 'PLUGIN_TOOL_CALL' ? PluginToolCallPayload :
  T extends 'PLUGIN_TOOL_RESULT' ? PluginToolResultPayload :
  T extends 'PLUGIN_TOOL_ERROR' ? PluginToolErrorPayload :
  T extends 'PLUGIN_PING' ? PluginPingPayload :
  T extends 'PLUGIN_PONG' ? PluginPongPayload :
  T extends 'PLUGIN_DISABLED' ? PluginDisabledPayload :
  T extends 'PLUGIN_ENABLED' ? PluginEnabledPayload :
  never;

// Registration payloads

export interface PluginRegisterPayload {
  plugin: PluginDescriptor;
}

export interface PluginRegisterAckPayload {
  success: boolean;
  /** Error message if registration failed */
  error?: string;
  /** Assigned namespace prefix for tools */
  toolNamespace?: string;
}

export interface PluginUnregisterPayload {
  /** Reason for unregistering */
  reason?: string;
}

export interface PluginUnregisterAckPayload {
  success: boolean;
}

// Tool operation payloads

export interface PluginToolsListPayload {
  // Empty - hub requests tool list from plugin
}

export interface PluginToolsListResultPayload {
  tools: PluginToolDefinition[];
}

export interface PluginToolCallPayload {
  /** Tool name (without namespace prefix) */
  toolName: string;
  /** Arguments for the tool */
  arguments: Record<string, unknown>;
  /** Calling origin (for plugin's information) */
  callingOrigin?: string;
}

export interface PluginToolResultPayload {
  /** Result data from the tool */
  result: unknown;
  /** Execution time in milliseconds */
  executionTimeMs?: number;
}

export interface PluginToolErrorPayload {
  /** Error code */
  code: PluginErrorCode;
  /** Human-readable error message */
  message: string;
  /** Additional error details */
  details?: unknown;
}

// Health/keepalive payloads

export interface PluginPingPayload {
  // Empty
}

export interface PluginPongPayload {
  /** Plugin uptime in seconds */
  uptime?: number;
  /** Whether plugin is healthy */
  healthy: boolean;
}

// Hub notification payloads

export interface PluginDisabledPayload {
  /** Reason for disabling */
  reason?: string;
}

export interface PluginEnabledPayload {
  // Empty
}

// =============================================================================
// Error Codes
// =============================================================================

export type PluginErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'INVALID_ARGUMENTS'
  | 'EXECUTION_FAILED'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR'
  | 'NOT_REGISTERED'
  | 'ALREADY_REGISTERED'
  | 'PLUGIN_NOT_ALLOWED'
  | 'PROTOCOL_VERSION_MISMATCH';

// =============================================================================
// Registry State
// =============================================================================

/**
 * Status of a registered plugin.
 */
export type PluginStatus = 'active' | 'disabled' | 'unreachable' | 'error';

/**
 * Internal registry entry for a plugin.
 */
export interface PluginRegistryEntry {
  /** Plugin descriptor from registration */
  descriptor: PluginDescriptor;
  /** Current status */
  status: PluginStatus;
  /** Last seen timestamp (from pong or any successful message) */
  lastSeen: number;
  /** Registration timestamp */
  registeredAt: number;
  /** Last error message if status is 'error' */
  lastError?: string;
  /** Number of consecutive failed pings */
  failedPings: number;
}

/**
 * Stored registry format (persisted to storage).
 */
export interface StoredPluginRegistry {
  /** Version for migration */
  version: 1;
  /** Map of extensionId -> registry entry */
  plugins: Record<string, PluginRegistryEntry>;
  /** Allowlist of plugin extension IDs (empty = allow all) */
  allowlist: string[];
  /** When the registry was last updated */
  updatedAt: number;
}

// =============================================================================
// Hub Configuration
// =============================================================================

/**
 * Configuration for the plugin hub.
 */
export interface PluginHubConfig {
  /** Extension IDs allowed to register as plugins (empty = allow all) */
  allowedPluginIds: string[];
  /** Whether to auto-start registered plugins on hub startup */
  autoStartPlugins: boolean;
  /** Timeout for tool calls in milliseconds */
  toolCallTimeoutMs: number;
  /** Heartbeat interval for plugin health checks */
  heartbeatIntervalMs: number;
}

// =============================================================================
// Aggregated Tool (for website API)
// =============================================================================

/**
 * Tool as exposed to websites via window.agent.tools.
 * Namespaced with plugin ID prefix.
 */
export interface AggregatedPluginTool {
  /** Namespaced tool name: <pluginId>::<toolName> */
  name: string;
  /** Human-readable title */
  title: string;
  /** Description */
  description: string;
  /** JSON Schema for input */
  inputSchema: JsonSchema;
  /** Output schema if provided */
  outputSchema?: JsonSchema;
  /** Source plugin ID */
  pluginId: string;
  /** Original tool name (without namespace) */
  originalName: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create a namespaced tool name.
 */
export function createToolNamespace(pluginId: string, toolName: string): string {
  return `${pluginId}::${toolName}`;
}

/**
 * Parse a namespaced tool name.
 */
export function parseToolNamespace(namespacedName: string): { pluginId: string; toolName: string } | null {
  const separatorIndex = namespacedName.indexOf('::');
  if (separatorIndex === -1) {
    return null;
  }
  return {
    pluginId: namespacedName.slice(0, separatorIndex),
    toolName: namespacedName.slice(separatorIndex + 2),
  };
}

/**
 * Generate a unique request ID.
 */
export function generatePluginRequestId(): string {
  return `plugin-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Create a plugin message envelope.
 */
export function createPluginMessage<T extends PluginMessageType>(
  type: T,
  payload: PluginMessagePayload<T>,
  requestId?: string
): PluginMessageEnvelope<T> {
  return {
    namespace: PLUGIN_NAMESPACE,
    protocolVersion: PLUGIN_PROTOCOL_VERSION,
    type,
    requestId: requestId ?? generatePluginRequestId(),
    timestamp: Date.now(),
    payload,
  };
}

/**
 * Validate a plugin message envelope.
 */
export function isValidPluginMessage(message: unknown): message is PluginMessageEnvelope {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const msg = message as Record<string, unknown>;

  return (
    msg.namespace === PLUGIN_NAMESPACE &&
    typeof msg.protocolVersion === 'string' &&
    msg.protocolVersion.startsWith('harbor-plugin/') &&
    typeof msg.type === 'string' &&
    typeof msg.requestId === 'string' &&
    typeof msg.timestamp === 'number' &&
    msg.payload !== undefined
  );
}

/**
 * Check protocol version compatibility.
 */
export function isCompatibleProtocolVersion(version: string): boolean {
  // For v1, we only accept exact match
  // Future versions can implement proper semver comparison
  return version === PLUGIN_PROTOCOL_VERSION;
}
