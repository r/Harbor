/**
 * Llamafile LLM Provider for any-llm.
 * 
 * Llamafile provides an OpenAI-compatible API on localhost:8080.
 * 
 * @see https://github.com/Mozilla-Ocho/llamafile
 */

import { BaseProvider } from './base.js';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChunkChoice,
  CompletionRequest,
  Message,
  ModelInfo,
  ProviderConfig,
  Tool,
} from '../types.js';
import { ProviderRequestError, ProviderUnavailableError, TimeoutError } from '../errors.js';

// =============================================================================
// OpenAI-compatible API Types (llamafile uses this format)
// =============================================================================

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: Array<{
    type: 'function';
    function: { name: string; description?: string; parameters: Record<string, unknown> };
  }>;
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
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIModelsResponse {
  data: Array<{
    id: string;
    object: string;
    created: number;
    owned_by: string;
  }>;
}

// =============================================================================
// Llamafile Provider Implementation
// =============================================================================

export class LlamafileProvider extends BaseProvider {
  readonly PROVIDER_NAME = 'llamafile';
  readonly ENV_API_KEY_NAME = 'LLAMAFILE_API_KEY'; // Optional
  readonly PROVIDER_DOCUMENTATION_URL = 'https://github.com/Mozilla-Ocho/llamafile';
  readonly API_BASE = 'http://localhost:8080';
  
  readonly SUPPORTS_STREAMING = true;
  readonly SUPPORTS_TOOLS = true;
  readonly SUPPORTS_VISION = false; // Depends on model
  readonly SUPPORTS_LIST_MODELS = true;
  readonly SUPPORTS_REASONING = false;
  
  private timeout: number;
  
  constructor(config: ProviderConfig = {}) {
    super(config);
    this.init();
    this.timeout = config.timeout ?? 60000;
  }
  
  /**
   * Llamafile doesn't require an API key.
   */
  protected requiresApiKey(): boolean {
    return false;
  }
  
  /**
   * Check if llamafile is available.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }
  
  /**
   * List available models.
   */
  async listModels(): Promise<ModelInfo[]> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new ProviderRequestError(this.PROVIDER_NAME, `HTTP ${response.status}`);
      }
      
      const data = await response.json() as OpenAIModelsResponse;
      
      return data.data.map(model => ({
        id: model.id,
        object: 'model' as const,
        created: model.created,
        owned_by: model.owned_by || 'llamafile',
        provider: 'llamafile',
        supports_tools: true,
      }));
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new ProviderUnavailableError(this.PROVIDER_NAME, 'Failed to list models');
    }
  }
  
  /**
   * Convert messages to OpenAI format.
   */
  private convertMessages(messages: Message[]): OpenAIMessage[] {
    return messages.map(msg => {
      const openaiMsg: OpenAIMessage = {
        role: msg.role,
        content: null,
      };
      
      if (typeof msg.content === 'string') {
        openaiMsg.content = msg.content;
      } else if (msg.content === null) {
        openaiMsg.content = null;
      } else if (Array.isArray(msg.content)) {
        // Flatten multimodal to text only for llamafile
        openaiMsg.content = msg.content
          .filter(p => p.type === 'text')
          .map(p => (p as { text: string }).text)
          .join(' ');
      }
      
      if (msg.tool_calls) {
        openaiMsg.tool_calls = msg.tool_calls;
      }
      
      if (msg.tool_call_id) {
        openaiMsg.tool_call_id = msg.tool_call_id;
      }
      
      return openaiMsg;
    });
  }
  
  /**
   * Convert tools to OpenAI format.
   */
  private convertTools(tools: Tool[]): OpenAIChatRequest['tools'] {
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      },
    }));
  }
  
  /**
   * Convert response to our format.
   */
  private convertResponse(response: OpenAIChatResponse): ChatCompletion {
    return {
      id: response.id,
      object: 'chat.completion',
      created: response.created,
      model: response.model,
      provider: 'llamafile',
      choices: response.choices.map(choice => ({
        index: choice.index,
        message: {
          role: choice.message.role,
          content: choice.message.content,
          tool_calls: choice.message.tool_calls,
        },
        finish_reason: choice.finish_reason,
      })),
      usage: response.usage,
    };
  }
  
  /**
   * Create a chat completion.
   */
  async completion(request: CompletionRequest): Promise<ChatCompletion> {
    const openaiRequest: OpenAIChatRequest = {
      model: request.model || 'default',
      messages: this.convertMessages(request.messages),
      stream: false,
    };
    
    if (request.tools && request.tools.length > 0) {
      openaiRequest.tools = this.convertTools(request.tools);
    }
    if (request.max_tokens !== undefined) {
      openaiRequest.max_tokens = request.max_tokens;
    }
    if (request.temperature !== undefined) {
      openaiRequest.temperature = request.temperature;
    }
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(openaiRequest),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new ProviderRequestError(this.PROVIDER_NAME, `HTTP ${response.status}: ${errorText}`, response.status);
      }
      
      const data = await response.json() as OpenAIChatResponse;
      return this.convertResponse(data);
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TimeoutError(this.PROVIDER_NAME, this.timeout);
      }
      throw new ProviderRequestError(this.PROVIDER_NAME, error instanceof Error ? error.message : String(error));
    }
  }
  
  /**
   * Stream a chat completion.
   */
  async *completionStream(request: CompletionRequest): AsyncIterable<ChatCompletionChunk> {
    const openaiRequest: OpenAIChatRequest = {
      model: request.model || 'default',
      messages: this.convertMessages(request.messages),
      stream: true,
    };
    
    if (request.tools && request.tools.length > 0) {
      openaiRequest.tools = this.convertTools(request.tools);
    }
    if (request.max_tokens !== undefined) {
      openaiRequest.max_tokens = request.max_tokens;
    }
    if (request.temperature !== undefined) {
      openaiRequest.temperature = request.temperature;
    }
    
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(openaiRequest),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new ProviderRequestError(this.PROVIDER_NAME, `HTTP ${response.status}: ${errorText}`, response.status);
    }
    
    if (!response.body) {
      throw new ProviderRequestError(this.PROVIDER_NAME, 'No response body for streaming');
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') return;
            
            try {
              const chunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta;
              const finishReason = chunk.choices?.[0]?.finish_reason;
              
              if (delta) {
                const chunkChoice: ChunkChoice = {
                  index: 0,
                  delta: {
                    role: delta.role,
                    content: delta.content || undefined,
                    tool_calls: delta.tool_calls?.map((tc: { id: string; function: { name: string; arguments: string } }) => ({
                      id: tc.id,
                      type: 'function' as const,
                      function: {
                        name: tc.function?.name,
                        arguments: tc.function?.arguments,
                      },
                    })),
                  },
                  finish_reason: finishReason || null,
                };
                
                yield {
                  id: chunk.id || `llamafile-${Date.now()}`,
                  object: 'chat.completion.chunk',
                  created: chunk.created || Math.floor(Date.now() / 1000),
                  model: chunk.model || request.model,
                  choices: [chunkChoice],
                };
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

