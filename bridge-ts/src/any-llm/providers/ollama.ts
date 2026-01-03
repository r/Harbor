/**
 * Ollama LLM Provider for any-llm.
 * 
 * Ollama runs locally and provides an OpenAI-compatible API.
 * This provider uses the native Ollama API for better control.
 * 
 * @see https://github.com/ollama/ollama
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
  ToolCall,
} from '../types.js';
import { ProviderRequestError, ProviderUnavailableError, TimeoutError } from '../errors.js';

// =============================================================================
// Ollama API Types
// =============================================================================

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  stream?: boolean;
  options?: {
    temperature?: number;
    top_p?: number;
    num_predict?: number;
    stop?: string[];
    seed?: number;
  };
}

interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaModelsResponse {
  models: Array<{
    name: string;
    model: string;
    modified_at: string;
    size: number;
    digest: string;
  }>;
}

interface OllamaVersionResponse {
  version: string;
}

// Minimum Ollama version for tool calling support
const MINIMUM_TOOL_VERSION = '0.3.0';

// =============================================================================
// Ollama Provider Implementation
// =============================================================================

export class OllamaProvider extends BaseProvider {
  readonly PROVIDER_NAME = 'ollama';
  readonly ENV_API_KEY_NAME = 'OLLAMA_API_KEY'; // Optional
  readonly PROVIDER_DOCUMENTATION_URL = 'https://github.com/ollama/ollama';
  readonly API_BASE = 'http://localhost:11434';
  
  readonly SUPPORTS_STREAMING = true;
  readonly SUPPORTS_TOOLS = true;
  readonly SUPPORTS_VISION = true;
  readonly SUPPORTS_LIST_MODELS = true;
  readonly SUPPORTS_REASONING = true;
  
  private timeout: number;
  private version: string | null = null;
  private toolsSupported: boolean | null = null;
  
  constructor(config: ProviderConfig = {}) {
    super(config);
    this.init();
    this.timeout = config.timeout ?? 120000; // Ollama can be slow
  }
  
  /**
   * Ollama doesn't require an API key.
   */
  protected requiresApiKey(): boolean {
    return false;
  }
  
  /**
   * Compare semantic versions.
   */
  private compareVersions(a: string, b: string): number {
    const partsA = a.replace(/^v/, '').split('.').map(p => parseInt(p, 10) || 0);
    const partsB = b.replace(/^v/, '').split('.').map(p => parseInt(p, 10) || 0);
    
    const maxLen = Math.max(partsA.length, partsB.length);
    for (let i = 0; i < maxLen; i++) {
      const numA = partsA[i] || 0;
      const numB = partsB[i] || 0;
      if (numA !== numB) return numA - numB;
    }
    return 0;
  }
  
  /**
   * Fetch the Ollama version.
   */
  private async fetchVersion(): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${this.baseUrl}/api/version`, {
        method: 'GET',
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) return null;
      
      const data = await response.json() as OllamaVersionResponse;
      return data.version || null;
    } catch {
      return null;
    }
  }
  
  /**
   * Check if Ollama is available.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        // Check version for tool support
        this.version = await this.fetchVersion();
        if (this.version) {
          this.toolsSupported = this.compareVersions(this.version, MINIMUM_TOOL_VERSION) >= 0;
        } else {
          this.toolsSupported = true; // Assume support if we can't determine
        }
        return true;
      }
      
      return false;
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
      
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new ProviderRequestError(this.PROVIDER_NAME, `HTTP ${response.status}`);
      }
      
      const data = await response.json() as OllamaModelsResponse;
      
      return data.models.map(model => ({
        id: model.name,
        object: 'model' as const,
        owned_by: 'ollama',
        provider: 'ollama',
        supports_tools: this.modelSupportsTools(model.name),
        supports_vision: this.modelSupportsVision(model.name),
      }));
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new ProviderUnavailableError(this.PROVIDER_NAME, 'Failed to list models');
    }
  }
  
  /**
   * Check if a model supports tools (heuristic).
   */
  private modelSupportsTools(modelName: string): boolean {
    const toolModels = [
      'llama3', 'llama3.1', 'llama3.2', 'llama3.3',
      'mistral', 'mixtral',
      'qwen', 'qwen2', 'qwen2.5',
      'phi3', 'phi4',
      'granite',
      'command-r',
    ];
    return toolModels.some(m => modelName.toLowerCase().includes(m));
  }
  
  /**
   * Check if a model supports vision (heuristic).
   */
  private modelSupportsVision(modelName: string): boolean {
    const visionModels = [
      'llava',
      'bakllava',
      'llama3.2-vision',
      'moondream',
    ];
    return visionModels.some(m => modelName.toLowerCase().includes(m));
  }
  
  /**
   * Convert messages to Ollama format.
   */
  private convertMessages(messages: Message[]): OllamaMessage[] {
    return messages.map(msg => {
      const ollamaMsg: OllamaMessage = {
        role: msg.role,
        content: '',
      };
      
      // Handle content
      if (typeof msg.content === 'string') {
        ollamaMsg.content = msg.content;
      } else if (Array.isArray(msg.content)) {
        // Handle multimodal content
        const textParts: string[] = [];
        const images: string[] = [];
        
        for (const part of msg.content) {
          if (part.type === 'text') {
            textParts.push(part.text);
          } else if (part.type === 'image_url') {
            const url = part.image_url.url;
            if (url.startsWith('data:image/')) {
              // Extract base64 data
              const base64 = url.split(',')[1];
              if (base64) images.push(base64);
            }
          }
        }
        
        ollamaMsg.content = textParts.join(' ');
        if (images.length > 0) {
          ollamaMsg.images = images;
        }
      } else if (msg.content === null) {
        ollamaMsg.content = '';
      }
      
      // Handle tool calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        ollamaMsg.tool_calls = msg.tool_calls.map(tc => ({
          id: tc.id,
          function: {
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments),
          },
        }));
      }
      
      return ollamaMsg;
    });
  }
  
  /**
   * Convert tools to Ollama format.
   */
  private convertTools(tools: Tool[]): OllamaTool[] {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description || '',
        parameters: tool.function.parameters,
      },
    }));
  }
  
  /**
   * Convert Ollama response to OpenAI format.
   */
  private convertResponse(response: OllamaChatResponse, model: string): ChatCompletion {
    const message: Message = {
      role: response.message.role,
      content: response.message.content || null,
    };
    
    // Convert tool calls
    if (response.message.tool_calls && response.message.tool_calls.length > 0) {
      message.tool_calls = response.message.tool_calls.map((tc, i) => ({
        id: tc.id || `call_${i}`,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments),
        },
      }));
    }
    
    // Determine finish reason
    let finishReason: CompletionChoice['finish_reason'] = 'stop';
    if (message.tool_calls && message.tool_calls.length > 0) {
      finishReason = 'tool_calls';
    }
    
    return {
      id: `ollama-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: response.model || model,
      provider: 'ollama',
      choices: [{
        index: 0,
        message,
        finish_reason: finishReason,
      }],
      usage: {
        prompt_tokens: response.prompt_eval_count || 0,
        completion_tokens: response.eval_count || 0,
        total_tokens: (response.prompt_eval_count || 0) + (response.eval_count || 0),
      },
    };
  }
  
  /**
   * Create a chat completion.
   */
  async completion(request: CompletionRequest): Promise<ChatCompletion> {
    const ollamaRequest: OllamaChatRequest = {
      model: request.model,
      messages: this.convertMessages(request.messages),
      stream: false,
    };
    
    // Add tools if provided
    if (request.tools && request.tools.length > 0) {
      if (this.toolsSupported === false) {
        throw new ProviderRequestError(
          this.PROVIDER_NAME,
          `Ollama version ${this.version} does not support tool calling. ` +
          `Upgrade to ${MINIMUM_TOOL_VERSION} or later.`
        );
      }
      ollamaRequest.tools = this.convertTools(request.tools);
    }
    
    // Add options
    ollamaRequest.options = {};
    if (request.temperature !== undefined) {
      ollamaRequest.options.temperature = request.temperature;
    }
    if (request.top_p !== undefined) {
      ollamaRequest.options.top_p = request.top_p;
    }
    if (request.max_tokens !== undefined) {
      ollamaRequest.options.num_predict = request.max_tokens;
    }
    if (request.stop) {
      ollamaRequest.options.stop = Array.isArray(request.stop) ? request.stop : [request.stop];
    }
    if (request.seed !== undefined) {
      ollamaRequest.options.seed = request.seed;
    }
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ollamaRequest),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new ProviderRequestError(this.PROVIDER_NAME, `HTTP ${response.status}: ${errorText}`, response.status);
      }
      
      const data = await response.json() as OllamaChatResponse;
      return this.convertResponse(data, request.model);
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
    const ollamaRequest: OllamaChatRequest = {
      model: request.model,
      messages: this.convertMessages(request.messages),
      stream: true,
    };
    
    // Add tools if provided
    if (request.tools && request.tools.length > 0) {
      if (this.toolsSupported === false) {
        throw new ProviderRequestError(
          this.PROVIDER_NAME,
          `Ollama version ${this.version} does not support tool calling.`
        );
      }
      ollamaRequest.tools = this.convertTools(request.tools);
    }
    
    // Add options
    ollamaRequest.options = {};
    if (request.temperature !== undefined) {
      ollamaRequest.options.temperature = request.temperature;
    }
    if (request.top_p !== undefined) {
      ollamaRequest.options.top_p = request.top_p;
    }
    if (request.max_tokens !== undefined) {
      ollamaRequest.options.num_predict = request.max_tokens;
    }
    
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ollamaRequest),
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
    const id = `ollama-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        // Ollama streams newline-delimited JSON
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (!line.trim()) continue;
          
          try {
            const chunk = JSON.parse(line) as OllamaChatResponse;
            
            const chunkChoice: ChunkChoice = {
              index: 0,
              delta: {
                content: chunk.message?.content || '',
              },
              finish_reason: chunk.done ? 'stop' : null,
            };
            
            // Include tool calls in delta if present
            if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
              chunkChoice.delta.tool_calls = chunk.message.tool_calls.map((tc, i) => ({
                id: tc.id || `call_${i}`,
                type: 'function' as const,
                function: {
                  name: tc.function.name,
                  arguments: JSON.stringify(tc.function.arguments),
                },
              }));
              if (chunk.done) {
                chunkChoice.finish_reason = 'tool_calls';
              }
            }
            
            yield {
              id,
              object: 'chat.completion.chunk' as const,
              created,
              model: chunk.model || request.model,
              choices: [chunkChoice],
            };
          } catch {
            // Skip invalid JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

