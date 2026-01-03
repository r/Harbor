/**
 * Chrome AI API Compatibility Tests
 * 
 * Tests that verify the Chrome-compatible API surface matches
 * Chrome's Prompt API specification while still working with Harbor.
 */

import { describe, it, expect } from 'vitest';
import type {
  AICapabilityAvailability,
  AITextSession,
  AILanguageModelCapabilities,
  AILanguageModelCreateOptions,
  AIApi,
  TextSessionOptions,
  StreamToken,
} from '../types';

describe('Chrome AI API Compatibility Types', () => {
  describe('AICapabilityAvailability', () => {
    it('should support all Chrome capability states', () => {
      // Per Chrome Prompt API spec
      const states: AICapabilityAvailability[] = [
        'readily',        // Model is ready to use immediately
        'after-download', // Model needs to be downloaded first
        'no',             // Model is not available
      ];

      for (const state of states) {
        const caps: AILanguageModelCapabilities = { available: state };
        expect(caps.available).toBe(state);
      }
    });
  });

  describe('AILanguageModelCapabilities', () => {
    it('should have correct structure matching Chrome API', () => {
      // Per Chrome Prompt API: capabilities() return type
      const caps: AILanguageModelCapabilities = {
        available: 'readily',
        defaultTopK: 40,
        maxTopK: 100,
        defaultTemperature: 1.0,
      };

      expect(caps).toHaveProperty('available');
      expect(caps).toHaveProperty('defaultTopK');
      expect(caps).toHaveProperty('maxTopK');
      expect(caps).toHaveProperty('defaultTemperature');
    });

    it('should allow minimal response (only available required)', () => {
      const minimalCaps: AILanguageModelCapabilities = {
        available: 'no',
      };

      expect(minimalCaps.available).toBe('no');
      expect(minimalCaps.defaultTopK).toBeUndefined();
      expect(minimalCaps.maxTopK).toBeUndefined();
      expect(minimalCaps.defaultTemperature).toBeUndefined();
    });
  });

  describe('AILanguageModelCreateOptions', () => {
    it('should support Chrome languageModel.create() options', () => {
      // Per Chrome Prompt API: create() options
      const options: AILanguageModelCreateOptions = {
        systemPrompt: 'You are a helpful assistant.',
        temperature: 0.7,
        topK: 40,
      };

      expect(options).toHaveProperty('systemPrompt');
      expect(options).toHaveProperty('temperature');
      expect(options).toHaveProperty('topK');
    });

    it('should support initialPrompts for conversation context', () => {
      // Chrome API supports pre-loading conversation history
      const options: AILanguageModelCreateOptions = {
        systemPrompt: 'You are helpful.',
        initialPrompts: [
          { role: 'user', content: 'Hello!' },
          { role: 'assistant', content: 'Hi there! How can I help?' },
        ],
      };

      expect(options.initialPrompts).toHaveLength(2);
      expect(options.initialPrompts?.[0].role).toBe('user');
      expect(options.initialPrompts?.[1].role).toBe('assistant');
    });

    it('should support AbortSignal for cancellation', () => {
      const controller = new AbortController();
      const options: AILanguageModelCreateOptions = {
        signal: controller.signal,
      };

      expect(options.signal).toBe(controller.signal);
    });

    it('should allow empty options', () => {
      const options: AILanguageModelCreateOptions = {};
      expect(options.systemPrompt).toBeUndefined();
      expect(options.temperature).toBeUndefined();
    });
  });

  describe('AITextSession', () => {
    it('should extend TextSession with clone() method', () => {
      // Chrome API supports cloning sessions
      // This is the key addition over Harbor's base TextSession
      
      // Type check: AITextSession should have clone()
      const mockSession: AITextSession = {
        sessionId: 'test-123',
        prompt: async (_input: string) => 'response',
        promptStreaming: (_input: string) => ({
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'token', token: 'test' } as StreamToken;
            yield { type: 'done' } as StreamToken;
          },
        }),
        destroy: async () => {},
        clone: async () => mockSession, // Chrome compatibility: clone()
      };

      expect(mockSession).toHaveProperty('clone');
      expect(typeof mockSession.clone).toBe('function');
    });

    it('should have all base TextSession methods', () => {
      const session: AITextSession = {
        sessionId: 'test-456',
        prompt: async () => 'response',
        promptStreaming: () => ({
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'done' } as StreamToken;
          },
        }),
        destroy: async () => {},
        clone: async function() { return this; },
      };

      expect(session).toHaveProperty('sessionId');
      expect(session).toHaveProperty('prompt');
      expect(session).toHaveProperty('promptStreaming');
      expect(session).toHaveProperty('destroy');
    });
  });

  describe('AIApi Interface', () => {
    it('should define canCreateTextSession() for Chrome compatibility', () => {
      // Chrome API: window.ai.canCreateTextSession()
      const mockAi: AIApi = {
        canCreateTextSession: async () => 'readily',
        createTextSession: async () => ({
          sessionId: 'test',
          prompt: async () => '',
          promptStreaming: () => ({ [Symbol.asyncIterator]: async function* () {} }),
          destroy: async () => {},
          clone: async function() { return this; },
        }),
        languageModel: {
          capabilities: async () => ({ available: 'readily' }),
          create: async () => ({
            sessionId: 'test',
            prompt: async () => '',
            promptStreaming: () => ({ [Symbol.asyncIterator]: async function* () {} }),
            destroy: async () => {},
            clone: async function() { return this; },
          }),
        },
      };

      expect(mockAi).toHaveProperty('canCreateTextSession');
      expect(typeof mockAi.canCreateTextSession).toBe('function');
    });

    it('should define languageModel namespace for Chrome Prompt API', () => {
      // Chrome API: window.ai.languageModel.create()
      const mockAi: AIApi = {
        canCreateTextSession: async () => 'readily',
        createTextSession: async () => ({
          sessionId: 'test',
          prompt: async () => '',
          promptStreaming: () => ({ [Symbol.asyncIterator]: async function* () {} }),
          destroy: async () => {},
          clone: async function() { return this; },
        }),
        languageModel: {
          capabilities: async () => ({ available: 'readily' }),
          create: async () => ({
            sessionId: 'test',
            prompt: async () => '',
            promptStreaming: () => ({ [Symbol.asyncIterator]: async function* () {} }),
            destroy: async () => {},
            clone: async function() { return this; },
          }),
        },
      };

      expect(mockAi).toHaveProperty('languageModel');
      expect(mockAi.languageModel).toHaveProperty('capabilities');
      expect(mockAi.languageModel).toHaveProperty('create');
    });
  });
});

