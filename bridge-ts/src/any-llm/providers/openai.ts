/**
 * OpenAI LLM Provider for any-llm.
 * 
 * Uses the OpenAI API for chat completions.
 * This provider wraps fetch calls to maintain consistency with other providers.
 * 
 * @see https://platform.openai.com/docs/api-reference
 */

import { BaseProvider } from './base.js';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChunkChoice,
  CompletionChoice,
  CompletionRequest,
  Message,
  ModelInfo,
  ProviderConfig,
  Tool,
} from '../types.js';
import { MissingApiKeyError, ProviderRequestError, RateLimitError, TimeoutError } from '../errors.js';

// =============================================================================
// OpenAI API Types
// =============================================================================

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: Array<{
    type: 'function';
    function: { name: string; description?: string; parameters: Record<string, unknown> };
  }>;
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  n?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  user?: string;
  response_format?: { type: 'text' | 'json_object' } | { type: 'json_schema'; json_schema: Record<string, unknown> };
}

interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: OpenAIMessage;
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
    logprobs?: unknown;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Partial<OpenAIMessage>;
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }>;
}

interface OpenAIModelsResponse {
  data: Array<{
    id: string;
    object: string;
    created: number;
    owned_by: string;
  }>;
}

interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}

// =============================================================================
// OpenAI Provider Implementation
// =============================================================================

export class OpenAIProvider extends BaseProvider {
  readonly PROVIDER_NAME = 'openai';
  readonly ENV_API_KEY_NAME = 'OPENAI_API_KEY';
  readonly PROVIDER_DOCUMENTATION_URL = 'https://platform.openai.com/docs';
  readonly API_BASE = 'https://api.openai.com/v1';
  
  readonly SUPPORTS_STREAMING = true;
  readonly SUPPORTS_TOOLS = true;
  readonly SUPPORTS_VISION = true;
  readonly SUPPORTS_LIST_MODELS = true;
  readonly SUPPORTS_REASONING = false; // Only o1 models, handled separately
  
  private timeout: number;
  
  constructor(config: ProviderConfig = {}) {
    super(config);
    this.init();
    this.timeout = config.timeout ?? 60000;
    this.validateConfig();
  }
  
  /**
   * Check if OpenAI API is available.
   */
  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
  
