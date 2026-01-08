/**
 * Plugin Types Tests
 *
 * Tests for helper functions in the plugin types module.
 */

import { describe, it, expect } from 'vitest';
import {
  PLUGIN_PROTOCOL_VERSION,
  PLUGIN_NAMESPACE,
  createToolNamespace,
  parseToolNamespace,
  generatePluginRequestId,
  createPluginMessage,
  isValidPluginMessage,
  isCompatibleProtocolVersion,
} from '../types';

describe('Plugin Types', () => {
  describe('Constants', () => {
    it('should have correct protocol version', () => {
      expect(PLUGIN_PROTOCOL_VERSION).toBe('harbor-plugin/v1');
    });

    it('should have correct namespace', () => {
      expect(PLUGIN_NAMESPACE).toBe('harbor-plugin');
    });
  });

  describe('createToolNamespace', () => {
    it('should create namespaced tool name with "::" separator', () => {
      const result = createToolNamespace('my-plugin@example.com', 'echo');
      expect(result).toBe('my-plugin@example.com::echo');
    });

    it('should handle tool names with special characters', () => {
      const result = createToolNamespace('plugin', 'tool-with-dashes');
      expect(result).toBe('plugin::tool-with-dashes');
    });

    it('should handle empty strings', () => {
      const result = createToolNamespace('', '');
      expect(result).toBe('::');
    });
  });

  describe('parseToolNamespace', () => {
    it('should parse namespaced tool name correctly', () => {
      const result = parseToolNamespace('my-plugin@example.com::echo');
      expect(result).toEqual({
        pluginId: 'my-plugin@example.com',
        toolName: 'echo',
      });
    });

    it('should return null for non-namespaced names', () => {
      const result = parseToolNamespace('just-a-name');
      expect(result).toBeNull();
    });

    it('should return null for MCP-style names (using /)', () => {
      const result = parseToolNamespace('server/tool');
      expect(result).toBeNull();
    });

    it('should handle tool names with :: in them (first match)', () => {
      const result = parseToolNamespace('plugin::tool::extra');
      expect(result).toEqual({
        pluginId: 'plugin',
        toolName: 'tool::extra',
      });
    });

    it('should handle empty plugin ID', () => {
      const result = parseToolNamespace('::toolName');
      expect(result).toEqual({
        pluginId: '',
        toolName: 'toolName',
      });
    });
  });

  describe('generatePluginRequestId', () => {
    it('should generate a unique request ID', () => {
      const id1 = generatePluginRequestId();
      const id2 = generatePluginRequestId();
      expect(id1).not.toBe(id2);
    });

    it('should start with "plugin-"', () => {
      const id = generatePluginRequestId();
      expect(id.startsWith('plugin-')).toBe(true);
    });

    it('should contain a timestamp component', () => {
      const before = Date.now();
      const id = generatePluginRequestId();
      const after = Date.now();

      // Extract timestamp from ID (format: plugin-TIMESTAMP-RANDOM)
      const parts = id.split('-');
      const timestamp = parseInt(parts[1], 10);

      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('createPluginMessage', () => {
    it('should create a valid message envelope', () => {
      const message = createPluginMessage('PLUGIN_REGISTER', {
        plugin: { extensionId: 'test', name: 'Test', version: '1.0.0', tools: [] },
      });

      expect(message.namespace).toBe(PLUGIN_NAMESPACE);
      expect(message.protocolVersion).toBe(PLUGIN_PROTOCOL_VERSION);
      expect(message.type).toBe('PLUGIN_REGISTER');
      expect(message.requestId).toBeDefined();
      expect(message.timestamp).toBeDefined();
      expect(message.payload).toBeDefined();
    });

    it('should use provided requestId if given', () => {
      const customId = 'custom-request-id-123';
      const message = createPluginMessage('PLUGIN_PING', {}, customId);

      expect(message.requestId).toBe(customId);
    });

    it('should set timestamp to current time', () => {
      const before = Date.now();
      const message = createPluginMessage('PLUGIN_PING', {});
      const after = Date.now();

      expect(message.timestamp).toBeGreaterThanOrEqual(before);
      expect(message.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('isValidPluginMessage', () => {
    it('should return true for valid message', () => {
      const message = createPluginMessage('PLUGIN_PING', {});
      expect(isValidPluginMessage(message)).toBe(true);
    });

    it('should return false for null', () => {
      expect(isValidPluginMessage(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isValidPluginMessage(undefined)).toBe(false);
    });

    it('should return false for non-object', () => {
      expect(isValidPluginMessage('string')).toBe(false);
      expect(isValidPluginMessage(123)).toBe(false);
      expect(isValidPluginMessage(true)).toBe(false);
    });

    it('should return false for wrong namespace', () => {
      const message = {
        namespace: 'wrong-namespace',
        protocolVersion: PLUGIN_PROTOCOL_VERSION,
        type: 'PLUGIN_PING',
        requestId: 'req-1',
        timestamp: Date.now(),
        payload: {},
      };
      expect(isValidPluginMessage(message)).toBe(false);
    });

    it('should return false for missing protocolVersion', () => {
      const message = {
        namespace: PLUGIN_NAMESPACE,
        type: 'PLUGIN_PING',
        requestId: 'req-1',
        timestamp: Date.now(),
        payload: {},
      };
      expect(isValidPluginMessage(message)).toBe(false);
    });

    it('should return false for invalid protocolVersion format', () => {
      const message = {
        namespace: PLUGIN_NAMESPACE,
        protocolVersion: 'invalid-version',
        type: 'PLUGIN_PING',
        requestId: 'req-1',
        timestamp: Date.now(),
        payload: {},
      };
      expect(isValidPluginMessage(message)).toBe(false);
    });

    it('should return false for missing requestId', () => {
      const message = {
        namespace: PLUGIN_NAMESPACE,
        protocolVersion: PLUGIN_PROTOCOL_VERSION,
        type: 'PLUGIN_PING',
        timestamp: Date.now(),
        payload: {},
      };
      expect(isValidPluginMessage(message)).toBe(false);
    });

    it('should return false for missing timestamp', () => {
      const message = {
        namespace: PLUGIN_NAMESPACE,
        protocolVersion: PLUGIN_PROTOCOL_VERSION,
        type: 'PLUGIN_PING',
        requestId: 'req-1',
        payload: {},
      };
      expect(isValidPluginMessage(message)).toBe(false);
    });

    it('should return false for missing payload', () => {
      const message = {
        namespace: PLUGIN_NAMESPACE,
        protocolVersion: PLUGIN_PROTOCOL_VERSION,
        type: 'PLUGIN_PING',
        requestId: 'req-1',
        timestamp: Date.now(),
      };
      expect(isValidPluginMessage(message)).toBe(false);
    });

    it('should accept any harbor-plugin/ protocol version prefix', () => {
      const message = {
        namespace: PLUGIN_NAMESPACE,
        protocolVersion: 'harbor-plugin/v99',
        type: 'PLUGIN_PING',
        requestId: 'req-1',
        timestamp: Date.now(),
        payload: {},
      };
      expect(isValidPluginMessage(message)).toBe(true);
    });
  });

  describe('isCompatibleProtocolVersion', () => {
    it('should return true for exact match', () => {
      expect(isCompatibleProtocolVersion('harbor-plugin/v1')).toBe(true);
    });

    it('should return false for different version', () => {
      expect(isCompatibleProtocolVersion('harbor-plugin/v2')).toBe(false);
    });

    it('should return false for invalid format', () => {
      expect(isCompatibleProtocolVersion('invalid')).toBe(false);
      expect(isCompatibleProtocolVersion('v1')).toBe(false);
      expect(isCompatibleProtocolVersion('')).toBe(false);
    });
  });
});
