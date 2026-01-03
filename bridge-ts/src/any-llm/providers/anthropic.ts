/**
 * Anthropic LLM Provider for any-llm.
 * 
 * Uses the Anthropic Messages API.
 * 
 * @see https://docs.anthropic.com/en/api/messages
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
import { MissingApiKeyError, ProviderRequestError, RateLimitError, TimeoutError } from '../errors.js';

// =============================================================================
// Anthropic API Types
// =============================================================================

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContent[];
}

type AnthropicContent = 
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContent[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  stop_sequence?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface AnthropicStreamEvent {
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop' | 'ping';
  message?: AnthropicResponse;
  index?: number;
  content_block?: AnthropicContent;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: {
    output_tokens: number;
  };
}

interface AnthropicErrorResponse {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}

// =============================================================================
// Anthropic Provider Implementation
// =============================================================================

export class AnthropicProvider extends BaseProvider {
  readonly PROVIDER_NAME = 'anthropic';
  readonly ENV_API_KEY_NAME = 'ANTHROPIC_API_KEY';
  readonly PROVIDER_DOCUMENTATION_URL = 'https://docs.anthropic.com';
  readonly API_BASE = 'https://api.anthropic.com/v1';
  
  readonly SUPPORTS_STREAMING = true;
  readonly SUPPORTS_TOOLS = true;
  readonly SUPPORTS_VISION = true;
  readonly SUPPORTS_LIST_MODELS = false; // Anthropic doesn't have a models endpoint
  readonly SUPPORTS_REASONING = true; // Claude 3.5 has extended thinking
  
  private timeout: number;
  private anthropicVersion: string;
  
  constructor(config: ProviderConfig = {}) {
    super(config);
    this.init();
    this.timeout = config.timeout ?? 60000;
    this.anthropicVersion = (config.anthropicVersion as string) ?? '2023-06-01';
    this.validateConfig();
  }
  
  /**
   * Check if Anthropic API is available.
   */
  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    
    // Anthropic doesn't have a simple health check endpoint
    // We could try a minimal request, but that costs tokens
    // So we just validate the API key format
    return this.apiKey.startsWith('sk-ant-');
  }
  
  /**
   * List available models (static list since Anthropic doesn't have an API).
   */
  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: 'claude-sonnet-4-20250514',
        object: 'model',
        owned_by: 'anthropic',
        provider: 'anthropic',
        supports_tools: true,
        supports_vision: true,
      },
      {
        id: 'claude-3-5-sonnet-20241022',
        object: 'model',
        owned_by: 'anthropic',
        provider: 'anthropic',
        supports_tools: true,
        supports_vision: true,
      },
      {
        id: 'claude-3-5-haiku-20241022',
        object: 'model',
        owned_by: 'anthropic',
        provider: 'anthropic',
        supports_tools: true,
        supports_vision: true,
      },
      {
        id: 'claude-3-opus-20240229',
        object: 'model',
        owned_by: 'anthropic',
        provider: 'anthropic',
        supports_tools: true,
        supports_vision: true,
      },
    ];
  }
  
  /**
   * Handle error responses from Anthropic.
   */
  private async handleErrorResponse(response: Response): Promise<never> {
    let errorMessage = `HTTP ${response.status}`;
    
    try {
      const errorData = await response.json() as AnthropicErrorResponse;
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
   * Convert messages to Anthropic format.
   * Handles system messages separately.
   */
  private convertMessages(messages: Message[]): { system?: string; messages: AnthropicMessage[] } {
    let systemPrompt: string | undefined;
    const anthropicMessages: AnthropicMessage[] = [];
    
    for (const msg of messages) {
      if (msg.role === 'system') {
        // Anthropic handles system as a separate parameter
        if (typeof msg.content === 'string') {
          systemPrompt = (systemPrompt ? systemPrompt + '\n' : '') + msg.content;
        }
        continue;
      }
      
      // Map 'tool' role to user with tool_result
      if (msg.role === 'tool') {
        anthropicMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id || '',
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          }],
        });
        continue;
      }
      
      const anthropicMsg: AnthropicMessage = {
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: '',
      };
      
      // Handle content
      if (typeof msg.content === 'string') {
        anthropicMsg.content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const contentBlocks: AnthropicContent[] = [];
        
        for (const part of msg.content) {
          if (part.type === 'text') {
            contentBlocks.push({ type: 'text', text: part.text });
          } else if (part.type === 'image_url') {
            const url = part.image_url.url;
            if (url.startsWith('data:')) {
              // Parse data URL
              const match = url.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                contentBlocks.push({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: match[1],
                    data: match[2],
                  },
                });
              }
            }
          }
        }
        
        anthropicMsg.content = contentBlocks;
      } else if (msg.content === null) {
        anthropicMsg.content = '';
      }
      
      // Handle tool calls from assistant
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const content: AnthropicContent[] = [];
        
        // Add text content if present
        if (typeof anthropicMsg.content === 'string' && anthropicMsg.content) {
          content.push({ type: 'text', text: anthropicMsg.content });
        }
        
        // Add tool use blocks
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        }
        
        anthropicMsg.content = content;
      }
      
      anthropicMessages.push(anthropicMsg);
    }
    
    return { system: systemPrompt, messages: anthropicMessages };
  }
  
  /**
   * Convert tools to Anthropic format.
   */
  private convertTools(tools: Tool[]): AnthropicTool[] {
    return tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
  }
  
  /**
   * Convert tool choice to Anthropic format.
   */
  private convertToolChoice(choice: CompletionRequest['tool_choice']): AnthropicRequest['tool_choice'] | undefined {
    if (!choice) return undefined;
    if (choice === 'none') return undefined;
    if (choice === 'auto') return { type: 'auto' };
    if (choice === 'required') return { type: 'any' };
    if (typeof choice === 'object' && choice.type === 'function') {
      return { type: 'tool', name: choice.function.name };
    }
    return undefined;
  }
  
  /**
   * Convert Anthropic response to OpenAI format.
   */
  private convertResponse(response: AnthropicResponse): ChatCompletion {
    let textContent = '';
    const toolCalls: Message['tool_calls'] = [];
    
    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }
    
    // Determine finish reason
    let finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null = 'stop';
    if (response.stop_reason === 'tool_use') {
      finishReason = 'tool_calls';
    } else if (response.stop_reason === 'max_tokens') {
      finishReason = 'length';
    }
    
    return {
      id: response.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: response.model,
      provider: 'anthropic',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: finishReason,
      }],
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }
  
  /**
   * Create a chat completion.
   */
  async completion(request: CompletionRequest): Promise<ChatCompletion> {
    if (!this.apiKey) {
      throw new MissingApiKeyError(this.PROVIDER_NAME, this.ENV_API_KEY_NAME);
    }
    
    const { system, messages } = this.convertMessages(request.messages);
    
    const anthropicRequest: AnthropicRequest = {
      model: request.model,
      messages,
      max_tokens: request.max_tokens ?? 4096, // Anthropic requires max_tokens
      stream: false,
    };
    
    // Add system prompt
    if (system) {
      anthropicRequest.system = system;
    }
    
    // Add optional parameters
    if (request.tools && request.tools.length > 0) {
      anthropicRequest.tools = this.convertTools(request.tools);
    }
    if (request.tool_choice !== undefined) {
      anthropicRequest.tool_choice = this.convertToolChoice(request.tool_choice);
    }
    if (request.temperature !== undefined) {
      anthropicRequest.temperature = request.temperature;
    }
    if (request.top_p !== undefined) {
      anthropicRequest.top_p = request.top_p;
    }
    if (request.stop) {
      anthropicRequest.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
    }
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      
      const response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.anthropicVersion,
        },
        body: JSON.stringify(anthropicRequest),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        await this.handleErrorResponse(response);
      }
      
      const data = await response.json() as AnthropicResponse;
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
    
    const { system, messages } = this.convertMessages(request.messages);
    
    const anthropicRequest: AnthropicRequest = {
      model: request.model,
      messages,
      max_tokens: request.max_tokens ?? 4096,
      stream: true,
    };
    
    if (system) {
      anthropicRequest.system = system;
    }
    if (request.tools && request.tools.length > 0) {
      anthropicRequest.tools = this.convertTools(request.tools);
    }
    if (request.tool_choice !== undefined) {
      anthropicRequest.tool_choice = this.convertToolChoice(request.tool_choice);
    }
    if (request.temperature !== undefined) {
      anthropicRequest.temperature = request.temperature;
    }
    if (request.top_p !== undefined) {
      anthropicRequest.top_p = request.top_p;
    }
    
    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.anthropicVersion,
      },
      body: JSON.stringify(anthropicRequest),
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
    let messageId = '';
    let model = request.model;
    const created = Math.floor(Date.now() / 1000);
    
    // Track current tool use for streaming
    let currentToolUse: { id: string; name: string; arguments: string } | null = null;
    
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
            
            try {
              const event = JSON.parse(data) as AnthropicStreamEvent;
              
              if (event.type === 'message_start' && event.message) {
                messageId = event.message.id;
                model = event.message.model;
              } else if (event.type === 'content_block_start' && event.content_block) {
                if (event.content_block.type === 'tool_use') {
                  currentToolUse = {
                    id: event.content_block.id,
                    name: event.content_block.name,
                    arguments: '',
                  };
                }
              } else if (event.type === 'content_block_delta' && event.delta) {
                const chunkChoice: ChunkChoice = {
                  index: 0,
                  delta: {},
                  finish_reason: null,
                };
                
                if (event.delta.type === 'text_delta' && event.delta.text) {
                  chunkChoice.delta.content = event.delta.text;
                } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
                  if (currentToolUse) {
                    currentToolUse.arguments += event.delta.partial_json;
                  }
                }
                
                if (chunkChoice.delta.content) {
                  yield {
                    id: messageId || `anthropic-${Date.now()}`,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [chunkChoice],
                  };
                }
              } else if (event.type === 'content_block_stop') {
                if (currentToolUse) {
                  yield {
                    id: messageId || `anthropic-${Date.now()}`,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [{
                      index: 0,
                      delta: {
                        tool_calls: [{
                          id: currentToolUse.id,
                          type: 'function',
                          function: {
                            name: currentToolUse.name,
                            arguments: currentToolUse.arguments,
                          },
                        }],
                      },
                      finish_reason: null,
                    }],
                  };
                  currentToolUse = null;
                }
              } else if (event.type === 'message_delta') {
                let finishReason: ChunkChoice['finish_reason'] = 'stop';
                if (event.delta?.stop_reason === 'tool_use') {
                  finishReason = 'tool_calls';
                } else if (event.delta?.stop_reason === 'max_tokens') {
                  finishReason = 'length';
                }
                
                yield {
                  id: messageId || `anthropic-${Date.now()}`,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: finishReason,
                  }],
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