  /**
   * List available models.
   */
  async listModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) {
      throw new MissingApiKeyError(this.PROVIDER_NAME, this.ENV_API_KEY_NAME);
    }
    
    const response = await fetch(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
    });
    
    if (!response.ok) {
      await this.handleErrorResponse(response);
    }
    
    const data = await response.json() as OpenAIModelsResponse;
    
    return data.data
      .filter(m => m.id.includes('gpt') || m.id.includes('o1') || m.id.includes('o3'))
      .map(model => ({
        id: model.id,
        object: 'model' as const,
        created: model.created,
        owned_by: model.owned_by,
        provider: 'openai',
        supports_tools: this.modelSupportsTools(model.id),
        supports_vision: this.modelSupportsVision(model.id),
      }));
  }
  
  /**
   * Check if a model supports tools.
   */
  private modelSupportsTools(modelId: string): boolean {
    // o1 models don't support tools (as of late 2024)
    if (modelId.startsWith('o1-')) return false;
    return true;
  }
  
  /**
   * Check if a model supports vision.
   */
  private modelSupportsVision(modelId: string): boolean {
    const visionModels = ['gpt-4o', 'gpt-4-turbo', 'gpt-4-vision', 'o1'];
    return visionModels.some(m => modelId.includes(m));
  }
  
  /**
   * Handle error responses from OpenAI.
   */
  private async handleErrorResponse(response: Response): Promise<never> {
    let errorMessage = `HTTP ${response.status}`;
    
    try {
      const errorData = await response.json() as OpenAIErrorResponse;
      errorMessage = errorData.error?.message || errorMessage;
    } catch {
      // Couldn't parse error JSON
    }
    
    if (response.status === 429) {
      throw new RateLimitError(this.PROVIDER_NAME);
    }
    
    if (response.status === 401) {
      throw new MissingApiKeyError(this.PROVIDER_NAME, this.ENV_API_KEY_NAME);
    }
    
    throw new ProviderRequestError(this.PROVIDER_NAME, errorMessage, response.status);
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
      
      // Handle content
      if (typeof msg.content === 'string') {
        openaiMsg.content = msg.content;
      } else if (Array.isArray(msg.content)) {
        openaiMsg.content = msg.content.map(part => {
          if (part.type === 'text') {
            return { type: 'text', text: part.text };
          } else if (part.type === 'image_url') {
            return {
              type: 'image_url',
              image_url: {
                url: part.image_url.url,
                detail: part.image_url.detail,
              },
            };
          }
          return part;
        });
      } else {
        openaiMsg.content = msg.content;
      }
      
      // Handle tool calls
      if (msg.tool_calls) {
        openaiMsg.tool_calls = msg.tool_calls;
      }
      
      // Handle tool call ID (for tool responses)
      if (msg.tool_call_id) {
        openaiMsg.tool_call_id = msg.tool_call_id;
      }
      
      // Handle name
      if (msg.name) {
        openaiMsg.name = msg.name;
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
   * Convert OpenAI response to our format.
   */
  private convertResponse(response: OpenAIChatResponse): ChatCompletion {
    return {
      id: response.id,
      object: 'chat.completion',
      created: response.created,
      model: response.model,
      provider: 'openai',
      choices: response.choices.map(choice => ({
        index: choice.index,
        message: {
          role: choice.message.role,
          content: typeof choice.message.content === 'string' ? choice.message.content : null,
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
    if (!this.apiKey) {
      throw new MissingApiKeyError(this.PROVIDER_NAME, this.ENV_API_KEY_NAME);
    }
    
    const openaiRequest: OpenAIChatRequest = {
      model: request.model,
      messages: this.convertMessages(request.messages),
      stream: false,
    };
    
    // Add optional parameters
    if (request.tools && request.tools.length > 0) {
      openaiRequest.tools = this.convertTools(request.tools);
    }
    if (request.tool_choice !== undefined) {
      openaiRequest.tool_choice = request.tool_choice;
    }
    if (request.temperature !== undefined) {
      openaiRequest.temperature = request.temperature;
    }
    if (request.top_p !== undefined) {
      openaiRequest.top_p = request.top_p;
    }
    if (request.max_tokens !== undefined) {
      // Use max_completion_tokens for newer models
      if (request.model.startsWith('o1') || request.model.startsWith('o3')) {
        openaiRequest.max_completion_tokens = request.max_tokens;
      } else {
        openaiRequest.max_tokens = request.max_tokens;
      }
    }
    if (request.n !== undefined) {
      openaiRequest.n = request.n;
    }
    if (request.stop !== undefined) {
      openaiRequest.stop = request.stop;
    }
    if (request.presence_penalty !== undefined) {
      openaiRequest.presence_penalty = request.presence_penalty;
    }
    if (request.frequency_penalty !== undefined) {
      openaiRequest.frequency_penalty = request.frequency_penalty;
    }
    if (request.seed !== undefined) {
      openaiRequest.seed = request.seed;
    }
    if (request.user !== undefined) {
      openaiRequest.user = request.user;
    }
    if (request.response_format !== undefined) {
      openaiRequest.response_format = request.response_format;
    }
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(openaiRequest),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        await this.handleErrorResponse(response);
      }
      
      const data = await response.json() as OpenAIChatResponse;
      return this.convertResponse(data);
    } catch (error) {
      if (error instanceof ProviderRequestError || error instanceof RateLimitError || error instanceof MissingApiKeyError) {
        throw error;
      }
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
    if (!this.apiKey) {
      throw new MissingApiKeyError(this.PROVIDER_NAME, this.ENV_API_KEY_NAME);
    }
    
    const openaiRequest: OpenAIChatRequest = {
      model: request.model,
      messages: this.convertMessages(request.messages),
      stream: true,
    };
    
    // Add optional parameters (same as non-streaming)
    if (request.tools && request.tools.length > 0) {
      openaiRequest.tools = this.convertTools(request.tools);
    }
    if (request.tool_choice !== undefined) {
      openaiRequest.tool_choice = request.tool_choice;
    }
    if (request.temperature !== undefined) {
      openaiRequest.temperature = request.temperature;
    }
    if (request.top_p !== undefined) {
      openaiRequest.top_p = request.top_p;
    }
    if (request.max_tokens !== undefined) {
      if (request.model.startsWith('o1') || request.model.startsWith('o3')) {
        openaiRequest.max_completion_tokens = request.max_tokens;
      } else {
        openaiRequest.max_tokens = request.max_tokens;
      }
    }
    
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(openaiRequest),
    });
    
    if (!response.ok) {
      await this.handleErrorResponse(response);
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
              const chunk = JSON.parse(data) as OpenAIStreamChunk;
              
              const chunkChoice: ChunkChoice = {
                index: chunk.choices[0]?.index || 0,
                delta: {
                  role: chunk.choices[0]?.delta?.role,
                  content: typeof chunk.choices[0]?.delta?.content === 'string' 
                    ? chunk.choices[0].delta.content 
                    : undefined,
                  tool_calls: chunk.choices[0]?.delta?.tool_calls?.map(tc => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: tc.function,
                  })),
                },
                finish_reason: chunk.choices[0]?.finish_reason || null,
              };
              
              yield {
                id: chunk.id,
                object: 'chat.completion.chunk',
                created: chunk.created,
                model: chunk.model,
                choices: [chunkChoice],
              };
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

/**
 * Base class for OpenAI-compatible providers.
 * Providers like Groq, Together, OpenRouter can extend this.
 */
export class OpenAICompatibleProvider extends OpenAIProvider {
  constructor(
    providerName: string,
    apiBase: string,
    envKeyName: string,
    config: ProviderConfig = {},
  ) {
    super({
      ...config,
      baseUrl: config.baseUrl || apiBase,
    });
    
    // Override the readonly properties via Object.defineProperty
    Object.defineProperty(this, 'PROVIDER_NAME', { value: providerName });
    Object.defineProperty(this, 'API_BASE', { value: apiBase });
    Object.defineProperty(this, 'ENV_API_KEY_NAME', { value: envKeyName });
  }
}

