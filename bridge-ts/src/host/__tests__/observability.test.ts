/**
 * Observability Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setDebugMode,
  isDebugMode,
  recordToolCall,
  recordServerHealth,
  recordRateLimitEvent,
  recordPermissionEvent,
  getRecentToolCalls,
  getServerHealthStatuses,
  getToolCallStats,
  getObservabilityRateLimitStats,
  clearMetrics,
} from '../index.js';

describe('Observability', () => {
  beforeEach(() => {
    clearMetrics();
    setDebugMode(false);
  });

  describe('debug mode', () => {
    it('should toggle debug mode', () => {
      expect(isDebugMode()).toBe(false);

      setDebugMode(true);
      expect(isDebugMode()).toBe(true);

      setDebugMode(false);
      expect(isDebugMode()).toBe(false);
    });
  });

  describe('recordToolCall', () => {
    it('should record successful tool calls', () => {
      recordToolCall({
        toolName: 'filesystem/read_file',
        serverId: 'filesystem',
        origin: 'https://example.com',
        durationMs: 150,
        success: true,
        timestamp: Date.now(),
      });

      const recent = getRecentToolCalls(10);
      expect(recent).toHaveLength(1);
      expect(recent[0].success).toBe(true);
      expect(recent[0].durationMs).toBe(150);
    });

    it('should record failed tool calls with error code', () => {
      recordToolCall({
        toolName: 'filesystem/read_file',
        serverId: 'filesystem',
        origin: 'https://example.com',
        durationMs: 50,
        success: false,
        errorCode: 'ERR_TOOL_TIMEOUT',
        timestamp: Date.now(),
      });

      const recent = getRecentToolCalls(10);
      expect(recent).toHaveLength(1);
      expect(recent[0].success).toBe(false);
      expect(recent[0].errorCode).toBe('ERR_TOOL_TIMEOUT');
    });

    it('should respect limit in getRecentToolCalls', () => {
      for (let i = 0; i < 10; i++) {
        recordToolCall({
          toolName: `tool${i}`,
          serverId: 'server',
          origin: 'https://example.com',
          durationMs: i * 10,
          success: true,
          timestamp: Date.now(),
        });
      }

      expect(getRecentToolCalls(5)).toHaveLength(5);
      expect(getRecentToolCalls(100)).toHaveLength(10);
    });
  });

  describe('recordServerHealth', () => {
    it('should record and retrieve server health', () => {
      recordServerHealth({
        serverId: 'filesystem',
        state: 'running',
        restartCount: 0,
        lastHealthCheck: Date.now(),
      });

      recordServerHealth({
        serverId: 'github',
        state: 'crashed',
        restartCount: 2,
        lastHealthCheck: Date.now(),
      });

      const statuses = getServerHealthStatuses();
      expect(statuses).toHaveLength(2);

      const filesystem = statuses.find(s => s.serverId === 'filesystem');
      expect(filesystem?.state).toBe('running');

      const github = statuses.find(s => s.serverId === 'github');
      expect(github?.state).toBe('crashed');
      expect(github?.restartCount).toBe(2);
    });

    it('should update existing server health', () => {
      recordServerHealth({
        serverId: 'filesystem',
        state: 'running',
        restartCount: 0,
        lastHealthCheck: Date.now(),
      });

      recordServerHealth({
        serverId: 'filesystem',
        state: 'crashed',
        restartCount: 1,
        lastHealthCheck: Date.now(),
      });

      const statuses = getServerHealthStatuses();
      expect(statuses).toHaveLength(1);
      expect(statuses[0].state).toBe('crashed');
    });
  });

  describe('recordRateLimitEvent', () => {
    it('should record rate limit events', () => {
      recordRateLimitEvent({
        origin: 'https://example.com',
        scope: 'per_origin',
        limitType: 'concurrent',
        current: 2,
        limit: 2,
        blocked: true,
        timestamp: Date.now(),
      });

      const stats = getObservabilityRateLimitStats();
      expect(stats.totalEvents).toBe(1);
      expect(stats.blockedEvents).toBe(1);
      expect(stats.byOrigin['https://example.com'].blocked).toBe(1);
    });
  });

  describe('getToolCallStats', () => {
    it('should calculate aggregated statistics', () => {
      // Add some calls
      recordToolCall({
        toolName: 'server1/tool1',
        serverId: 'server1',
        origin: 'https://example.com',
        durationMs: 100,
        success: true,
        timestamp: Date.now(),
      });

      recordToolCall({
        toolName: 'server1/tool1',
        serverId: 'server1',
        origin: 'https://example.com',
        durationMs: 200,
        success: true,
        timestamp: Date.now(),
      });

      recordToolCall({
        toolName: 'server1/tool1',
        serverId: 'server1',
        origin: 'https://other.com',
        durationMs: 50,
        success: false,
        errorCode: 'ERR_TOOL_FAILED',
        timestamp: Date.now(),
      });

      const stats = getToolCallStats();

      expect(stats.totalCalls).toBe(3);
      expect(stats.successfulCalls).toBe(2);
      expect(stats.failedCalls).toBe(1);
      expect(stats.avgDurationMs).toBe(117); // (100+200+50)/3 rounded

      expect(stats.callsByTool['server1/tool1'].count).toBe(3);
      expect(stats.callsByTool['server1/tool1'].successRate).toBeCloseTo(0.667, 2);

      expect(stats.callsByOrigin['https://example.com'].count).toBe(2);
      expect(stats.callsByOrigin['https://example.com'].successRate).toBe(1);
      expect(stats.callsByOrigin['https://other.com'].successRate).toBe(0);
    });
  });

  describe('clearMetrics', () => {
    it('should clear all metrics', () => {
      recordToolCall({
        toolName: 'test',
        serverId: 'server',
        origin: 'origin',
        durationMs: 100,
        success: true,
        timestamp: Date.now(),
      });

      recordServerHealth({
        serverId: 'server',
        state: 'running',
        restartCount: 0,
        lastHealthCheck: Date.now(),
      });

      clearMetrics();

      expect(getRecentToolCalls()).toHaveLength(0);
      expect(getServerHealthStatuses()).toHaveLength(0);
      expect(getToolCallStats().totalCalls).toBe(0);
    });
  });
});

