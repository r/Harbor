/**
 * Ollama LLM Provider.
 * 
 * Ollama runs on localhost:11434 and provides an OpenAI-compatible API.
 * 
 * @see https://ollama.ai/
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

// Default Ollama endpoint
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

// Timeout for API calls (ms)
const API_TIMEOUT = 120000; // Ollama can be slow

// Minimum Ollama version for tool calling support (released July 25, 2024)
const MINIMUM_TOOL_VERSION = '0.3.0';

// Recommended Ollama version for reliable tool support
const RECOMMENDED_VERSION = '0.5.0';

/**
 * Compare two semantic version strings.
 * Returns: negative if a < b, 0 if a == b, positive if a > b
 */
function compareVersions(a: string, b: string): number {
  // Strip any leading 'v' and split into parts
  const partsA = a.replace(/^v/, '').split('.').map(p => parseInt(p, 10) || 0);
  const partsB = b.replace(/^v/, '').split('.').map(p => parseInt(p, 10) || 0);
  
  const maxLen = Math.max(partsA.length, partsB.length);
  
  for (let i = 0; i < maxLen; i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    
    if (numA !== numB) {
      return numA - numB;
    }
  }
  
  return 0;
}

// =============================================================================
// Ollama API Types
// =============================================================================

interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
}

interface OllamaModelsResponse {
  models: OllamaModel[];
}

interface OllamaVersionResponse {
  version: string;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
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
}

interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
}

// =============================================================================
// OllamaProvider Implementation
// =============================================================================

