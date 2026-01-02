/**
 * API Types and Structure Tests
 * 
 * Tests that verify the API types match the documented JS_AI_PROVIDER_API.md specification.
 * This ensures our TypeScript types are correct and match the contract we expose to web apps.
 */

import { describe, it, expect } from 'vitest';
import type {
  ApiError,
  ApiErrorCode,
  PermissionScope,
  PermissionGrant,
  PermissionGrantResult,
  PermissionStatus,
  ToolDescriptor,
  ActiveTabReadability,
  TextSessionOptions,
  StreamToken,
  AgentRunOptions,
  Citation,
  RunEvent,
  RequestPermissionsPayload,
} from '../types';

describe('API Types Match Documentation', () => {
  describe('Error Codes (JS_AI_PROVIDER_API.md > Error Handling)', () => {
    it('should define all documented error codes', () => {
      // Per API docs: Error Codes table
      const documentedErrorCodes: ApiErrorCode[] = [
        'ERR_NOT_INSTALLED',        // Extension not installed
        'ERR_PERMISSION_DENIED',    // User denied permission
        'ERR_USER_GESTURE_REQUIRED',// Needs user interaction (click)
        'ERR_SCOPE_REQUIRED',       // Missing required permission scope
        'ERR_TOOL_NOT_ALLOWED',     // Tool not in allowlist
        'ERR_TOOL_FAILED',          // Tool execution failed
        'ERR_MODEL_FAILED',         // LLM request failed
        'ERR_NOT_IMPLEMENTED',      // Feature not available
        'ERR_SESSION_NOT_FOUND',    // Session was destroyed
        'ERR_TIMEOUT',              // Request timed out
        'ERR_INTERNAL',             // Internal error
      ];

      // These should all be valid ApiErrorCode values
      for (const code of documentedErrorCodes) {
        const error: ApiError = { code, message: 'test' };
        expect(error.code).toBe(code);
      }
    });

    it('should have correct ApiError structure', () => {
      // Per API docs: ApiError interface
      const error: ApiError = {
        code: 'ERR_TOOL_FAILED',
        message: 'Tool execution failed',
        details: { toolName: 'test/tool' },
      };

      expect(error).toHaveProperty('code');
      expect(error).toHaveProperty('message');
      expect(error).toHaveProperty('details');
      expect(typeof error.code).toBe('string');
      expect(typeof error.message).toBe('string');
    });
  });

  describe('Permission Scopes (JS_AI_PROVIDER_API.md > Permission Scopes)', () => {
    it('should define all documented permission scopes', () => {
      // Per API docs: Permission Scopes table
      const documentedScopes: PermissionScope[] = [
        'model:prompt',           // Generate text using AI models
        'model:tools',            // Use AI with tool calling
        'mcp:tools.list',         // List available MCP tools
        'mcp:tools.call',         // Execute MCP tools
        'browser:activeTab.read', // Read content from active tab
        'web:fetch',              // Proxy fetch requests (NOT IMPLEMENTED in v1)
      ];

      // All should be valid PermissionScope values
      for (const scope of documentedScopes) {
        const status: Partial<Record<PermissionScope, PermissionGrant>> = {
          [scope]: 'granted-always',
        };
        expect(status[scope]).toBe('granted-always');
      }
    });
  });

  describe('Permission Grants (JS_AI_PROVIDER_API.md > Permission Grants)', () => {
    it('should define all documented grant types', () => {
      // Per API docs: Permission Grants table
      const documentedGrants: PermissionGrant[] = [
        'granted-always',  // Persisted permission for this origin
        'granted-once',    // Temporary permission (expires after ~10 minutes or tab close)
        'denied',          // User explicitly denied (won't re-prompt)
        'not-granted',     // Never requested
      ];

      for (const grant of documentedGrants) {
        const status: Record<PermissionScope, PermissionGrant> = {
          'model:prompt': grant,
          'model:tools': grant,
          'mcp:tools.list': grant,
          'mcp:tools.call': grant,
          'browser:activeTab.read': grant,
          'web:fetch': grant,
        };
        expect(status['model:prompt']).toBe(grant);
      }
    });
  });

  describe('PermissionGrantResult (JS_AI_PROVIDER_API.md > agent.requestPermissions)', () => {
    it('should have correct structure', () => {
      // Per API docs: PermissionGrantResult interface
      const result: PermissionGrantResult = {
        granted: true,
        scopes: {
          'model:prompt': 'granted-always',
          'model:tools': 'granted-always',
          'mcp:tools.list': 'granted-always',
          'mcp:tools.call': 'granted-always',
          'browser:activeTab.read': 'not-granted',
          'web:fetch': 'not-granted',
        },
      };

      expect(result).toHaveProperty('granted');
      expect(result).toHaveProperty('scopes');
      expect(typeof result.granted).toBe('boolean');
      expect(typeof result.scopes).toBe('object');
    });

    it('should support allowedTools field', () => {
      const result: PermissionGrantResult = {
        granted: true,
        scopes: {
          'model:prompt': 'granted-always',
          'model:tools': 'granted-always',
          'mcp:tools.list': 'granted-always',
          'mcp:tools.call': 'granted-always',
          'browser:activeTab.read': 'not-granted',
          'web:fetch': 'not-granted',
        },
        allowedTools: ['server1/tool1', 'server2/tool2'],
      };

      expect(result.allowedTools).toEqual(['server1/tool1', 'server2/tool2']);
    });
  });

  describe('PermissionStatus (JS_AI_PROVIDER_API.md > agent.permissions.list)', () => {
    it('should have correct structure', () => {
      // Per API docs: PermissionStatus interface
      const status: PermissionStatus = {
        origin: 'https://example.com',
        scopes: {
          'model:prompt': 'granted-always',
          'model:tools': 'not-granted',
          'mcp:tools.list': 'granted-once',
          'mcp:tools.call': 'denied',
          'browser:activeTab.read': 'not-granted',
          'web:fetch': 'not-granted',
        },
      };

      expect(status).toHaveProperty('origin');
      expect(status).toHaveProperty('scopes');
      expect(typeof status.origin).toBe('string');
    });

    it('should support allowedTools field', () => {
      const status: PermissionStatus = {
        origin: 'https://example.com',
        scopes: {
          'model:prompt': 'granted-always',
          'model:tools': 'not-granted',
          'mcp:tools.list': 'granted-once',
          'mcp:tools.call': 'granted-always',
          'browser:activeTab.read': 'not-granted',
          'web:fetch': 'not-granted',
        },
        allowedTools: ['memory-server/save_memory'],
      };

      expect(status.allowedTools).toEqual(['memory-server/save_memory']);
    });
  });

  describe('ToolDescriptor (JS_AI_PROVIDER_API.md > agent.tools.list)', () => {
    it('should have correct structure', () => {
      // Per API docs: ToolDescriptor interface
      const tool: ToolDescriptor = {
        name: 'memory-server/save_memory',
        description: 'Save a memory to long-term storage',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string' },
          },
          required: ['content'],
        },
        serverId: 'memory-server',
      };

      expect(tool).toHaveProperty('name');
      expect(tool.name).toContain('/'); // Fully qualified: "serverId/toolName"
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('inputSchema');
      expect(tool).toHaveProperty('serverId');
    });

    it('should allow optional fields', () => {
      const minimalTool: ToolDescriptor = {
        name: 'server/tool',
      };

      expect(minimalTool.name).toBe('server/tool');
      expect(minimalTool.description).toBeUndefined();
      expect(minimalTool.inputSchema).toBeUndefined();
    });
  });

  describe('ActiveTabReadability (JS_AI_PROVIDER_API.md > agent.browser.activeTab.readability)', () => {
    it('should have correct structure', () => {
      // Per API docs: ActiveTabReadability interface
      const tab: ActiveTabReadability = {
        url: 'https://example.com/article',
        title: 'Example Article',
        text: 'This is the extracted text content...',
      };

      expect(tab).toHaveProperty('url');
      expect(tab).toHaveProperty('title');
      expect(tab).toHaveProperty('text');
      expect(typeof tab.url).toBe('string');
      expect(typeof tab.title).toBe('string');
      expect(typeof tab.text).toBe('string');
    });
  });

  describe('TextSessionOptions (JS_AI_PROVIDER_API.md > ai.createTextSession)', () => {
    it('should have correct structure', () => {
      // Per API docs: TextSessionOptions interface
      const options: TextSessionOptions = {
        model: 'default',
        temperature: 0.7,
        top_p: 0.9,
        systemPrompt: 'You are a helpful assistant.',
      };

      expect(options).toHaveProperty('model');
      expect(options).toHaveProperty('temperature');
      expect(options).toHaveProperty('top_p');
      expect(options).toHaveProperty('systemPrompt');
    });

    it('should allow all fields to be optional', () => {
      const options: TextSessionOptions = {};
      expect(options.model).toBeUndefined();
      expect(options.temperature).toBeUndefined();
    });
  });

  describe('StreamToken (JS_AI_PROVIDER_API.md > session.promptStreaming)', () => {
    it('should support token type', () => {
      const token: StreamToken = {
        type: 'token',
        token: 'Hello',
      };
      expect(token.type).toBe('token');
      expect(token.token).toBe('Hello');
    });

    it('should support done type', () => {
      const done: StreamToken = {
        type: 'done',
      };
      expect(done.type).toBe('done');
    });

    it('should support error type', () => {
      const errorToken: StreamToken = {
        type: 'error',
        error: { code: 'ERR_MODEL_FAILED', message: 'LLM failed' },
      };
      expect(errorToken.type).toBe('error');
      expect(errorToken.error?.code).toBe('ERR_MODEL_FAILED');
    });
  });

  describe('AgentRunOptions (JS_AI_PROVIDER_API.md > agent.run)', () => {
    it('should have correct structure', () => {
      // Per API docs: AgentRunOptions interface
      const options: AgentRunOptions = {
        task: 'Research AI news and summarize',
        tools: ['search/web_search'],
        useAllTools: false,
        requireCitations: true,
        maxToolCalls: 5,
      };

      expect(options).toHaveProperty('task');
      expect(options).toHaveProperty('tools');
      expect(options).toHaveProperty('useAllTools');
      expect(options).toHaveProperty('requireCitations');
      expect(options).toHaveProperty('maxToolCalls');
    });

    it('should only require task', () => {
      const minimalOptions: AgentRunOptions = {
        task: 'Do something',
      };
      expect(minimalOptions.task).toBe('Do something');
      expect(minimalOptions.tools).toBeUndefined();
      expect(minimalOptions.maxToolCalls).toBeUndefined();
    });
  });

  describe('Citation (JS_AI_PROVIDER_API.md > agent.run)', () => {
    it('should support tab source', () => {
      const citation: Citation = {
        source: 'tab',
        ref: 'https://example.com/article',
        excerpt: 'Relevant excerpt from the page...',
      };
      expect(citation.source).toBe('tab');
    });

    it('should support tool source', () => {
      const citation: Citation = {
        source: 'tool',
        ref: 'search/web_search',
        excerpt: 'Search result excerpt...',
      };
      expect(citation.source).toBe('tool');
    });
  });

  describe('RunEvent (JS_AI_PROVIDER_API.md > agent.run)', () => {
    it('should support status event', () => {
      const event: RunEvent = {
        type: 'status',
        message: 'Initializing agent...',
      };
      expect(event.type).toBe('status');
      expect(event.message).toBe('Initializing agent...');
    });

    it('should support tool_call event', () => {
      const event: RunEvent = {
        type: 'tool_call',
        tool: 'search/web_search',
        args: { query: 'AI news' },
      };
      expect(event.type).toBe('tool_call');
      expect(event.tool).toBe('search/web_search');
    });

    it('should support tool_result event', () => {
      const event: RunEvent = {
        type: 'tool_result',
        tool: 'search/web_search',
        result: { results: [] },
      };
      expect(event.type).toBe('tool_result');

      // Also with error
      const errorEvent: RunEvent = {
        type: 'tool_result',
        tool: 'search/web_search',
        result: null,
        error: { code: 'ERR_TOOL_FAILED', message: 'Search failed' },
      };
      expect(errorEvent.error?.code).toBe('ERR_TOOL_FAILED');
    });

    it('should support token event', () => {
      const event: RunEvent = {
        type: 'token',
        token: 'Hello',
      };
      expect(event.type).toBe('token');
      expect(event.token).toBe('Hello');
    });

    it('should support final event', () => {
      const event: RunEvent = {
        type: 'final',
        output: 'Here is the summary...',
        citations: [
          { source: 'tool', ref: 'search/web_search', excerpt: '...' },
        ],
      };
      expect(event.type).toBe('final');
      expect(event.output).toBeDefined();
      expect(event.citations).toHaveLength(1);
    });

    it('should support error event', () => {
      const event: RunEvent = {
        type: 'error',
        error: { code: 'ERR_INTERNAL', message: 'Something went wrong' },
      };
      expect(event.type).toBe('error');
      expect(event.error.code).toBe('ERR_INTERNAL');
    });
  });

  describe('RequestPermissionsPayload', () => {
    it('should support basic request', () => {
      const payload: RequestPermissionsPayload = {
        scopes: ['model:prompt', 'mcp:tools.call'],
        reason: 'App needs AI capabilities',
      };
      expect(payload.scopes).toContain('model:prompt');
      expect(payload.reason).toBe('App needs AI capabilities');
    });

    it('should support tools field for per-tool permissions', () => {
      const payload: RequestPermissionsPayload = {
        scopes: ['mcp:tools.call'],
        reason: 'Need specific tools',
        tools: ['memory-server/save_memory', 'memory-server/search_memories'],
      };
      expect(payload.tools).toContain('memory-server/save_memory');
      expect(payload.tools).toHaveLength(2);
    });
  });
});

