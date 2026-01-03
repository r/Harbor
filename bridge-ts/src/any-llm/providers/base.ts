/**
 * Base provider interface for any-llm.
 * 
 * All LLM providers must implement this interface.
 * Follows the patterns from mozilla-ai/any-llm.
 */

import type {
  ChatCompletion,
  ChatCompletionChunk,
  CompletionRequest,
  ModelInfo,
  ProviderConfig,
  ProviderMetadata,
} from '../types.js';

/**
 * Abstract base class for LLM providers.
 * 
 * Implementations should:
 * - Override the static metadata properties
 * - Implement the abstract methods
 * - Handle their own API key management
 */
export abstract class BaseProvider {
  // =========================================================================
  // Provider Metadata (override in subclasses)
  // =========================================================================
  
  /** Provider identifier (e.g., 'openai', 'anthropic') */
  abstract readonly PROVIDER_NAME: string;
  
  /** Environment variable name for the API key */
  abstract readonly ENV_API_KEY_NAME: string;
  
  /** URL to provider documentation */
  abstract readonly PROVIDER_DOCUMENTATION_URL: string;
  
  /** Default API base URL */
  abstract readonly API_BASE: string;
  
  // =========================================================================
  // Feature Flags (override in subclasses)
  // =========================================================================
  
  /** Whether provider supports streaming completions */
  readonly SUPPORTS_STREAMING: boolean = true;
  
  /** Whether provider supports tool/function calling */
  readonly SUPPORTS_TOOLS: boolean = true;
  
  /** Whether provider supports vision/image inputs */
  readonly SUPPORTS_VISION: boolean = false;
  
  /** Whether provider supports listing models */
  readonly SUPPORTS_LIST_MODELS: boolean = false;
  
  /** Whether provider exposes reasoning/thinking content */
  readonly SUPPORTS_REASONING: boolean = false;
  
  // =========================================================================
  // Instance Properties
  // =========================================================================
  
  /** Provider configuration */
  protected config: ProviderConfig;
  
  /** API key (resolved from config or environment) */
  protected apiKey: string | undefined;
  
  /** Base URL for API requests */
  protected baseUrl!: string;
  
  constructor(config: ProviderConfig = {}) {
    this.config = config;
    // Note: Subclasses must call initBaseUrl() after super() if they override API_BASE
  }
  
  /**
   * Initialize the base URL and API key.
   * Must be called by subclass constructors after setting API_BASE.
   */
  protected init(): void {
    this.baseUrl = this.config.baseUrl || this.API_BASE;
    this.apiKey = this.resolveApiKey(this.config.apiKey);
  }
  
  // =========================================================================
  // API Key Resolution
  // =========================================================================
  
  /**
   * Resolve the API key from config or environment.
   * Override in subclasses that don't require API keys (e.g., local providers).
   */
  protected resolveApiKey(configKey?: string): string | undefined {
    if (configKey) {
      return configKey;
    }
    
    // Try environment variable
    if (typeof process !== 'undefined' && process.env) {
      return process.env[this.ENV_API_KEY_NAME];
    }
    
    return undefined;
  }
  
  /**
   * Check if API key is required and present.
   * Override in subclasses that don't require API keys.
   */
  protected requiresApiKey(): boolean {
    return true;
  }
  
  /**
   * Validate that we have required configuration.
   */
  protected validateConfig(): void {
    if (this.requiresApiKey() && !this.apiKey) {
      throw new Error(
        `API key required for ${this.PROVIDER_NAME}. ` +
        `Set ${this.ENV_API_KEY_NAME} environment variable or pass apiKey in config.`
      );
    }
  }
  
  // =========================================================================
  // Metadata
  // =========================================================================
  
  /**
   * Get provider metadata.
   */
  getMetadata(): ProviderMetadata {
    return {
      name: this.PROVIDER_NAME,
      envKey: this.ENV_API_KEY_NAME,
      docUrl: this.PROVIDER_DOCUMENTATION_URL,
      streaming: this.SUPPORTS_STREAMING,
      reasoning: this.SUPPORTS_REASONING,
      completion: true,
      embedding: false,
      image: this.SUPPORTS_VISION,
      listModels: this.SUPPORTS_LIST_MODELS,
    };
  }
  
  // =========================================================================
  // Abstract Methods (must be implemented by subclasses)
  // =========================================================================
  
  /**
   * Create a chat completion.
   * 
   * @param request - The completion request
   * @returns The completion response
   */
  abstract completion(request: CompletionRequest): Promise<ChatCompletion>;
  
  /**
   * Create a streaming chat completion.
   * 
   * @param request - The completion request
   * @returns An async iterable of completion chunks
   */
  abstract completionStream(request: CompletionRequest): AsyncIterable<ChatCompletionChunk>;
  
  /**
   * Check if the provider is available.
   * For local providers, this checks if the service is running.
   * For remote providers, this validates the API key.
   */
  abstract isAvailable(): Promise<boolean>;
  
  // =========================================================================
  // Optional Methods (can be overridden)
  // =========================================================================
  
  /**
   * List available models from this provider.
   * Override in subclasses that support model listing.
   */
  async listModels(): Promise<ModelInfo[]> {
    if (!this.SUPPORTS_LIST_MODELS) {
      return [];
    }
    throw new Error(`listModels not implemented for ${this.PROVIDER_NAME}`);
  }
}

/**
 * Type for a provider constructor.
 */
export type ProviderConstructor = new (config?: ProviderConfig) => BaseProvider;

