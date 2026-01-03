/**
 * Provider registry for any-llm.
 * 
 * Handles dynamic provider loading and instantiation.
 */

import type { BaseProvider, ProviderConstructor } from './providers/base.js';
import type { LLMProviderType, ParsedModel, ProviderConfig } from './types.js';
import { UnsupportedProviderError } from './errors.js';

/**
 * Registry of provider constructors.
 */
const providerRegistry = new Map<string, ProviderConstructor>();

/**
 * Cache of provider instances (for reuse).
 */
const providerCache = new Map<string, BaseProvider>();

/**
 * Register a provider.
 * 
 * @param name - Provider identifier
 * @param constructor - Provider constructor
 */
export function registerProvider(name: string, constructor: ProviderConstructor): void {
  providerRegistry.set(name.toLowerCase(), constructor);
}

/**
 * Get a registered provider constructor.
 * 
 * @param name - Provider identifier
 * @returns The provider constructor, or undefined if not found
 */
export function getProviderConstructor(name: string): ProviderConstructor | undefined {
  return providerRegistry.get(name.toLowerCase());
}

/**
 * Check if a provider is registered.
 * 
 * @param name - Provider identifier
 * @returns True if the provider is registered
 */
export function hasProvider(name: string): boolean {
  return providerRegistry.has(name.toLowerCase());
}

/**
 * Get all registered provider names.
 * 
 * @returns Array of provider names
 */
export function getRegisteredProviders(): string[] {
  return Array.from(providerRegistry.keys());
}

/**
 * Create a provider instance.
 * 
 * @param name - Provider identifier
 * @param config - Provider configuration
 * @param useCache - Whether to use cached instances (default: false)
 * @returns Provider instance
 * @throws UnsupportedProviderError if provider is not registered
 */
export function createProvider(
  name: string,
  config: ProviderConfig = {},
  useCache: boolean = false,
): BaseProvider {
  const normalizedName = name.toLowerCase();
  
  // Check cache first
  if (useCache) {
    const cacheKey = `${normalizedName}:${JSON.stringify(config)}`;
    const cached = providerCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }
  
  // Get constructor
  const Constructor = providerRegistry.get(normalizedName);
  if (!Constructor) {
    throw new UnsupportedProviderError(name, getRegisteredProviders());
  }
  
  // Create instance
  const provider = new Constructor(config);
  
  // Cache if requested
  if (useCache) {
    const cacheKey = `${normalizedName}:${JSON.stringify(config)}`;
    providerCache.set(cacheKey, provider);
  }
  
  return provider;
}

/**
 * Clear the provider cache.
 */
export function clearProviderCache(): void {
  providerCache.clear();
}

/**
 * Parse a model string into provider and model parts.
 * 
 * Supports formats:
 * - "provider:model" (new format, recommended)
 * - "provider/model" (legacy format)
 * - "model" (requires separate provider parameter)
 * 
 * @param model - The model string
 * @returns Parsed model parts, or null if no provider prefix
 */
export function parseModelString(model: string): ParsedModel | null {
  // Check for colon format first (preferred)
  const colonIndex = model.indexOf(':');
  if (colonIndex !== -1) {
    const provider = model.substring(0, colonIndex);
    const modelId = model.substring(colonIndex + 1);
    if (provider && modelId) {
      return { provider: provider.toLowerCase(), model: modelId };
    }
  }
  
  // Check for slash format (legacy)
  const slashIndex = model.indexOf('/');
  if (slashIndex !== -1) {
    // Only treat as provider/model if the first part looks like a provider name
    // (not a model family like "meta-llama/...")
    const potentialProvider = model.substring(0, slashIndex).toLowerCase();
    if (hasProvider(potentialProvider)) {
      const modelId = model.substring(slashIndex + 1);
      if (modelId) {
        return { provider: potentialProvider, model: modelId };
      }
    }
  }
  
  // No provider prefix found
  return null;
}

/**
 * Resolve provider and model from request parameters.
 * 
 * @param model - Model string (may include provider prefix)
 * @param provider - Explicit provider (optional)
 * @returns Resolved provider and model
 * @throws Error if provider cannot be determined
 */
export function resolveProviderAndModel(
  model: string,
  provider?: LLMProviderType | string,
): ParsedModel {
  // If explicit provider is given, use it
  if (provider) {
    return {
      provider: provider.toLowerCase(),
      model: model,
    };
  }
  
  // Try to parse from model string
  const parsed = parseModelString(model);
  if (parsed) {
    return parsed;
  }
  
  // Cannot determine provider
  throw new Error(
    `Cannot determine provider for model '${model}'. ` +
    `Use 'provider:model' format or pass explicit provider parameter.`
  );
}

/**
 * Get a provider instance, resolving from model string if needed.
 * 
 * @param model - Model string (may include provider prefix)
 * @param provider - Explicit provider (optional)
 * @param config - Provider configuration
 * @returns Object with provider instance and resolved model name
 */
export function getProviderForModel(
  model: string,
  provider?: LLMProviderType | string,
  config?: ProviderConfig,
): { provider: BaseProvider; model: string } {
  const resolved = resolveProviderAndModel(model, provider);
  return {
    provider: createProvider(resolved.provider, config),
    model: resolved.model,
  };
}

