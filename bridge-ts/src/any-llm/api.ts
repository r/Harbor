/**
 * Main API for any-llm.
 * 
 * Provides both function-based and class-based interfaces for LLM completions.
 * Follows the patterns from mozilla-ai/any-llm.
 */

import {
  registerProvider,
  createProvider,
  resolveProviderAndModel,
  getRegisteredProviders,
  hasProvider,
  parseModelString,
} from './registry.js';
import { BaseProvider } from './providers/base.js';
import { OllamaProvider } from './providers/ollama.js';
import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { LlamafileProvider } from './providers/llamafile.js';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  CompletionRequest,
  LLMProviderType,
  ModelInfo,
  ProviderConfig,
  ProviderStatus,
} from './types.js';

// =============================================================================
// Provider Registration
// =============================================================================

// Register built-in providers
registerProvider('ollama', OllamaProvider);
registerProvider('openai', OpenAIProvider);
registerProvider('anthropic', AnthropicProvider);
registerProvider('llamafile', LlamafileProvider);

// =============================================================================
// Direct API Functions
// =============================================================================

/**
 * Create a chat completion.
 * 
 * This is the simplest way to make an LLM request. A new provider instance
 * is created for each call (stateless).
 * 
 * @example
 * ```typescript
 * // With provider:model format
 * const response = await completion({
 *   model: 'openai:gpt-4o',
 *   messages: [{ role: 'user', content: 'Hello!' }],
 * });
 * 
 * // With separate provider parameter
 * const response = await completion({
 *   model: 'gpt-4o',
 *   provider: 'openai',
 *   messages: [{ role: 'user', content: 'Hello!' }],
 * });
 * ```
 */
export async function completion(request: CompletionRequest): Promise<ChatCompletion> {
  const resolved = resolveProviderAndModel(request.model, request.provider);
  
  const config: ProviderConfig = {};
  if (request.api_key) config.apiKey = request.api_key;
  if (request.api_base) config.baseUrl = request.api_base;
  
  const provider = createProvider(resolved.provider, config);
  
  // Update request with resolved model
  const resolvedRequest: CompletionRequest = {
    ...request,
    model: resolved.model,
    stream: false, // Non-streaming version
  };
  
  return provider.completion(resolvedRequest);
}

/**
 * Create a streaming chat completion.
 * 
 * Returns an async iterable of completion chunks.
 * 
 * @example
 * ```typescript
 * for await (const chunk of completionStream({
 *   model: 'openai:gpt-4o',
 *   messages: [{ role: 'user', content: 'Hello!' }],
 * })) {
 *   process.stdout.write(chunk.choices[0].delta.content || '');
 * }
 * ```
 */
export async function* completionStream(
  request: CompletionRequest
): AsyncIterable<ChatCompletionChunk> {
  const resolved = resolveProviderAndModel(request.model, request.provider);
  
  const config: ProviderConfig = {};
  if (request.api_key) config.apiKey = request.api_key;
  if (request.api_base) config.baseUrl = request.api_base;
  
  const provider = createProvider(resolved.provider, config);
  
  const resolvedRequest: CompletionRequest = {
    ...request,
    model: resolved.model,
    stream: true,
  };
  
  yield* provider.completionStream(resolvedRequest);
}

/**
 * List available models from a provider.
 */
export async function listModels(
  provider: LLMProviderType | string,
  config?: ProviderConfig,
): Promise<ModelInfo[]> {
  const instance = createProvider(provider, config);
  return instance.listModels();
}

/**
 * Check if a provider is available.
 */
export async function checkProvider(
  provider: LLMProviderType | string,
  config?: ProviderConfig,
): Promise<ProviderStatus> {
  try {
    const instance = createProvider(provider, config);
    const available = await instance.isAvailable();
    
    let models: ModelInfo[] | undefined;
    if (available && instance.SUPPORTS_LIST_MODELS) {
      try {
        models = await instance.listModels();
      } catch {
        // Ignore model listing errors
      }
    }
    
    return {
      provider: instance.PROVIDER_NAME,
      available,
      models,
    };
  } catch (error) {
    return {
      provider: provider.toLowerCase(),
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get list of supported provider names.
 */
export function getSupportedProviders(): string[] {
  return getRegisteredProviders();
}

// =============================================================================
// Class-based API
// =============================================================================

/**
 * AnyLLM class for working with LLM providers.
 * 
 * Use this when you need to reuse a provider instance or want more control.
 * 
 * @example
 * ```typescript
 * const llm = AnyLLM.create('openai', { apiKey: 'sk-...' });
 * 
 * const response = await llm.completion({
 *   model: 'gpt-4o',
 *   messages: [{ role: 'user', content: 'Hello!' }],
 * });
 * ```
 */
export class AnyLLM {
  private provider: BaseProvider;
  private providerName: string;
  
  private constructor(provider: BaseProvider, providerName: string) {
    this.provider = provider;
    this.providerName = providerName;
  }
  
  /**
   * Create an AnyLLM instance for a provider.
   */
  static create(provider: LLMProviderType | string, config?: ProviderConfig): AnyLLM {
    const instance = createProvider(provider, config);
    return new AnyLLM(instance, provider);
  }
  
  /**
   * Get list of supported providers.
   */
  static getSupportedProviders(): string[] {
    return getRegisteredProviders();
  }
  
  /**
   * Check if a provider is supported.
   */
  static hasProvider(name: string): boolean {
    return hasProvider(name);
  }
  
  /**
   * Parse a model string into provider and model parts.
   */
  static parseModelString(model: string): { provider: string; model: string } | null {
    return parseModelString(model);
  }
  
  /**
   * Get the provider name.
   */
  get name(): string {
    return this.providerName;
  }
  
  /**
   * Check if this provider is available.
   */
  async isAvailable(): Promise<boolean> {
    return this.provider.isAvailable();
  }
  
  /**
   * List available models.
   */
  async listModels(): Promise<ModelInfo[]> {
    return this.provider.listModels();
  }
  
  /**
   * Create a chat completion.
   * 
   * Note: The model parameter should NOT include a provider prefix.
   */
  async completion(
    request: Omit<CompletionRequest, 'provider' | 'api_key' | 'api_base'>
  ): Promise<ChatCompletion> {
    return this.provider.completion({
      ...request,
      stream: false,
    });
  }
  
  /**
   * Create a streaming chat completion.
   */
  async *completionStream(
    request: Omit<CompletionRequest, 'provider' | 'api_key' | 'api_base'>
  ): AsyncIterable<ChatCompletionChunk> {
    yield* this.provider.completionStream({
      ...request,
      stream: true,
    });
  }
}

