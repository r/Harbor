/**
 * Chat Orchestrator Tests
 * 
 * Tests for the text-based tool call parsing functionality.
 * This is critical for supporting LLMs (like Ollama) that output
 * tool calls as JSON text instead of using proper tool_calls format.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatOrchestrator } from '../orchestrator.js';

// Mock the dependencies
vi.mock('../../llm/manager.js', () => ({
  getLLMManager: () => ({
    getActiveId: () => 'test-llm',
    chat: vi.fn(),
  }),
}));

vi.mock('../../mcp/manager.js', () => ({
  getMcpClientManager: () => ({
    getConnectedServers: () => [],
    getToolsForServer: () => [],
    callTool: vi.fn(),
  }),
}));

vi.mock('../../native-messaging.js', () => ({
  log: vi.fn(),
}));

describe('ChatOrchestrator', () => {
  let orchestrator: ChatOrchestrator;

  beforeEach(() => {
    orchestrator = new ChatOrchestrator();
  });

  describe('Text-Based Tool Call Parsing', () => {
    // Access the private method for testing
    const parseToolCall = (orchestrator: ChatOrchestrator, content: string, toolMapping: Record<string, string>) => {
      // @ts-expect-error - accessing private method for testing
      return orchestrator.parseToolCallFromText(content, toolMapping);
    };

    describe('Format 1: {"name": "tool_name", "parameters": {...}}', () => {
      it('should parse standard JSON format with parameters', () => {
        const content = `I'll help you get the time. {"name": "curated-time__get_current_time", "parameters": {"timezone": "UTC"}}`;
        const toolMapping = { 'curated-time__get_current_time': 'curated-time' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.name).toBe('curated-time__get_current_time');
        expect(result?.arguments).toEqual({ timezone: 'UTC' });
      });

      it('should parse JSON format with arguments key', () => {
        const content = `{"name": "curated-time__get_current_time", "arguments": {"timezone": "America/New_York"}}`;
        const toolMapping = { 'curated-time__get_current_time': 'curated-time' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.name).toBe('curated-time__get_current_time');
        expect(result?.arguments).toEqual({ timezone: 'America/New_York' });
      });

      it('should match unprefixed tool names to prefixed versions', () => {
        const content = `{"name": "get_current_time", "parameters": {"timezone": "UTC"}}`;
        const toolMapping = { 'curated-time__get_current_time': 'curated-time' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.name).toBe('curated-time__get_current_time');
      });

      it('should handle empty parameters', () => {
        const content = `{"name": "curated-time__get_current_time", "parameters": {}}`;
        const toolMapping = { 'curated-time__get_current_time': 'curated-time' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.arguments).toEqual({});
      });

      it('should handle missing parameters key', () => {
        const content = `{"name": "curated-time__get_current_time"}`;
        const toolMapping = { 'curated-time__get_current_time': 'curated-time' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.arguments).toEqual({});
      });
    });

    describe('Format 2: "tool_name": {...}', () => {
      it('should parse key-value format with quotes', () => {
        const content = `"curated-time__get_current_time": {"timezone": "UTC"}`;
        const toolMapping = { 'curated-time__get_current_time': 'curated-time' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.name).toBe('curated-time__get_current_time');
        expect(result?.arguments).toEqual({ timezone: 'UTC' });
      });

      it('should parse key-value format without quotes', () => {
        const content = `curated-time__get_current_time: {"timezone": "UTC"}`;
        const toolMapping = { 'curated-time__get_current_time': 'curated-time' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.name).toBe('curated-time__get_current_time');
      });

      it('should match unprefixed names in key-value format', () => {
        const content = `"get_current_time": {"timezone": "UTC"}`;
        const toolMapping = { 'curated-time__get_current_time': 'curated-time' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.name).toBe('curated-time__get_current_time');
      });
    });

    describe('Format 3: tool_name({...})', () => {
      it('should parse function call style', () => {
        const content = `I'll call the tool: curated-time__get_current_time({"timezone": "UTC"})`;
        const toolMapping = { 'curated-time__get_current_time': 'curated-time' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.name).toBe('curated-time__get_current_time');
        expect(result?.arguments).toEqual({ timezone: 'UTC' });
      });

      it('should match unprefixed names in function call format', () => {
        const content = `get_current_time({"timezone": "UTC"})`;
        const toolMapping = { 'curated-time__get_current_time': 'curated-time' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.name).toBe('curated-time__get_current_time');
      });
    });

    describe('Edge Cases', () => {
      it('should return null for unknown tool names', () => {
        const content = `{"name": "unknown_tool", "parameters": {"foo": "bar"}}`;
        const toolMapping = { 'curated-time__get_current_time': 'curated-time' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).toBeNull();
      });

      it('should return null for content without tool calls', () => {
        const content = `The current time is 3:45 PM. How can I help you further?`;
        const toolMapping = { 'curated-time__get_current_time': 'curated-time' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).toBeNull();
      });

      it('should return null for invalid JSON', () => {
        const content = `{"name": "curated-time__get_current_time", "parameters": {invalid}}`;
        const toolMapping = { 'curated-time__get_current_time': 'curated-time' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).toBeNull();
      });

      it('should handle multiple tools and find the correct one', () => {
        const content = `{"name": "filesystem__read_file", "parameters": {"path": "/test.txt"}}`;
        const toolMapping = { 
          'curated-time__get_current_time': 'curated-time',
          'filesystem__read_file': 'filesystem',
          'github__search_repos': 'github',
        };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.name).toBe('filesystem__read_file');
        expect(result?.arguments).toEqual({ path: '/test.txt' });
      });

      it('should handle nested JSON in parameters', () => {
        const content = `{"name": "test_tool", "parameters": {"config": {"nested": {"deep": true}}, "list": [1, 2, 3]}}`;
        const toolMapping = { 'test_tool': 'test-server' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.arguments).toEqual({
          config: { nested: { deep: true } },
          list: [1, 2, 3],
        });
      });

      it('should handle JSON embedded in explanatory text', () => {
        const content = `To get the current time, I will use the time tool.

Here's the function call:

{"name": "get_current_time", "parameters": {"timezone": "UTC"}}

This will return the current UTC time.`;
        const toolMapping = { 'curated-time__get_current_time': 'curated-time' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.name).toBe('curated-time__get_current_time');
      });
    });

    describe('Real-world LLM Output Examples', () => {
      it('should parse Ollama-style output', () => {
        const content = `To answer the question "what time is it", I will use the "curated-time/get_current_time" function with no specified timezone. This will return the current time in the user's default or local timezone.

Here's a JSON object for the function call:

{"name": "get_current_time", "parameters": {"timezone": ""}}`;
        const toolMapping = { 'curated-time__get_current_time': 'curated-time' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.name).toBe('curated-time__get_current_time');
      });

      it('should handle LLM mentioning the tool before calling it', () => {
        const content = `I can help with that! I'll use the get_current_time tool.

{"name": "curated-time__get_current_time", "parameters": {"timezone": "America/Los_Angeles"}}`;
        const toolMapping = { 'curated-time__get_current_time': 'curated-time' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.name).toBe('curated-time__get_current_time');
        expect(result?.arguments).toEqual({ timezone: 'America/Los_Angeles' });
      });
    });
  });
});

