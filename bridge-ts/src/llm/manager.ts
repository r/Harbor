/**
 * LLM Manager - detects and manages LLM providers.
 * 
 * Supports both local and remote providers through the any-llm library:
 * - Local: Ollama (localhost:11434), llamafile (localhost:8080)
 * - Remote: OpenAI, Anthropic, Mistral, Groq
 * 
 * Remote providers require API keys which are stored securely via the
 * credential store.
 */

import { log } from '../native-messaging.js';
import {
  LLMProvider,
  LLMProviderStatus,
  LLMProviderConfig,
  LLMModel,
  ChatRequest,
  ChatResponse,
  ChatChunk,
} from './provider.js';
import { AnyLLMAdapter, createAnyLLMAdapter, getAnyLLMProviders } from './any-llm-adapter.js';
import type { LLMProviderType, ProviderConfig } from 'any-llm-ts';

// =============================================================================
// Provider Configuration
// =============================================================================

/** Local providers that don't require API keys */
const LOCAL_PROVIDERS: LLMProviderType[] = ['ollama', 'llamafile'];

/** Remote providers that require API keys */
const REMOTE_PROVIDERS: LLMProviderType[] = ['openai', 'anthropic', 'mistral', 'groq'];

/** Default URLs for local providers */
const DEFAULT_URLS: Record<string, string> = {
  ollama: 'http://localhost:11434',
  llamafile: 'http://localhost:8080',
};

/** Environment variable names for API keys */
const API_KEY_ENV_VARS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY',
};

/** Default models for each provider */
const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-20241022',
  mistral: 'mistral-large-latest',
  groq: 'llama-3.1-70b-versatile',
  ollama: 'llama3.2',
  llamafile: 'default',
};

// =============================================================================
// LLM Manager
// =============================================================================

/**
 * Manages LLM providers with support for both local and remote services.
 * 
 * Key features:
 * - Automatic detection of local providers (Ollama, llamafile)
 * - API key management for remote providers
 * - Provider switching and model selection
 * - Proxy for chat requests
 */
export class LLMManager {
  private providers: Map<string, AnyLLMAdapter> = new Map();
  private providerStatus: Map<string, LLMProviderStatus> = new Map();
  private activeProviderId: string | null = null;
  private activeModelId: string | null = null;
  
  // API key storage (in-memory, populated from credential store)
  private apiKeys: Map<string, string> = new Map();
  
  // Custom configurations per provider
  private providerConfigs: Map<string, ProviderConfig> = new Map();

  constructor() {
    // Register local providers by default
    this.registerLocalProviders();
  }

  /**
   * Register the default local providers.
   */
  private registerLocalProviders(): void {
    for (const providerType of LOCAL_PROVIDERS) {
      const config: ProviderConfig = {
        baseUrl: DEFAULT_URLS[providerType],
      };
      this.registerProvider(providerType, config);
    }
  }

  /**
   * Register a provider.
   */
  registerProvider(
    providerType: LLMProviderType,
    config: ProviderConfig = {},
  ): void {
    // Merge with stored API key if available
    const apiKey = this.apiKeys.get(providerType) || config.apiKey;
    const fullConfig: ProviderConfig = {
      ...config,
      apiKey,
    };
    
    const adapter = createAnyLLMAdapter(providerType, fullConfig);
    this.providers.set(providerType, adapter);
    this.providerConfigs.set(providerType, fullConfig);
    
    log(`[LLMManager] Registered provider: ${providerType}`);
  }

  /**
   * Set an API key for a remote provider.
   * This will register the provider if not already registered.
   */
  setApiKey(providerType: string, apiKey: string): void {
    this.apiKeys.set(providerType, apiKey);
    
    // Re-register or register the provider with the new key
    const existingConfig = this.providerConfigs.get(providerType) || {};
    this.registerProvider(providerType as LLMProviderType, {
      ...existingConfig,
      apiKey,
    });
    
    log(`[LLMManager] API key set for: ${providerType}`);
  }

