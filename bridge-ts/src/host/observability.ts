/**
 * Observability Module
 * 
 * Provides logging and metrics for the MCP Host without exposing payload content.
 * Follows the spec requirement: logs operational metrics without tool args/results.
 */

import { log } from '../native-messaging.js';

/**
 * Metric entry for a tool call.
 */
export interface ToolCallMetric {
  /** Namespaced tool name (serverId/toolName) */
  toolName: string;
  /** Server that handled the call */
  serverId: string;
  /** Origin that made the call */
  origin: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether the call succeeded */
  success: boolean;
  /** Error code if failed */
  errorCode?: string;
  /** Timestamp of the call */
  timestamp: number;
}

/**
 * Server health metric.
 */
export interface ServerHealthMetric {
  serverId: string;
  state: 'running' | 'stopped' | 'crashed' | 'restarting';
  restartCount: number;
  lastHealthCheck: number;
}

/**
 * Rate limit metric.
 */
export interface RateLimitMetric {
  origin: string;
  scope: 'per_origin' | 'per_run';
  limitType: 'concurrent' | 'budget';
  current: number;
  limit: number;
  blocked: boolean;
  timestamp: number;
}

/**
 * Permission metric.
 */
export interface PermissionMetric {
  origin: string;
  scope: string;
  action: 'check' | 'grant' | 'revoke' | 'expire';
  result: 'allowed' | 'denied' | 'expired';
  timestamp: number;
}

/**
 * Metrics storage (in-memory, last N entries).
 */
const MAX_METRICS = 1000;
const toolCallMetrics: ToolCallMetric[] = [];
const serverHealthMetrics: Map<string, ServerHealthMetric> = new Map();
const rateLimitMetrics: RateLimitMetric[] = [];
const permissionMetrics: PermissionMetric[] = [];

/**
 * Debug mode flag - when enabled, logs include more detail.
 */
let debugMode = false;

/**
 * Enable or disable debug mode.
 * In debug mode, additional details may be logged (use with caution).
 */
