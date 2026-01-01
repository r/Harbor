/**
 * Rate Limiter Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
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
} from '../rate-limiter.js';
import { DEFAULT_RATE_LIMITS } from '../types.js';

describe('Rate Limiter', () => {
  // Use unique origins per test to avoid state pollution
  let TEST_ORIGIN: string;

  beforeEach(() => {
    // Reset to defaults
    setRateLimits(DEFAULT_RATE_LIMITS);
    // Clean up any existing runs
    cleanupStaleRuns(0);
    // Use unique origin per test
    TEST_ORIGIN = `https://test-${Date.now()}-${Math.random().toString(36).slice(2)}.com`;
  });

  describe('setRateLimits / getRateLimits', () => {
    it('should update rate limit config', () => {
      setRateLimits({ maxCallsPerRun: 10 });

      const config = getRateLimits();
      expect(config.maxCallsPerRun).toBe(10);
      expect(config.maxConcurrentPerOrigin).toBe(DEFAULT_RATE_LIMITS.maxConcurrentPerOrigin);
    });
  });

  describe('createRun / endRun', () => {
    it('should create a run with default budget', () => {
      const budget = createRun(TEST_ORIGIN);

      expect(budget.runId).toBeDefined();
      expect(budget.origin).toBe(TEST_ORIGIN);
      expect(budget.maxCalls).toBe(DEFAULT_RATE_LIMITS.maxCallsPerRun);
      expect(budget.callsMade).toBe(0);
      expect(budget.activeCalls).toBe(0);
    });

    it('should create a run with custom budget', () => {
      const budget = createRun(TEST_ORIGIN, 3);

      expect(budget.maxCalls).toBe(3);
    });

    it('should end and return final budget', () => {
      const budget = createRun(TEST_ORIGIN);
      const runId = budget.runId;

      acquireCallSlot(TEST_ORIGIN, runId);

      const finalBudget = endRun(runId);
      expect(finalBudget).toBeDefined();
      expect(finalBudget?.callsMade).toBe(1);
    });

    it('should return undefined for unknown run', () => {
      const result = endRun('unknown-run-id');
      expect(result).toBeUndefined();
    });
  });

  describe('getRunBudget', () => {
    it('should return budget for active run', () => {
      const budget = createRun(TEST_ORIGIN);

      const retrieved = getRunBudget(budget.runId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.runId).toBe(budget.runId);
    });

    it('should return undefined for unknown run', () => {
      const result = getRunBudget('unknown');
      expect(result).toBeUndefined();
    });
  });

  describe('checkCallAllowed', () => {
    it('should allow calls within limits', () => {
      const result = checkCallAllowed(TEST_ORIGIN);
      expect(result.allowed).toBe(true);
    });

    it('should block when concurrent limit reached', () => {
      setRateLimits({ maxConcurrentPerOrigin: 1 });

      // Acquire first slot
      const slot1 = acquireCallSlot(TEST_ORIGIN);
      expect(slot1.acquired).toBe(true);

      // Check should fail
      const result = checkCallAllowed(TEST_ORIGIN);
      expect(result.allowed).toBe(false);
      expect(result.error?.code).toBe('ERR_RATE_LIMITED');

      // Release slot
      slot1.release();

      // Now should be allowed
      const result2 = checkCallAllowed(TEST_ORIGIN);
      expect(result2.allowed).toBe(true);
    });

    it('should block when budget exceeded', () => {
      const budget = createRun(TEST_ORIGIN, 2);

      // Make 2 calls
      acquireCallSlot(TEST_ORIGIN, budget.runId).release();
      acquireCallSlot(TEST_ORIGIN, budget.runId).release();

      // 3rd should be blocked
      const result = checkCallAllowed(TEST_ORIGIN, budget.runId);
      expect(result.allowed).toBe(false);
      expect(result.error?.code).toBe('ERR_BUDGET_EXCEEDED');
    });
  });

  describe('acquireCallSlot', () => {
    it('should acquire and release slots correctly', () => {
      const slot = acquireCallSlot(TEST_ORIGIN);
      expect(slot.acquired).toBe(true);

      const stats = getRateLimitStats();
      expect(stats.originStats[TEST_ORIGIN]?.activeCalls).toBe(1);

      slot.release();

      const stats2 = getRateLimitStats();
      expect(stats2.originStats[TEST_ORIGIN]?.activeCalls).toBe(0);
    });

    it('should increment run counters', () => {
      const budget = createRun(TEST_ORIGIN);

      const slot = acquireCallSlot(TEST_ORIGIN, budget.runId);
      expect(slot.acquired).toBe(true);

      const updated = getRunBudget(budget.runId);
      expect(updated?.callsMade).toBe(1);
      expect(updated?.activeCalls).toBe(1);

      slot.release();

      const final = getRunBudget(budget.runId);
      expect(final?.activeCalls).toBe(0);
      expect(final?.callsMade).toBe(1); // Still 1, release doesn't decrement this
    });

    it('should return error when blocked', () => {
      setRateLimits({ maxConcurrentPerOrigin: 0 });

      const result = acquireCallSlot(TEST_ORIGIN);
      expect(result.acquired).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('getDefaultTimeout', () => {
    it('should return configured timeout', () => {
      expect(getDefaultTimeout()).toBe(DEFAULT_RATE_LIMITS.defaultTimeoutMs);

      setRateLimits({ defaultTimeoutMs: 60000 });
      expect(getDefaultTimeout()).toBe(60000);
    });
  });

  describe('createTimeoutPromise', () => {
    it('should resolve if promise completes in time', async () => {
      const promise = Promise.resolve('success');
      const result = await createTimeoutPromise(promise, 1000, 'test-tool');
      expect(result).toBe('success');
    });

    it('should reject with ERR_TOOL_TIMEOUT if promise times out', async () => {
      const slowPromise = new Promise(resolve => setTimeout(() => resolve('late'), 1000));

      await expect(
        createTimeoutPromise(slowPromise, 50, 'test-tool')
      ).rejects.toMatchObject({
        code: 'ERR_TOOL_TIMEOUT',
      });
    });

    it('should propagate original error', async () => {
      const failingPromise = Promise.reject(new Error('original error'));

      await expect(
        createTimeoutPromise(failingPromise, 1000, 'test-tool')
      ).rejects.toThrow('original error');
    });
  });

  describe('getRateLimitStats', () => {
    it('should track active runs and origin stats', () => {
      createRun(TEST_ORIGIN);
      createRun('https://other.com');
      acquireCallSlot(TEST_ORIGIN);

      const stats = getRateLimitStats();
      expect(stats.activeRuns).toBe(2);
      expect(stats.originStats[TEST_ORIGIN]?.activeCalls).toBe(1);
    });
  });

  describe('cleanupStaleRuns', () => {
    it('should remove old runs', async () => {
      // First clean up any existing stale runs
      cleanupStaleRuns(0);
      
      // Now create a new run
      createRun(TEST_ORIGIN);

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 60));

      // Clean up runs older than 10ms
      const cleaned = cleanupStaleRuns(10);
      expect(cleaned).toBeGreaterThanOrEqual(1);

      const stats = getRateLimitStats();
      expect(stats.activeRuns).toBe(0);
    });
  });
});

