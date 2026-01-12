/**
 * Chat Orchestrator Tests
 * 
 * Tests for the text-based tool call parsing functionality.
 * This is critical for supporting LLMs (like Ollama) that output
 * tool calls as JSON text instead of using proper tool_calls format.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatOrchestrator } from '../orchestrator.js';
import { parseToolCallFromText } from '../tool-call-parser.js';

// Mock MCP tool call result for tool result extraction tests
let mockCallToolResult = { content: [{ type: 'text', text: 'test result' }] };

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
    callTool: vi.fn().mockImplementation(() => Promise.resolve(mockCallToolResult)),
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
    // Now using the public parseToolCallFromText function directly
    const parseToolCall = (_orchestrator: ChatOrchestrator, content: string, toolMapping: Record<string, string>) => {
      return parseToolCallFromText(content, toolMapping);
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

    describe('Format 5: Bare tool name (no parameters)', () => {
      it('should parse bare tool name by itself', () => {
        const content = `get_me`;
        const toolMapping = { 'curated-github-docker__get_me': 'curated-github-docker' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.name).toBe('curated-github-docker__get_me');
        expect(result?.arguments).toEqual({});
      });

      it('should parse bare tool name with empty parens', () => {
        const content = `get_me()`;
        const toolMapping = { 'curated-github-docker__get_me': 'curated-github-docker' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.name).toBe('curated-github-docker__get_me');
        expect(result?.arguments).toEqual({});
      });

      it('should parse bare tool name with empty object parens', () => {
        const content = `get_me({})`;
        const toolMapping = { 'curated-github-docker__get_me': 'curated-github-docker' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.name).toBe('curated-github-docker__get_me');
        expect(result?.arguments).toEqual({});
      });

      it('should parse prefixed tool name by itself', () => {
        const content = `curated-github-docker__get_me`;
        const toolMapping = { 'curated-github-docker__get_me': 'curated-github-docker' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.name).toBe('curated-github-docker__get_me');
      });

      it('should parse tool name embedded in short response', () => {
        const content = `I'll call get_me now`;
        const toolMapping = { 'curated-github-docker__get_me': 'curated-github-docker' };
        
        const result = parseToolCall(orchestrator, content, toolMapping);
        
        expect(result).not.toBeNull();
        expect(result?.name).toBe('curated-github-docker__get_me');
        expect(result?.arguments).toEqual({});
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

  describe('Model Support Detection', () => {
    // Test the modelSupportsNativeTools logic (accessed via buildSystemPrompt behavior)
    // These are critical to ensure we don't accidentally break text-based tool calling
    
    it('should use text-based prompt for mistral:7b-instruct', () => {
      // Access private method via prototype for testing
      const buildPrompt = (orchestrator as any).buildSystemPrompt.bind(orchestrator);
      const tools = [{ name: 'test', description: 'test', inputSchema: {} }];
      
      const prompt = buildPrompt(tools, 'ollama', 'mistral:7b-instruct');
      
      // Text-based prompt should contain tool call format instructions
      expect(prompt).toContain('Tool Call Format');
      expect(prompt).toContain('{"name":');
    });

    it('should use native prompt for llama3.2', () => {
      const buildPrompt = (orchestrator as any).buildSystemPrompt.bind(orchestrator);
      const tools = [{ name: 'test', description: 'test', inputSchema: {} }];
      
      const prompt = buildPrompt(tools, 'ollama', 'llama3.2:3b');
      
      // Native prompt should NOT contain JSON format instructions
      expect(prompt).not.toContain('{"name":');
      // But should still have strategy guidance
      expect(prompt).toContain('SEARCH first');
    });

    it('should use native prompt for OpenAI', () => {
      const buildPrompt = (orchestrator as any).buildSystemPrompt.bind(orchestrator);
      const tools = [{ name: 'test', description: 'test', inputSchema: {} }];
      
      const prompt = buildPrompt(tools, 'openai', 'gpt-4');
      
      expect(prompt).not.toContain('{"name":');
      expect(prompt).toContain('SEARCH first');
    });

    it('should use native prompt for Anthropic', () => {
      const buildPrompt = (orchestrator as any).buildSystemPrompt.bind(orchestrator);
      const tools = [{ name: 'test', description: 'test', inputSchema: {} }];
      
      const prompt = buildPrompt(tools, 'anthropic', 'claude-3');
      
      expect(prompt).not.toContain('{"name":');
    });
  });

  describe('System Prompt Content', () => {
    it('should tell model that tools ARE connected', () => {
      const buildPrompt = (orchestrator as any).buildSystemPrompt.bind(orchestrator);
      const tools = [{ name: 'test', description: 'test', inputSchema: {} }];
      
      const prompt = buildPrompt(tools, 'ollama', 'mistral:7b-instruct');
      
      // Critical: The prompt should tell the model tools work
      expect(prompt.toLowerCase()).toContain('connected');
      // Should warn the model NOT to say "can't access"
      expect(prompt.toLowerCase()).toContain("never say");
    });

    it('should include guidance for empty results', () => {
      const buildPrompt = (orchestrator as any).buildSystemPrompt.bind(orchestrator);
      const tools = [{ name: 'test', description: 'test', inputSchema: {} }];
      
      const prompt = buildPrompt(tools, 'ollama', 'mistral:7b-instruct');
      
      // Should tell model what to do with empty results
      expect(prompt.toLowerCase()).toContain('no results');
    });

    it('should discourage saying "I cannot access"', () => {
      const buildPrompt = (orchestrator as any).buildSystemPrompt.bind(orchestrator);
      const tools = [{ name: 'test', description: 'test', inputSchema: {} }];
      
      const prompt = buildPrompt(tools, 'ollama', 'mistral:7b-instruct');
      
      // Should tell model not to say it can't access things
      // The prompt says: "never say 'I can't access'"
      expect(prompt.toLowerCase()).toContain("never say");
      expect(prompt.toLowerCase()).toContain("i can't access");
    });

    it('should explain step-by-step workflow', () => {
      const buildPrompt = (orchestrator as any).buildSystemPrompt.bind(orchestrator);
      const tools = [{ name: 'test', description: 'test', inputSchema: {} }];
      
      const prompt = buildPrompt(tools, 'ollama', 'mistral:7b-instruct');
      
      // Should explain multi-step workflow
      expect(prompt).toContain('SEARCH first');
      expect(prompt).toContain('READ');
    });
  });

  describe('Tool Result Extraction', () => {
    /**
     * Tests for extracting content from MCP tool call results.
     * This is critical to ensure tool results are properly passed to the LLM.
     * 
     * MCP tool results have the format:
     * { content: [{ type: 'text', text: '...' }, ...], isError?: boolean }
     */

    // Helper to test tool result extraction logic
    function extractToolResultContent(result: { content?: Array<{ type: string; text?: string }>; isError?: boolean }): string {
      let content = '';
      if (result.content && result.content.length > 0) {
        content = result.content
          .map(c => {
            if (c.type === 'text') return c.text || '';
            if (c.type === 'image') return '[Image data]';
            return JSON.stringify(c);
          })
          .join('\n');
      }
      return content;
    }

    describe('Standard text content', () => {
      it('should extract text from single content item', () => {
        const result = {
          content: [{ type: 'text', text: 'Hello, World!' }],
        };
        
        const extracted = extractToolResultContent(result);
        expect(extracted).toBe('Hello, World!');
      });

      it('should extract text from multiple content items', () => {
        const result = {
          content: [
            { type: 'text', text: 'First line' },
            { type: 'text', text: 'Second line' },
          ],
        };
        
        const extracted = extractToolResultContent(result);
        expect(extracted).toBe('First line\nSecond line');
      });

      it('should handle rich content like email data', () => {
        const emailContent = JSON.stringify({
          emails: [
            { from: 'john@example.com', subject: 'Meeting', snippet: 'Let us meet tomorrow' },
            { from: 'jane@example.com', subject: 'Report', snippet: 'Attached is the report' },
          ],
        });
        
        const result = {
          content: [{ type: 'text', text: emailContent }],
        };
        
        const extracted = extractToolResultContent(result);
        expect(extracted).toContain('john@example.com');
        expect(extracted).toContain('Meeting');
        expect(extracted).toContain('jane@example.com');
        expect(extracted).toContain('Report');
      });

      it('should preserve JSON structure in text content', () => {
        const jsonData = { count: 5, items: ['a', 'b', 'c'] };
        const result = {
          content: [{ type: 'text', text: JSON.stringify(jsonData) }],
        };
        
        const extracted = extractToolResultContent(result);
        const parsed = JSON.parse(extracted);
        expect(parsed.count).toBe(5);
        expect(parsed.items).toEqual(['a', 'b', 'c']);
      });
    });

    describe('Empty and edge cases', () => {
      it('should return empty string for empty content array', () => {
        const result = { content: [] };
        
        const extracted = extractToolResultContent(result);
        expect(extracted).toBe('');
      });

      it('should return empty string for undefined content', () => {
        const result = {};
        
        const extracted = extractToolResultContent(result as any);
        expect(extracted).toBe('');
      });

      it('should return empty string for null content', () => {
        const result = { content: null };
        
        const extracted = extractToolResultContent(result as any);
        expect(extracted).toBe('');
      });

      it('should handle text items with empty text', () => {
        const result = {
          content: [{ type: 'text', text: '' }],
        };
        
        const extracted = extractToolResultContent(result);
        expect(extracted).toBe('');
      });

      it('should handle text items with undefined text', () => {
        const result = {
          content: [{ type: 'text' }],
        };
        
        const extracted = extractToolResultContent(result as any);
        expect(extracted).toBe('');
      });
    });

    describe('Image and mixed content', () => {
      it('should handle image content type', () => {
        const result = {
          content: [{ type: 'image', data: 'base64data' }],
        };
        
        const extracted = extractToolResultContent(result as any);
        expect(extracted).toBe('[Image data]');
      });

      it('should handle mixed text and image content', () => {
        const result = {
          content: [
            { type: 'text', text: 'Here is the chart:' },
            { type: 'image', data: 'base64data' },
            { type: 'text', text: 'Chart shows growth.' },
          ],
        };
        
        const extracted = extractToolResultContent(result as any);
        expect(extracted).toBe('Here is the chart:\n[Image data]\nChart shows growth.');
      });
    });

    describe('Unknown content types', () => {
      it('should JSON stringify unknown content types', () => {
        const result = {
          content: [{ type: 'custom', data: { foo: 'bar' } }],
        };
        
        const extracted = extractToolResultContent(result as any);
        const parsed = JSON.parse(extracted);
        expect(parsed.type).toBe('custom');
        expect(parsed.data.foo).toBe('bar');
      });
    });
  });
});