export function setDebugMode(enabled: boolean): void {
  debugMode = enabled;
  log(`[Observability] Debug mode ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * Check if debug mode is enabled.
 */
export function isDebugMode(): boolean {
  return debugMode;
}

/**
 * Record a tool call metric.
 */
export function recordToolCall(metric: ToolCallMetric): void {
  // Add to metrics array
  toolCallMetrics.push(metric);
  if (toolCallMetrics.length > MAX_METRICS) {
    toolCallMetrics.shift();
  }

  // Log without payload
  const status = metric.success ? 'success' : `failed:${metric.errorCode}`;
  log(
    `[Metrics] tool_call: ${metric.toolName} ` +
    `origin=${metric.origin} ` +
    `duration=${metric.durationMs}ms ` +
    `status=${status}`
  );
}

/**
 * Record server health status.
 */
export function recordServerHealth(metric: ServerHealthMetric): void {
  serverHealthMetrics.set(metric.serverId, metric);

  log(
    `[Metrics] server_health: ${metric.serverId} ` +
    `state=${metric.state} ` +
    `restarts=${metric.restartCount}`
  );
}

/**
 * Record a rate limit event.
 */
export function recordRateLimitEvent(metric: RateLimitMetric): void {
  rateLimitMetrics.push(metric);
  if (rateLimitMetrics.length > MAX_METRICS) {
    rateLimitMetrics.shift();
  }

  if (metric.blocked) {
    log(
      `[Metrics] rate_limit: ${metric.origin} ` +
      `scope=${metric.scope} ` +
      `type=${metric.limitType} ` +
      `current=${metric.current}/${metric.limit} ` +
      `BLOCKED`
    );
  }
}

/**
 * Record a permission event.
 */
export function recordPermissionEvent(metric: PermissionMetric): void {
  permissionMetrics.push(metric);
  if (permissionMetrics.length > MAX_METRICS) {
    permissionMetrics.shift();
  }

  log(
    `[Metrics] permission: ${metric.origin} ` +
    `scope=${metric.scope} ` +
    `action=${metric.action} ` +
    `result=${metric.result}`
  );
}

/**
 * Get recent tool call metrics.
 */
export function getRecentToolCalls(limit: number = 100): ToolCallMetric[] {
  return toolCallMetrics.slice(-limit);
}

/**
 * Get current server health statuses.
 */
export function getServerHealthStatuses(): ServerHealthMetric[] {
  return Array.from(serverHealthMetrics.values());
}

/**
 * Get aggregated tool call statistics.
 */
export function getToolCallStats(): {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  avgDurationMs: number;
  callsByTool: Record<string, { count: number; avgDurationMs: number; successRate: number }>;
  callsByOrigin: Record<string, { count: number; successRate: number }>;
} {
  const callsByTool: Record<string, { total: number; success: number; totalDuration: number }> = {};
  const callsByOrigin: Record<string, { total: number; success: number }> = {};

  let totalDuration = 0;
  let successfulCalls = 0;

  for (const metric of toolCallMetrics) {
    // Aggregate by tool
    if (!callsByTool[metric.toolName]) {
      callsByTool[metric.toolName] = { total: 0, success: 0, totalDuration: 0 };
    }
    callsByTool[metric.toolName].total++;
    callsByTool[metric.toolName].totalDuration += metric.durationMs;
    if (metric.success) {
      callsByTool[metric.toolName].success++;
      successfulCalls++;
    }

    // Aggregate by origin
    if (!callsByOrigin[metric.origin]) {
      callsByOrigin[metric.origin] = { total: 0, success: 0 };
    }
    callsByOrigin[metric.origin].total++;
    if (metric.success) {
      callsByOrigin[metric.origin].success++;
    }

    totalDuration += metric.durationMs;
  }

  // Transform to output format
  const toolStats: Record<string, { count: number; avgDurationMs: number; successRate: number }> = {};
  for (const [tool, stats] of Object.entries(callsByTool)) {
    toolStats[tool] = {
      count: stats.total,
      avgDurationMs: Math.round(stats.totalDuration / stats.total),
      successRate: stats.total > 0 ? stats.success / stats.total : 0,
    };
  }

  const originStats: Record<string, { count: number; successRate: number }> = {};
  for (const [origin, stats] of Object.entries(callsByOrigin)) {
    originStats[origin] = {
      count: stats.total,
      successRate: stats.total > 0 ? stats.success / stats.total : 0,
    };
  }

  return {
    totalCalls: toolCallMetrics.length,
    successfulCalls,
    failedCalls: toolCallMetrics.length - successfulCalls,
    avgDurationMs: toolCallMetrics.length > 0 ? Math.round(totalDuration / toolCallMetrics.length) : 0,
    callsByTool: toolStats,
    callsByOrigin: originStats,
  };
}

/**
 * Get rate limit statistics.
 */
export function getRateLimitStats(): {
  totalEvents: number;
  blockedEvents: number;
  byOrigin: Record<string, { total: number; blocked: number }>;
} {
  const byOrigin: Record<string, { total: number; blocked: number }> = {};
  let blockedEvents = 0;

  for (const metric of rateLimitMetrics) {
    if (!byOrigin[metric.origin]) {
      byOrigin[metric.origin] = { total: 0, blocked: 0 };
    }
    byOrigin[metric.origin].total++;
    if (metric.blocked) {
      byOrigin[metric.origin].blocked++;
      blockedEvents++;
    }
  }

  return {
    totalEvents: rateLimitMetrics.length,
    blockedEvents,
    byOrigin,
  };
}

/**
 * Clear all metrics (for testing).
 */
export function clearMetrics(): void {
  toolCallMetrics.length = 0;
  serverHealthMetrics.clear();
  rateLimitMetrics.length = 0;
  permissionMetrics.length = 0;
  log('[Observability] Metrics cleared');
}

