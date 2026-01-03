/**
 * Adapter to bridge the existing LLMProvider interface with any-llm.
 * 
 * This allows gradual migration to any-llm while maintaining backward compatibility
 * with the existing chat system.
 */

import { log } from '../native-messaging.js';
import {
  LLMProvider as LegacyLLMProvider,
  LLMModel,
  ChatRequest,
  ChatResponse,
  ChatChunk,
  ChatMessage,
  ToolCall,
} from './provider.js';

import {
  AnyLLM,
  completion,
  completionStream,
  checkProvider,
  getSupportedProviders,
  type LLMProviderType,
  type ProviderConfig,
  type Message as AnyLLMMessage,
  type CompletionRequest,
  type ChatCompletion,
  type ChatCompletionChunk,
  type Tool as AnyLLMTool,
} from '../any-llm/index.js';

/**
 * Adapter that wraps any-llm providers to work with the existing LLMProvider interface.
 */
export class AnyLLMAdapter implements LegacyLLMProvider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  
  private providerType: LLMProviderType;
  private config: ProviderConfig;
  private defaultModel: string | null = null;
  private cachedModels: LLMModel[] | null = null;
  private _version: string | null = null;
  private _supportsTools: boolean = true;
  
  constructor(
    providerType: LLMProviderType,
    config: ProviderConfig = {},
  ) {
    this.providerType = providerType;
    this.config = config;
    this.id = providerType;
    this.name = this.getDisplayName(providerType);
    this.baseUrl = config.baseUrl || this.getDefaultBaseUrl(providerType);
  }
  
  private getDisplayName(providerType: LLMProviderType): string {
    const names: Record<string, string> = {
      openai: 'OpenAI',
      anthropic: 'Anthropic',
      ollama: 'Ollama',
      llamafile: 'llamafile',
      mistral: 'Mistral',
      groq: 'Groq',
    };
    return names[providerType] || providerType;
  }
  
  private getDefaultBaseUrl(providerType: LLMProviderType): string {
    const urls: Record<string, string> = {
      openai: 'https://api.openai.com/v1',
      anthropic: 'https://api.anthropic.com/v1',
      ollama: 'http://localhost:11434',
      llamafile: 'http://localhost:8080',
    };
    return urls[providerType] || '';
  }
  
  /**
   * Get the detected version (for local providers).
   */
  get version(): string | null {
    return this._version;
  }
  
  /**
   * Check if this provider supports tool calling.
   */
  get supportsTools(): boolean {
    return this._supportsTools;
  }
  
  /**
   * Detect if the provider is available.
   */
  async detect(): Promise<boolean> {
    try {
      const status = await checkProvider(this.providerType, this.config);
      
      if (status.available && status.models) {
        this.cachedModels = status.models.map(m => ({
          id: m.id,
          name: m.id,
          supportsTools: m.supports_tools ?? true,
          provider: this.providerType,
        }));
      }
      
      // Update version info for Ollama
      if (this.providerType === 'ollama' && status.version) {
        this._version = status.version;
      }
      
      return status.available;
    } catch (error) {
      log(`[AnyLLMAdapter] Detection failed for ${this.id}: ${error}`);
      return false;
    }
  }
  
  /**
   * List available models.
   */
  async listModels(): Promise<LLMModel[]> {
    if (this.cachedModels) {
      return this.cachedModels;
    }
    
    try {
      const llm = AnyLLM.create(this.providerType, this.config);
      const models = await llm.listModels();
      
      this.cachedModels = models.map(m => ({
        id: m.id,
        name: m.id,
        supportsTools: m.supports_tools ?? true,
        provider: this.providerType,
      }));
      
      return this.cachedModels;
    } catch (error) {
      log(`[AnyLLMAdapter] listModels failed: ${error}`);
      return [];
    }
  }
  
  /**
   * Get the default model for this provider.
   */
  private async getDefaultModel(): Promise<string> {
    if (this.defaultModel) {
      return this.defaultModel;
    }
    
    if (!this.cachedModels) {
      this.cachedModels = await this.listModels();
    }
    
    if (this.cachedModels.length > 0) {
      // Prefer models that support tools
      const toolModel = this.cachedModels.find(m => m.supportsTools);
      this.defaultModel = toolModel?.id || this.cachedModels[0].id;
    } else {
      // Fallbacks by provider
      const defaults: Record<string, string> = {
        openai: 'gpt-4o-mini',
        anthropic: 'claude-3-5-haiku-20241022',
        ollama: 'llama3.2',
        llamafile: 'default',
      };
      this.defaultModel = defaults[this.providerType] || 'default';
    }
    
    return this.defaultModel;
  }
  
  /**
   * Convert legacy ChatMessage to any-llm Message format.
   */
  private convertMessages(messages: ChatMessage[], systemPrompt?: string): AnyLLMMessage[] {
    const result: AnyLLMMessage[] = [];
    
    // Add system prompt if provided
    if (systemPrompt && !messages.some(m => m.role === 'system')) {
      result.push({
        role: 'system',
        content: systemPrompt,
      });
    }
    
    for (const msg of messages) {
      const anyMsg: AnyLLMMessage = {
        role: msg.role,
        content: msg.content,
      };
      
      if (msg.toolCalls) {
        anyMsg.tool_calls = msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
      }
      
      if (msg.toolCallId) {
        anyMsg.tool_call_id = msg.toolCallId;
      }
      
      result.push(anyMsg);
    }
    
    return result;
  }
  
  /**
   * Convert legacy ToolDefinition to any-llm Tool format.
   */
  private convertTools(tools: ChatRequest['tools']): AnyLLMTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    }));
  }
  
  /**
   * Convert any-llm response to legacy ChatResponse format.
   */
  private convertResponse(response: ChatCompletion): ChatResponse {
    const choice = response.choices[0];
    const message = choice?.message;
    
    // Handle content - convert to string if needed
    let content: string = '';
    if (typeof message?.content === 'string') {
      content = message.content;
    } else if (Array.isArray(message?.content)) {
      // Flatten multimodal content to text
      content = message.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map(p => p.text)
        .join(' ');
    }
    
    const chatMessage: ChatMessage = {
      role: message?.role || 'assistant',
      content,
    };
    
    // Convert tool calls
    if (message?.tool_calls && message.tool_calls.length > 0) {
      chatMessage.toolCalls = message.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }));
    }
    
    // Convert finish reason
    let finishReason: ChatResponse['finishReason'] = 'stop';
    if (choice?.finish_reason === 'tool_calls') {
      finishReason = 'tool_calls';
    } else if (choice?.finish_reason === 'length') {
      finishReason = 'length';
    }
    
    return {
      message: chatMessage,
      finishReason,
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    };
  }
  
  /**
   * Send a chat completion request.
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = request.model || await this.getDefaultModel();
    
    const anyRequest: CompletionRequest = {
      model: `${this.providerType}:${model}`,
      messages: this.convertMessages(request.messages, request.systemPrompt),
      tools: this.convertTools(request.tools),
      max_tokens: request.maxTokens,
      temperature: request.temperature,
    };
    
    // Pass API key from config
    if (this.config.apiKey) {
      anyRequest.api_key = this.config.apiKey;
    }
    if (this.config.baseUrl) {
      anyRequest.api_base = this.config.baseUrl;
    }
    
    try {
      const response = await completion(anyRequest);
      return this.convertResponse(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[AnyLLMAdapter] chat failed: ${message}`);
      return {
        message: { role: 'assistant', content: '' },
        finishReason: 'error',
        error: message,
      };
    }
  }
  
  /**
   * Stream a chat completion.
   */
  async *chatStream(request: ChatRequest): AsyncIterable<ChatChunk> {
    const model = request.model || await this.getDefaultModel();
    
    const anyRequest: CompletionRequest = {
      model: `${this.providerType}:${model}`,
      messages: this.convertMessages(request.messages, request.systemPrompt),
      tools: this.convertTools(request.tools),
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stream: true,
    };
    
    if (this.config.apiKey) {
      anyRequest.api_key = this.config.apiKey;
    }
    if (this.config.baseUrl) {
      anyRequest.api_base = this.config.baseUrl;
    }
    
    try {
      for await (const chunk of completionStream(anyRequest)) {
        const delta = chunk.choices[0]?.delta;
        const finishReason = chunk.choices[0]?.finish_reason;
        
        const chatChunk: ChatChunk = {
          delta: {
            role: delta?.role,
            content: delta?.content || '',
          },
        };
        
        // Convert tool calls in delta
        if (delta?.tool_calls && delta.tool_calls.length > 0) {
          chatChunk.delta.toolCalls = delta.tool_calls.map(tc => ({
            id: tc.id || '',
            name: tc.function?.name || '',
            arguments: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
          }));
        }
        
        // Convert finish reason
        if (finishReason === 'tool_calls') {
          chatChunk.finishReason = 'tool_calls';
        } else if (finishReason === 'stop') {
          chatChunk.finishReason = 'stop';
        } else if (finishReason === 'length') {
          chatChunk.finishReason = 'length';
        }
        
        yield chatChunk;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[AnyLLMAdapter] chatStream failed: ${message}`);
      yield {
        delta: { content: '' },
        finishReason: 'error',
      };
    }
  }
}

/**
 * Create an adapter for a specific provider.
 */
export function createAnyLLMAdapter(
  providerType: LLMProviderType,
  config?: ProviderConfig,
): AnyLLMAdapter {
  return new AnyLLMAdapter(providerType, config);
}

/**
 * Get all supported any-llm provider types.
 */
export function getAnyLLMProviders(): string[] {
  return getSupportedProviders();
}

