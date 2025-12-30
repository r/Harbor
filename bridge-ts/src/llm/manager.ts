/**
 * LLM Manager - detects and manages LLM providers.
 * 
 * Currently supports:
 * - llamafile (localhost:8080)
 * 
 * Future:
 * - Ollama (localhost:11434)
 * - OpenAI API
 * - Anthropic API
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
import { LlamafileProvider } from './llamafile.js';
import { OllamaProvider } from './ollama.js';

// Default provider configurations
const DEFAULT_PROVIDERS: LLMProviderConfig[] = [
  {
    type: 'llamafile',
    baseUrl: 'http://localhost:8080',
  },
  {
    type: 'ollama',
    baseUrl: 'http://localhost:11434',
  },
];

/**
 * Manages LLM providers.
 * 
 * Responsibilities:
 * - Detect available providers
 * - Track which provider is active
 * - Proxy chat requests to the active provider
 */
export class LLMManager {
  private providers: Map<string, LLMProvider> = new Map();
  private providerStatus: Map<string, LLMProviderStatus> = new Map();
  private activeProviderId: string | null = null;

  constructor() {
    // Register built-in providers
    this.registerDefaultProviders();
  }

  private registerDefaultProviders(): void {
    for (const config of DEFAULT_PROVIDERS) {
      this.registerProviderFromConfig(config);
    }
  }

  private registerProviderFromConfig(config: LLMProviderConfig): void {
    let provider: LLMProvider | null = null;

    switch (config.type) {
      case 'llamafile':
        provider = new LlamafileProvider(config.baseUrl);
        break;
      case 'ollama':
        provider = new OllamaProvider(config.baseUrl);
        break;
    }

    if (provider) {
      this.providers.set(provider.id, provider);
      log(`[LLMManager] Registered provider: ${provider.id}`);
    }
  }

  /**
   * Register a custom provider.
   */
  registerProvider(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
    log(`[LLMManager] Registered custom provider: ${provider.id}`);
  }

  /**
   * Detect all available providers.
   */
  async detectAll(): Promise<LLMProviderStatus[]> {
    const results: LLMProviderStatus[] = [];

    for (const [id, provider] of this.providers) {
      try {
        log(`[LLMManager] Detecting ${id}...`);
        const available = await provider.detect();

        let models: LLMModel[] | undefined;
        if (available) {
          try {
            models = await provider.listModels();
          } catch {
            // Models listing failed, but provider is still available
          }
        }

        const status: LLMProviderStatus = {
          id: provider.id,
          name: provider.name,
          available,
          baseUrl: provider.baseUrl,
          models,
          checkedAt: Date.now(),
        };

        // Add Ollama-specific version and tool support info
        if (id === 'ollama' && available) {
          const ollamaProvider = provider as OllamaProvider;
          if (ollamaProvider.version) {
            status.version = ollamaProvider.version;
          }
          status.supportsTools = ollamaProvider.supportsTools;
          
          if (!ollamaProvider.supportsTools) {
            status.warning = `Ollama version ${ollamaProvider.version} does not support tool calling. Upgrade to 0.3.0 or later.`;
          }
        }

        this.providerStatus.set(id, status);
        results.push(status);

        // Auto-select first available provider if none is active
        if (available && !this.activeProviderId) {
          this.activeProviderId = id;
          log(`[LLMManager] Auto-selected provider: ${id}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[LLMManager] Detection failed for ${id}: ${message}`);

        const status: LLMProviderStatus = {
          id: provider.id,
          name: provider.name,
          available: false,
          baseUrl: provider.baseUrl,
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
  setActive(providerId: string): boolean {
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
    log(`[LLMManager] Active provider set to: ${providerId}`);
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
   * Send a chat request to the active provider.
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const provider = this.getActive();
    if (!provider) {
      return {
        message: { role: 'assistant', content: '' },
        finishReason: 'error',
        error: 'No LLM provider available. Is llamafile running?',
      };
    }

    try {
      return await provider.chat(request);
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

    if (!provider.chatStream) {
      // Fall back to non-streaming
      const response = await provider.chat(request);
      yield {
        delta: response.message,
        finishReason: response.finishReason,
      };
      return;
    }

    try {
      for await (const chunk of provider.chatStream(request)) {
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
    active: string | null;
  } {
    return {
      providers: this.providers.size,
      available: this.getAvailableProviders().length,
      active: this.activeProviderId,
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