export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama';
  readonly name = 'Ollama';
  readonly baseUrl: string;

  private defaultModel: string | null = null;
  private cachedModels: LLMModel[] | null = null;
  private cachedVersion: string | null = null;
  private _supportsTools: boolean | null = null;

  constructor(baseUrl: string = DEFAULT_OLLAMA_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Get the detected Ollama version.
   */
  get version(): string | null {
    return this.cachedVersion;
  }

  /**
   * Check if this Ollama instance supports tool calling.
   */
  get supportsTools(): boolean {
    return this._supportsTools ?? false;
  }
  
  /**
   * Get the default model (first available, preferring capable ones).
   */
  private async getDefaultModel(): Promise<string> {
    if (this.defaultModel) {
      return this.defaultModel;
    }
    
    // Fetch models if not cached
    if (!this.cachedModels) {
      this.cachedModels = await this.listModels();
    }
    
    if (this.cachedModels.length === 0) {
      return 'llama3.2'; // Fallback
    }
    
    // Prefer models that support tools
    const toolModel = this.cachedModels.find(m => m.supportsTools);
    this.defaultModel = toolModel?.id || this.cachedModels[0].id;
    
    return this.defaultModel;
  }

  /**
   * Fetch the Ollama version from the API.
   */
  async fetchVersion(): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.baseUrl}/api/version`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as OllamaVersionResponse;
      return data.version || null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[OllamaProvider] Failed to fetch version: ${message}`);
      return null;
    }
  }

  /**
   * Check if Ollama is running and get version info.
   */
  async detect(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      // Ollama uses /api/tags for listing models
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        log('[OllamaProvider] Detected Ollama running');
        
        // Fetch and check version
        this.cachedVersion = await this.fetchVersion();
        if (this.cachedVersion) {
          this._supportsTools = compareVersions(this.cachedVersion, MINIMUM_TOOL_VERSION) >= 0;
          
          const meetsRecommended = compareVersions(this.cachedVersion, RECOMMENDED_VERSION) >= 0;
          
          log(`[OllamaProvider] Version: ${this.cachedVersion}`);
          log(`[OllamaProvider] Tool support: ${this._supportsTools ? 'yes' : 'no (version too old)'}`);
          
          if (this._supportsTools && !meetsRecommended) {
            log(`[OllamaProvider] Warning: Version ${this.cachedVersion} supports tools but ${RECOMMENDED_VERSION}+ is recommended for reliability`);
          }
          
          if (!this._supportsTools) {
            log(`[OllamaProvider] Warning: Version ${this.cachedVersion} does not support tool calling. Minimum required: ${MINIMUM_TOOL_VERSION}`);
          }
        } else {
          log('[OllamaProvider] Could not determine version, assuming tool support');
          this._supportsTools = true; // Assume support if we can't determine version
        }
        
        return true;
      }

      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[OllamaProvider] Not detected: ${message}`);
      return false;
    }
  }

  /**
   * List available models.
   */
  async listModels(): Promise<LLMModel[]> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as OllamaModelsResponse;

      return data.models.map(model => ({
        id: model.name,
        name: model.name,
        supportsTools: this.modelSupportsTools(model.name),
        provider: 'ollama',
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[OllamaProvider] Failed to list models: ${message}`);
      return [];
    }
  }

  /**
   * Check if a model supports tools (rough heuristic).
   */
  private modelSupportsTools(modelName: string): boolean {
    const toolModels = [
      'llama3', 'llama3.1', 'llama3.2',
      'mistral', 'mixtral',
      'qwen', 'qwen2',
      'phi3', 'phi4',
    ];
    return toolModels.some(m => modelName.toLowerCase().includes(m));
  }

  /**
   * Send a chat completion request.
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = request.model || await this.getDefaultModel();

    // Convert to Ollama format
    const ollamaRequest: OllamaChatRequest = {
      model,
      messages: this.convertMessages(request.messages, request.systemPrompt),
      stream: false,
    };

    // Check tool support before adding tools
    if (request.tools && request.tools.length > 0) {
      if (this._supportsTools === false) {
        log(`[OllamaProvider] Warning: Tools requested but Ollama version ${this.cachedVersion} does not support tool calling`);
        return {
          message: {
            role: 'assistant',
            content: '',
          },
          finishReason: 'error',
          error: `Ollama version ${this.cachedVersion} does not support tool calling. Please upgrade to ${MINIMUM_TOOL_VERSION} or later.`,
        };
      }
      ollamaRequest.tools = this.convertTools(request.tools);
    }

    log(`[OllamaProvider] Sending chat request with ${request.messages.length} messages to ${model}`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);

      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(ollamaRequest),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json() as OllamaChatResponse;
      const message = this.convertMessageFromOllama(data.message);

      log(`[OllamaProvider] Got response: done=${data.done}`);

      // Determine finish reason
      let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';
      if (message.toolCalls && message.toolCalls.length > 0) {
        finishReason = 'tool_calls';
      }

      return {
        message,
        finishReason,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[OllamaProvider] Chat failed: ${message}`);

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

  // ===========================================================================
  // Conversion Helpers
  // ===========================================================================

  private convertMessages(
    messages: ChatMessage[],
    systemPrompt?: string
  ): OllamaMessage[] {
    const result: OllamaMessage[] = [];

    // Add system prompt if provided
    if (systemPrompt && !messages.some(m => m.role === 'system')) {
      result.push({
        role: 'system',
        content: systemPrompt,
      });
    }

    for (const msg of messages) {
      const ollamaMsg: OllamaMessage = {
        role: msg.role,
        content: msg.content,
      };

      if (msg.toolCalls) {
        ollamaMsg.tool_calls = msg.toolCalls.map(tc => ({
          id: tc.id,
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        }));
      }

      result.push(ollamaMsg);
    }

    return result;
  }

  private convertMessageFromOllama(msg: OllamaMessage): ChatMessage {
    const result: ChatMessage = {
      role: msg.role,
      content: msg.content || '',
    };

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      result.toolCalls = msg.tool_calls.map((tc, i) => ({
        id: tc.id || `call_${i}`,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));
    }

    return result;
  }

  private convertTools(tools: ToolDefinition[]): OllamaTool[] {
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }
}

/**
 * Create an Ollama provider.
 */
export function createOllamaProvider(baseUrl?: string): OllamaProvider {
  return new OllamaProvider(baseUrl);
}

