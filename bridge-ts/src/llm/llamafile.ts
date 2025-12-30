/**
 * llamafile LLM Provider.
 * 
 * llamafile provides an OpenAI-compatible API on localhost:8080 by default.
 * This provider connects to it and translates our types to/from the OpenAI format.
 * 
 * @see https://github.com/Mozilla-Ocho/llamafile
 */

import { log } from '../native-messaging.js';
import {
  LLMProvider,
  LLMModel,
  ChatRequest,
  ChatResponse,
  ChatMessage,
  ChatChunk,
  ToolDefinition,
  ToolCall,
} from './provider.js';

// Default llamafile endpoint
const DEFAULT_LLAMAFILE_URL = 'http://localhost:8080';

// Timeout for API calls (ms)
const API_TIMEOUT = 60000;

// =============================================================================
// OpenAI API Types (subset used by llamafile)
// =============================================================================

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: OpenAIMessage;
    finish_reason: 'stop' | 'tool_calls' | 'length' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIModelsResponse {
  object: string;
  data: Array<{
    id: string;
    object: string;
    created: number;
    owned_by: string;
  }>;
}

// =============================================================================
// LlamafileProvider Implementation
// =============================================================================

export class LlamafileProvider implements LLMProvider {
  readonly id = 'llamafile';
  readonly name = 'llamafile';
  readonly baseUrl: string;

  private defaultModel: string = 'default';

  constructor(baseUrl: string = DEFAULT_LLAMAFILE_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
  }

  /**
   * Check if llamafile is running and accessible.
   */
  async detect(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        log('[LlamafileProvider] Detected llamafile running');
        return true;
      }

      log(`[LlamafileProvider] Unexpected response: ${response.status}`);
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[LlamafileProvider] Not detected: ${message}`);
      return false;
    }
  }

  /**
   * List available models from llamafile.
   * llamafile typically only has one model loaded at a time.
   */
  async listModels(): Promise<LLMModel[]> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as OpenAIModelsResponse;

      return data.data.map(model => ({
        id: model.id,
        name: model.id,
        supportsTools: true, // Assume tool support for now
        provider: 'llamafile',
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[LlamafileProvider] Failed to list models: ${message}`);
      return [];
    }
  }

  /**
   * Send a chat completion request.
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = request.model || this.defaultModel;

    // Convert to OpenAI format
    const openaiRequest: OpenAIChatRequest = {
      model,
      messages: this.convertMessagesToOpenAI(request.messages, request.systemPrompt),
      stream: false,
    };

    if (request.tools && request.tools.length > 0) {
      openaiRequest.tools = this.convertToolsToOpenAI(request.tools);
    }

    if (request.maxTokens) {
      openaiRequest.max_tokens = request.maxTokens;
    }

    if (request.temperature !== undefined) {
      openaiRequest.temperature = request.temperature;
    }

    log(`[LlamafileProvider] Sending chat request with ${request.messages.length} messages`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);

      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(openaiRequest),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json() as OpenAIChatResponse;

      if (!data.choices || data.choices.length === 0) {
        throw new Error('No choices in response');
      }

      const choice = data.choices[0];
      const message = this.convertMessageFromOpenAI(choice.message);

      log(`[LlamafileProvider] Got response: ${choice.finish_reason}`);

      return {
        message,
        usage: data.usage ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        } : undefined,
        finishReason: this.convertFinishReason(choice.finish_reason),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[LlamafileProvider] Chat failed: ${message}`);

      return {
        message: {
          role: 'assistant',
          content: '',
        },
        finishReason: 'error',
        error: message,
      };
    }
  }

  /**
   * Stream a chat completion.
   */
  async *chatStream(request: ChatRequest): AsyncIterable<ChatChunk> {
    const model = request.model || this.defaultModel;

    // Convert to OpenAI format
    const openaiRequest: OpenAIChatRequest = {
      model,
      messages: this.convertMessagesToOpenAI(request.messages, request.systemPrompt),
      stream: true,
    };

    if (request.tools && request.tools.length > 0) {
      openaiRequest.tools = this.convertToolsToOpenAI(request.tools);
    }

    if (request.maxTokens) {
      openaiRequest.max_tokens = request.maxTokens;
    }

    if (request.temperature !== undefined) {
      openaiRequest.temperature = request.temperature;
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(openaiRequest),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error('No response body for streaming');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              return;
            }

            try {
              const chunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta;
              const finishReason = chunk.choices?.[0]?.finish_reason;

              if (delta) {
                yield {
                  delta: {
                    role: delta.role,
                    content: delta.content || '',
                    toolCalls: delta.tool_calls?.map((tc: OpenAIToolCall) => ({
                      id: tc.id,
                      name: tc.function.name,
                      arguments: tc.function.arguments ? JSON.parse(tc.function.arguments) : {},
                    })),
                  },
                  finishReason: finishReason ? this.convertFinishReason(finishReason) : undefined,
                };
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[LlamafileProvider] Stream failed: ${message}`);

      yield {
        delta: { content: '' },
        finishReason: 'error',
      };
    }
  }

  // ===========================================================================
  // Conversion Helpers
  // ===========================================================================

  private convertMessagesToOpenAI(
    messages: ChatMessage[],
    systemPrompt?: string
  ): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];

    // Add system prompt if provided and not already in messages
    if (systemPrompt && !messages.some(m => m.role === 'system')) {
      result.push({
        role: 'system',
        content: systemPrompt,
      });
    }

    for (const msg of messages) {
      const openaiMsg: OpenAIMessage = {
        role: msg.role,
        content: msg.content,
      };

      if (msg.toolCalls) {
        openaiMsg.tool_calls = msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
      }

      if (msg.toolCallId) {
        openaiMsg.tool_call_id = msg.toolCallId;
      }

      result.push(openaiMsg);
    }

    return result;
  }

  private convertMessageFromOpenAI(msg: OpenAIMessage): ChatMessage {
    const result: ChatMessage = {
      role: msg.role,
      content: msg.content || '',
    };

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      result.toolCalls = msg.tool_calls.map(tc => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          log(`[LlamafileProvider] Failed to parse tool call arguments: ${tc.function.arguments}`);
        }

        return {
          id: tc.id,
          name: tc.function.name,
          arguments: args,
        };
      });
    }

    if (msg.tool_call_id) {
      result.toolCallId = msg.tool_call_id;
    }

    return result;
  }

  private convertToolsToOpenAI(tools: ToolDefinition[]): OpenAITool[] {
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  private convertFinishReason(
    reason: 'stop' | 'tool_calls' | 'length' | null
  ): 'stop' | 'tool_calls' | 'length' | 'error' {
    if (reason === 'tool_calls') return 'tool_calls';
    if (reason === 'length') return 'length';
    return 'stop';
  }
}

/**
 * Create a llamafile provider with the given base URL.
 */
export function createLlamafileProvider(baseUrl?: string): LlamafileProvider {
  return new LlamafileProvider(baseUrl);
}


