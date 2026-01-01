/**
 * Rate Limiter
 * 
 * Enforces rate limits and budgets for tool calls.
 * Tracks per-run and per-origin limits.
 */

import { log } from '../native-messaging.js';
import {
  RateLimitConfig,
  DEFAULT_RATE_LIMITS,
  RunBudget,
  Origin,
  ApiError,
  ErrorCode,
  createError,
} from './types.js';
import { randomUUID } from 'node:crypto';

/**
 * Active run budgets keyed by runId.
 */
const runBudgets: Map<string, RunBudget> = new Map();

/**
 * Active calls per origin.
 */
const originActiveCalls: Map<Origin, number> = new Map();

/**
 * Rate limit configuration (can be updated).
 */
let config: RateLimitConfig = { ...DEFAULT_RATE_LIMITS };

/**
 * Update rate limit configuration.
 */
export function setRateLimits(newConfig: Partial<RateLimitConfig>): void {
  config = { ...config, ...newConfig };
  log(`[RateLimiter] Config updated: ${JSON.stringify(config)}`);
}

/**
 * Get current rate limit configuration.
 */
export function getRateLimits(): RateLimitConfig {
  return { ...config };
}

/**
 * Create a new run with a budget.
 */
export function createRun(
  origin: Origin,
  maxCalls?: number
): RunBudget {
  const runId = randomUUID();
  
  const budget: RunBudget = {
    runId,
    origin,
    maxCalls: maxCalls ?? config.maxCallsPerRun,
    callsMade: 0,
    activeCalls: 0,
    startedAt: Date.now(),
  };

  runBudgets.set(runId, budget);

  log(`[RateLimiter] Created run ${runId} for ${origin} (max: ${budget.maxCalls} calls)`);

  return budget;
}

/**
 * End a run and clean up.
 */
export function endRun(runId: string): RunBudget | undefined {
  const budget = runBudgets.get(runId);
  if (budget) {
    runBudgets.delete(runId);
    log(`[RateLimiter] Ended run ${runId} (${budget.callsMade} calls made)`);
  }
  return budget;
}

/**
 * Get a run budget by ID.
 */
export function getRunBudget(runId: string): RunBudget | undefined {
  return runBudgets.get(runId);
}

/**
 * Check if a tool call is allowed under current limits.
 * Does not consume budget - call acquireCallSlot() to do that.
 */
export function checkCallAllowed(
  origin: Origin,
  runId?: string
): { allowed: boolean; error?: ApiError } {
  // Check per-origin concurrent limit
  const currentOriginCalls = originActiveCalls.get(origin) ?? 0;
  if (currentOriginCalls >= config.maxConcurrentPerOrigin) {
    return {
      allowed: false,
      error: createError(
        ErrorCode.RATE_LIMITED,
        `Too many concurrent calls from this origin (max: ${config.maxConcurrentPerOrigin})`,
        { currentCalls: currentOriginCalls, limit: config.maxConcurrentPerOrigin }
      ),
    };
  }

  // Check run budget if provided
  if (runId) {
    const budget = runBudgets.get(runId);
    if (!budget) {
      // Unknown run ID - could be a stale reference, allow the call
      log(`[RateLimiter] Unknown run ID ${runId}, allowing call`);
    } else if (budget.callsMade >= budget.maxCalls) {
      return {
        allowed: false,
        error: createError(
          ErrorCode.BUDGET_EXCEEDED,
          `Budget exceeded for this run (max: ${budget.maxCalls} calls)`,
          { callsMade: budget.callsMade, limit: budget.maxCalls }
        ),
      };
    }
  }

  return { allowed: true };
}

/**
 * Acquire a call slot, incrementing counters.
 * Returns a release function to call when the call completes.
 */
export function acquireCallSlot(
  origin: Origin,
  runId?: string
): { acquired: boolean; release: () => void; error?: ApiError } {
  // First check if allowed
  const check = checkCallAllowed(origin, runId);
  if (!check.allowed) {
    return { acquired: false, release: () => {}, error: check.error };
  }

  // Increment origin active calls
  const currentOriginCalls = originActiveCalls.get(origin) ?? 0;
  originActiveCalls.set(origin, currentOriginCalls + 1);

  // Increment run counters if applicable
  if (runId) {
    const budget = runBudgets.get(runId);
    if (budget) {
      budget.callsMade++;
      budget.activeCalls++;
    }
  }

  // Create release function
  const release = () => {
    const calls = originActiveCalls.get(origin);
    if (calls && calls > 0) {
      originActiveCalls.set(origin, calls - 1);
    }

    if (runId) {
      const budget = runBudgets.get(runId);
      if (budget && budget.activeCalls > 0) {
        budget.activeCalls--;
      }
    }
  };

  return { acquired: true, release };
}

/**
 * Get the default timeout for a tool.
 */
export function getDefaultTimeout(): number {
  return config.defaultTimeoutMs;
}

/**
 * Create a timeout promise.
 */
export function createTimeoutPromise<T>(
  promise: Promise<T>,
  timeoutMs: number,
  toolName: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(createError(
        ErrorCode.TOOL_TIMEOUT,
        `Tool "${toolName}" timed out after ${timeoutMs}ms`,
        { toolName, timeoutMs }
      ));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
  });
}

/**
 * Get statistics about current rate limiting state.
 */
export function getRateLimitStats(): {
  activeRuns: number;
  originStats: Record<Origin, { activeCalls: number }>;
} {
  const originStats: Record<Origin, { activeCalls: number }> = {};

  for (const [origin, calls] of originActiveCalls) {
    originStats[origin] = { activeCalls: calls };
  }

  return {
    activeRuns: runBudgets.size,
    originStats,
  };
}

/**
 * Clean up stale runs (older than maxAge).
 */
export function cleanupStaleRuns(maxAgeMs: number = 60 * 60 * 1000): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [runId, budget] of runBudgets) {
    if (now - budget.startedAt > maxAgeMs) {
      runBudgets.delete(runId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    log(`[RateLimiter] Cleaned up ${cleaned} stale runs`);
  }

  return cleaned;
}