  /**
   * Remove an API key for a provider.
   */
  removeApiKey(providerType: string): void {
    this.apiKeys.delete(providerType);
    
    // Remove the provider if it's a remote one
    if (REMOTE_PROVIDERS.includes(providerType as LLMProviderType)) {
      this.providers.delete(providerType);
      this.providerStatus.delete(providerType);
      this.providerConfigs.delete(providerType);
      
      if (this.activeProviderId === providerType) {
        this.activeProviderId = null;
        this.activeModelId = null;
      }
    }
    
    log(`[LLMManager] API key removed for: ${providerType}`);
  }

  /**
   * Check if a provider has an API key configured.
   */
  hasApiKey(providerType: string): boolean {
    return this.apiKeys.has(providerType);
  }

  /**
   * Get list of configured API keys (provider names only).
   */
  getConfiguredApiKeys(): string[] {
    return Array.from(this.apiKeys.keys());
  }

  /**
   * Get all supported provider types.
   */
  getSupportedProviders(): { local: string[]; remote: string[] } {
    return {
      local: [...LOCAL_PROVIDERS],
      remote: [...REMOTE_PROVIDERS],
    };
  }

  /**
   * Detect all available providers.
   */
  async detectAll(): Promise<LLMProviderStatus[]> {
    const results: LLMProviderStatus[] = [];

    for (const [id, adapter] of this.providers) {
      try {
        log(`[LLMManager] Detecting ${id}...`);
        const available = await adapter.detect();

        let models: LLMModel[] | undefined;
        if (available) {
          try {
            models = await adapter.listModels();
          } catch {
            // Models listing failed, but provider is still available
          }
        }

        const status: LLMProviderStatus = {
          id: adapter.id,
          name: adapter.name,
          available,
          baseUrl: adapter.baseUrl,
          models,
          checkedAt: Date.now(),
        };

        // Add version and tool support info
        if (available) {
          if (adapter.version) {
            status.version = adapter.version;
          }
          status.supportsTools = adapter.supportsTools;
        }

        this.providerStatus.set(id, status);
        results.push(status);

        // Auto-select first available provider if none is active
        if (available && !this.activeProviderId) {
          this.activeProviderId = id;
          
          // Set default model
          if (models && models.length > 0) {
            const toolModel = models.find(m => m.supportsTools);
            this.activeModelId = toolModel?.id || models[0].id;
          } else {
            this.activeModelId = DEFAULT_MODELS[id] || null;
          }
          
          log(`[LLMManager] Auto-selected provider: ${id}, model: ${this.activeModelId}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[LLMManager] Detection failed for ${id}: ${message}`);

        const adapter = this.providers.get(id)!;
        const status: LLMProviderStatus = {
          id: adapter.id,
          name: adapter.name,
          available: false,
          baseUrl: adapter.baseUrl,
          error: message,
          checkedAt: Date.now(),
        };

        this.providerStatus.set(id, status);
        results.push(status);
      }
    }

    return results;
  }

  /**
   * Get status of all providers (from cache).
   */
  getAllStatus(): LLMProviderStatus[] {
    return Array.from(this.providerStatus.values());
  }

  /**
   * Get status of a specific provider.
   */
  getStatus(providerId: string): LLMProviderStatus | undefined {
    return this.providerStatus.get(providerId);
  }

  /**
   * Get available providers (from cache).
   */
  getAvailableProviders(): LLMProviderStatus[] {
    return this.getAllStatus().filter(s => s.available);
  }

  /**
   * Set the active provider.
   */
  setActive(providerId: string, modelId?: string): boolean {
    if (!this.providers.has(providerId)) {
      log(`[LLMManager] Unknown provider: ${providerId}`);
      return false;
    }

    const status = this.providerStatus.get(providerId);
    if (!status?.available) {
      log(`[LLMManager] Provider not available: ${providerId}`);
      return false;
    }

    this.activeProviderId = providerId;
    
    if (modelId) {
      this.activeModelId = modelId;
    } else if (status.models && status.models.length > 0) {
      // Select best available model
      const toolModel = status.models.find(m => m.supportsTools);
      this.activeModelId = toolModel?.id || status.models[0].id;
    } else {
      this.activeModelId = DEFAULT_MODELS[providerId] || null;
    }
    
    log(`[LLMManager] Active provider set to: ${providerId}, model: ${this.activeModelId}`);
    return true;
  }

  /**
   * Set the active model.
   */
  setActiveModel(modelId: string): boolean {
    if (!this.activeProviderId) {
      log('[LLMManager] No active provider to set model for');
      return false;
    }
    
    this.activeModelId = modelId;
    log(`[LLMManager] Active model set to: ${modelId}`);
    return true;
  }

  /**
   * Get the active provider.
   */
  getActive(): LLMProvider | null {
    if (!this.activeProviderId) {
      return null;
    }
    return this.providers.get(this.activeProviderId) || null;
  }

  /**
   * Get the active provider ID.
   */
  getActiveId(): string | null {
    return this.activeProviderId;
  }

  /**
   * Get the active model ID.
   */
  getActiveModelId(): string | null {
    return this.activeModelId;
  }

  /**
   * Get the active provider status.
   */
  getActiveStatus(): LLMProviderStatus | null {
    if (!this.activeProviderId) {
      return null;
    }
    return this.providerStatus.get(this.activeProviderId) || null;
  }

  /**
   * List models from the active provider.
   */
  async listModels(): Promise<LLMModel[]> {
    const provider = this.getActive();
    if (!provider) {
      log('[LLMManager] No active provider for listModels');
      return [];
    }

    try {
      return await provider.listModels();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[LLMManager] listModels failed: ${message}`);
      return [];
    }
  }

  /**
   * List models from a specific provider.
   */
  async listModelsFor(providerId: string): Promise<LLMModel[]> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      log(`[LLMManager] Unknown provider for listModels: ${providerId}`);
      return [];
    }

    try {
      return await provider.listModels();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[LLMManager] listModels failed for ${providerId}: ${message}`);
      return [];
    }
  }