describe('Chrome API Usage Patterns', () => {
  describe('Simple Chrome-like Usage', () => {
    it('should allow Chrome-style code pattern', async () => {
      // This is the simple Chrome pattern that should "just work":
      //   const session = await window.ai.createTextSession();
      //   const result = await session.prompt('Hello');
      
      // Type check that this pattern compiles
      const mockCreateTextSession = async (options?: TextSessionOptions): Promise<AITextSession> => ({
        sessionId: 'chrome-style-session',
        prompt: async (input: string) => `Response to: ${input}`,
        promptStreaming: () => ({
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'done' } as StreamToken;
          },
        }),
        destroy: async () => {},
        clone: async function() { return this; },
      });

      // Simple usage - no explicit permission request needed
      const session = await mockCreateTextSession();
      const result = await session.prompt('Hello');
      
      expect(result).toBe('Response to: Hello');
      expect(session.sessionId).toBe('chrome-style-session');
    });

    it('should allow Chrome languageModel.create() pattern', async () => {
      // Chrome Prompt API style:
      //   const session = await ai.languageModel.create({ systemPrompt: '...' });
      //   const result = await session.prompt('Hello');
      
      const mockLanguageModel = {
        capabilities: async (): Promise<AILanguageModelCapabilities> => ({
          available: 'readily',
          defaultTemperature: 1.0,
        }),
        create: async (options?: AILanguageModelCreateOptions): Promise<AITextSession> => ({
          sessionId: 'lm-session',
          prompt: async (input: string) => `[${options?.systemPrompt || 'default'}] ${input}`,
          promptStreaming: () => ({
            [Symbol.asyncIterator]: async function* () {
              yield { type: 'done' } as StreamToken;
            },
          }),
          destroy: async () => {},
          clone: async function() { return this; },
        }),
      };

      // Check capabilities first
      const caps = await mockLanguageModel.capabilities();
      expect(caps.available).toBe('readily');

      // Create session with system prompt
      const session = await mockLanguageModel.create({
        systemPrompt: 'Be concise.',
      });
      const result = await session.prompt('What is 2+2?');
      
      expect(result).toContain('Be concise.');
    });
  });

  describe('Session Cloning (Chrome Feature)', () => {
    it('should support cloning sessions for parallel conversations', async () => {
      // Chrome API allows cloning sessions to branch conversations
      let sessionCounter = 0;
      let conversationHistory: string[] = [];
      
      const createSession = async (): Promise<AITextSession> => {
        const history = [...conversationHistory];
        const id = `session-${++sessionCounter}`;
        return {
          sessionId: id,
          prompt: async (input: string) => {
            history.push(input);
            return `Response #${history.length}`;
          },
          promptStreaming: () => ({
            [Symbol.asyncIterator]: async function* () {
              yield { type: 'done' } as StreamToken;
            },
          }),
          destroy: async () => {},
          clone: async () => createSession(),
        };
      };

      const session1 = await createSession();
      await session1.prompt('First message');
      
      // Clone creates independent session with different ID
      const session2 = await session1.clone();
      expect(session2.sessionId).not.toBe(session1.sessionId);
      expect(session1.sessionId).toBe('session-1');
      expect(session2.sessionId).toBe('session-2');
    });
  });

  describe('Capability Checking', () => {
    it('should allow checking availability before creating session', async () => {
      // Good practice: check capabilities first
      const mockCapabilities = async (): Promise<AILanguageModelCapabilities> => ({
        available: 'readily',
        defaultTemperature: 1.0,
        defaultTopK: 40,
        maxTopK: 100,
      });

      const caps = await mockCapabilities();
      
      if (caps.available === 'readily') {
        // Safe to create session
        expect(true).toBe(true);
      } else if (caps.available === 'after-download') {
        // Model needs download - could show UI
        expect(true).toBe(true);
      } else {
        // Model not available
        expect(caps.available).toBe('no');
      }
    });
  });
});

