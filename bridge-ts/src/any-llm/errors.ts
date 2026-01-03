/**
 * Error types for any-llm.
 * 
 * Provides structured errors following the patterns from mozilla-ai/any-llm.
 */

import { AnyLLMError, AnyLLMErrorCode } from './types.js';

/**
 * Error thrown when an API key is missing.
 */
export class MissingApiKeyError extends AnyLLMError {
  constructor(provider: string, envKey: string) {
    super(
      `API key not found for provider '${provider}'. ` +
      `Please set the ${envKey} environment variable or pass api_key in the request.`,
      AnyLLMErrorCode.MissingApiKey,
      provider,
    );
    this.name = 'MissingApiKeyError';
  }
}

/**
 * Error thrown when a provider is not supported.
 */
export class UnsupportedProviderError extends AnyLLMError {
  constructor(provider: string, supported: string[]) {
    super(
      `Provider '${provider}' is not supported. ` +
      `Supported providers: ${supported.join(', ')}`,
      AnyLLMErrorCode.UnsupportedProvider,
    );
    this.name = 'UnsupportedProviderError';
  }
}

/**
 * Error thrown when a request to a provider fails.
 */
export class ProviderRequestError extends AnyLLMError {
  constructor(
    provider: string,
    message: string,
    statusCode?: number,
    cause?: Error,
  ) {
    super(
      `Request to ${provider} failed: ${message}`,
      AnyLLMErrorCode.RequestFailed,
      provider,
      statusCode,
      cause,
    );
    this.name = 'ProviderRequestError';
  }
}

/**
 * Error thrown when a provider is rate limited.
 */
export class RateLimitError extends AnyLLMError {
  constructor(
    provider: string,
    retryAfter?: number,
  ) {
    const message = retryAfter 
      ? `Rate limited by ${provider}. Retry after ${retryAfter} seconds.`
      : `Rate limited by ${provider}.`;
    super(message, AnyLLMErrorCode.RateLimited, provider, 429);
    this.name = 'RateLimitError';
  }
}

/**
 * Error thrown when a provider is unavailable.
 */
export class ProviderUnavailableError extends AnyLLMError {
  constructor(provider: string, reason?: string) {
    super(
      reason 
        ? `Provider '${provider}' is unavailable: ${reason}`
        : `Provider '${provider}' is unavailable`,
      AnyLLMErrorCode.ProviderUnavailable,
      provider,
    );
    this.name = 'ProviderUnavailableError';
  }
}

/**
 * Error thrown when a request times out.
 */
export class TimeoutError extends AnyLLMError {
  constructor(provider: string, timeoutMs: number) {
    super(
      `Request to ${provider} timed out after ${timeoutMs}ms`,
      AnyLLMErrorCode.Timeout,
      provider,
    );
    this.name = 'TimeoutError';
  }
}

/**
 * Check if an error is an any-llm error.
 */
export function isAnyLLMError(error: unknown): error is AnyLLMError {
  return error instanceof AnyLLMError;
}

/**
 * Check if an error indicates rate limiting.
 */
export function isRateLimitError(error: unknown): error is RateLimitError {
  return error instanceof RateLimitError;
}

/**
 * Wrap an unknown error into an AnyLLMError.
 */
export function wrapError(error: unknown, provider: string): AnyLLMError {
  if (error instanceof AnyLLMError) {
    return error;
  }
  
  if (error instanceof Error) {
    // Check for common error patterns
    const message = error.message.toLowerCase();
    
    if (message.includes('rate limit') || message.includes('too many requests')) {
      return new RateLimitError(provider);
    }
    
    if (message.includes('unauthorized') || message.includes('invalid api key')) {
      return new MissingApiKeyError(provider, `${provider.toUpperCase()}_API_KEY`);
    }
    
    if (message.includes('timeout') || message.includes('timed out')) {
      return new TimeoutError(provider, 0);
    }
    
    return new ProviderRequestError(provider, error.message, undefined, error);
  }
  
  return new ProviderRequestError(
    provider,
    String(error),
  );
}