  /**
   * Send a chat request to the active provider.
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const provider = this.getActive();
    if (!provider) {
      return {
        message: { role: 'assistant', content: '' },
        finishReason: 'error',
        error: 'No LLM provider available. Configure a provider first.',
      };
    }

    // Use active model if not specified
    const chatRequest = {
      ...request,
      model: request.model || this.activeModelId || undefined,
    };

    try {
      return await provider.chat(chatRequest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[LLMManager] chat failed: ${message}`);
      return {
        message: { role: 'assistant', content: '' },
        finishReason: 'error',
        error: message,
      };
    }
  }

  /**
   * Stream a chat request from the active provider.
   */
  async *chatStream(request: ChatRequest): AsyncIterable<ChatChunk> {
    const provider = this.getActive();
    if (!provider) {
      yield {
        delta: { content: '' },
        finishReason: 'error',
      };
      return;
    }

    // Use active model if not specified
    const chatRequest = {
      ...request,
      model: request.model || this.activeModelId || undefined,
    };

    if (!provider.chatStream) {
      // Fall back to non-streaming
      const response = await provider.chat(chatRequest);
      yield {
        delta: response.message,
        finishReason: response.finishReason,
      };
      return;
    }

    try {
      for await (const chunk of provider.chatStream(chatRequest)) {
        yield chunk;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[LLMManager] chatStream failed: ${message}`);
      yield {
        delta: { content: '' },
        finishReason: 'error',
      };
    }
  }

  /**
   * Check if any provider is available.
   */
  hasAvailableProvider(): boolean {
    return this.getAvailableProviders().length > 0;
  }

  /**
   * Get a summary for debugging.
   */
  getSummary(): {
    providers: number;
    available: number;
    activeProvider: string | null;
    activeModel: string | null;
    configuredApiKeys: string[];
  } {
    return {
      providers: this.providers.size,
      available: this.getAvailableProviders().length,
      activeProvider: this.activeProviderId,
      activeModel: this.activeModelId,
      configuredApiKeys: this.getConfiguredApiKeys(),
    };
  }
}

// Singleton instance
let _manager: LLMManager | null = null;

export function getLLMManager(): LLMManager {
  if (!_manager) {
    _manager = new LLMManager();
  }
  return _manager;
}

// Re-export types for convenience
export type { LLMProviderType, ProviderConfig };
export { LOCAL_PROVIDERS, REMOTE_PROVIDERS, API_KEY_ENV_VARS, DEFAULT_MODELS };
