/**
 * MCP Host Module
 * 
 * Provides the MCP execution environment for the Firefox extension.
 * Manages server connections, tool discovery, invocation, and policy.
 */

// Types
export type {
  Origin,
  ProfileId,
  PermissionGrant,
  PermissionKey,
  ApiError,
  ToolDescriptor,
  ToolResult,
  ToolError,
  ToolCallResult,
  RateLimitConfig,
  RunBudget,
  ServerConfig,
  ServerStatus,
  RunEvent,
  StatusEvent,
  ToolCallEvent,
  ToolResultEvent,
  FinalEvent,
  ErrorEvent,
  ListToolsOptions,
  CallToolOptions,
  RunAgentOptions,
} from './types.js';

export {
  GrantType,
  PermissionScope,
  ErrorCode,
  ServerState,
  DEFAULT_RATE_LIMITS,
  createError,
} from './types.js';

// Permissions
export {
  loadPermissions,
  grantPermission,
  revokePermission,
  checkPermission,
  isToolAllowed,
  getPermissions,
  expireTabGrants,
  clearTransientPermissions,
  listOriginsWithPermissions,
} from './permissions.js';

// Tool Registry
export {
  namespaceTool,
  parseNamespacedTool,
  registerServerTools,
  unregisterServerTools,
  getTool,
  getAllTools,
  listTools,
  resolveTool,
  getToolStats,
  clearAllTools,
} from './tool-registry.js';

// Rate Limiter
export {
  setRateLimits,
  getRateLimits,
  createRun,
  endRun,
  getRunBudget,
  checkCallAllowed,
  acquireCallSlot,
  getDefaultTimeout,
  createTimeoutPromise,
  getRateLimitStats,
  cleanupStaleRuns,
} from './rate-limiter.js';

// Host
export {
  McpHost,
  getMcpHost,
} from './host.js';

// Observability
export type {
  ToolCallMetric,
  ServerHealthMetric,
  RateLimitMetric,
  PermissionMetric,
} from './observability.js';

export {
  setDebugMode,
  isDebugMode,
  recordToolCall,
  recordServerHealth,
  recordRateLimitEvent,
  recordPermissionEvent,
  getRecentToolCalls,
  getServerHealthStatuses,
  getToolCallStats,
  getRateLimitStats as getObservabilityRateLimitStats,
  clearMetrics,
} from './observability.js';