describe('Harbor Extensions to Chrome API', () => {
  describe('Auto-Permission Request', () => {
    it('should document that createTextSession auto-requests permission', () => {
      // Harbor enhancement: createTextSession() automatically requests
      // the 'model:prompt' permission if not already granted.
      // This differs from Chrome where permissions are implicit.
      
      // The permission flow is:
      // 1. Check if 'model:prompt' is granted
      // 2. If not, auto-request with default reason
      // 3. If granted, proceed; if denied, throw ERR_PERMISSION_DENIED
      
      expect(true).toBe(true); // Documentation test
    });
  });

  describe('Harbor TextSessionOptions Extensions', () => {
    it('should support Harbor-specific options alongside Chrome options', () => {
      // Harbor supports additional options not in Chrome API
      const harborOptions: TextSessionOptions = {
        model: 'default',        // Harbor: select specific model
        temperature: 0.7,        // Chrome compatible
        top_p: 0.9,              // Harbor: top_p parameter
        systemPrompt: 'Helper',  // Chrome compatible
      };

      expect(harborOptions).toHaveProperty('model');
      expect(harborOptions).toHaveProperty('top_p');
    });
  });

  describe('Explicit Permission Control', () => {
    it('should document that explicit permissions are still available', () => {
      // Harbor users can still use explicit permission requests for:
      // - Custom permission reason messages
      // - Fine-grained scope control
      // - Browser API access (activeTab.read)
      // - MCP tool access
      
      // Example of explicit Harbor style (still supported):
      // await window.agent.requestPermissions({
      //   scopes: ['model:prompt', 'browser:activeTab.read'],
      //   reason: 'Summarize the current page'
      // });
      
      expect(true).toBe(true); // Documentation test
    });
  });
});