describe('API Behavior Contract', () => {
  describe('Permission Request Flow', () => {
    it('should allow requesting all scopes at once', () => {
      // Per API docs: You can request multiple scopes in one call
      const request: RequestPermissionsPayload = {
        scopes: ['model:prompt', 'model:tools', 'mcp:tools.list', 'mcp:tools.call', 'browser:activeTab.read'],
        reason: 'Full AI capabilities',
      };
      expect(request.scopes.length).toBe(5);
    });

    it('should support requesting specific tools with mcp:tools.call', () => {
      // Per-tool permission request
      const request: RequestPermissionsPayload = {
        scopes: ['mcp:tools.call'],
        tools: ['filesystem/read_file', 'filesystem/write_file'],
      };
      expect(request.scopes).toContain('mcp:tools.call');
      expect(request.tools).toHaveLength(2);
    });
  });

  describe('Tool Name Format', () => {
    it('should use serverId/toolName format', () => {
      // Per API docs: "Fully qualified: serverId/toolName"
      const toolDescriptor: ToolDescriptor = {
        name: 'memory-server/save_memory',
        serverId: 'memory-server',
      };

      const [serverId, toolName] = toolDescriptor.name.split('/');
      expect(serverId).toBe('memory-server');
      expect(toolName).toBe('save_memory');
      expect(serverId).toBe(toolDescriptor.serverId);
    });
  });

  describe('Error Response Structure', () => {
    it('should include all required error fields', () => {
      // Per API docs: ApiError interface
      const error: ApiError = {
        code: 'ERR_TOOL_NOT_ALLOWED',
        message: 'Tool "filesystem/write_file" is not in the allowlist for this origin',
        details: { tool: 'filesystem/write_file', allowedTools: ['filesystem/read_file'] },
      };

      // Error should have code (required)
      expect(error.code).toBeTruthy();
      // Error should have message (required)
      expect(error.message).toBeTruthy();
      // Details should contain useful context
      expect(error.details).toHaveProperty('tool');
      expect(error.details).toHaveProperty('allowedTools');
    });
  });

  describe('Permission Result Contract', () => {
    it('should return granted=true only if ALL requested scopes granted', () => {
      // Per API docs: "granted: true if ALL requested scopes were granted"
      
      // All granted
      const allGranted: PermissionGrantResult = {
        granted: true,
        scopes: {
          'model:prompt': 'granted-always',
          'model:tools': 'granted-always',
          'mcp:tools.list': 'not-granted',
          'mcp:tools.call': 'not-granted',
          'browser:activeTab.read': 'not-granted',
          'web:fetch': 'not-granted',
        },
      };
      // If we only requested model:prompt and model:tools, this should be granted
      const requestedScopes: PermissionScope[] = ['model:prompt', 'model:tools'];
      const allRequestedGranted = requestedScopes.every(s => 
        allGranted.scopes[s] === 'granted-always' || allGranted.scopes[s] === 'granted-once'
      );
      expect(allRequestedGranted).toBe(true);
      
      // Partial grant
      const partialGrant: PermissionGrantResult = {
        granted: false,
        scopes: {
          'model:prompt': 'granted-always',
          'model:tools': 'denied',
          'mcp:tools.list': 'not-granted',
          'mcp:tools.call': 'not-granted',
          'browser:activeTab.read': 'not-granted',
          'web:fetch': 'not-granted',
        },
      };
      expect(partialGrant.granted).toBe(false);
    });

    it('should distinguish between grant types in scopes', () => {
      const result: PermissionGrantResult = {
        granted: true,
        scopes: {
          'model:prompt': 'granted-always',  // Persisted
          'model:tools': 'granted-once',      // Temporary
          'mcp:tools.list': 'denied',         // Explicitly denied
          'mcp:tools.call': 'not-granted',    // Never requested
          'browser:activeTab.read': 'not-granted',
          'web:fetch': 'not-granted',
        },
      };

      // App can check individual scope status
      expect(result.scopes['model:prompt']).toBe('granted-always');
      expect(result.scopes['model:tools']).toBe('granted-once');
      expect(result.scopes['mcp:tools.list']).toBe('denied');
      expect(result.scopes['mcp:tools.call']).toBe('not-granted');
    });
  });

  describe('Agent Run Event Sequence', () => {
    it('should follow documented event order', () => {
      // Per API docs: Event types in order they might occur
      const eventSequence: RunEvent[] = [
        { type: 'status', message: 'Initializing agent...' },
        { type: 'status', message: 'Found 5 tools' },
        { type: 'tool_call', tool: 'search/web_search', args: { query: 'AI news' } },
        { type: 'tool_result', tool: 'search/web_search', result: { results: [] } },
        { type: 'token', token: 'Based on' },
        { type: 'token', token: ' my research' },
        { type: 'final', output: 'Based on my research...', citations: [] },
      ];

      // Verify the sequence makes sense
      expect(eventSequence[0].type).toBe('status');
      expect(eventSequence.at(-1)?.type).toBe('final');
      
      // Tool call should come before tool result
      const toolCallIndex = eventSequence.findIndex(e => e.type === 'tool_call');
      const toolResultIndex = eventSequence.findIndex(e => e.type === 'tool_result');
      expect(toolCallIndex).toBeLessThan(toolResultIndex);
    });

    it('should support error event terminating the stream', () => {
      const errorSequence: RunEvent[] = [
        { type: 'status', message: 'Initializing...' },
        { type: 'error', error: { code: 'ERR_MODEL_FAILED', message: 'LLM unavailable' } },
      ];

      // Error should be last event
      expect(errorSequence.at(-1)?.type).toBe('error');
    });
  });
});

