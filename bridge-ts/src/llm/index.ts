/**
 * LLM module - manages LLM providers and chat interactions.
 * 
 * Uses the any-llm library for unified access to both local and remote LLM providers:
 * - Local: Ollama, llamafile
 * - Remote: OpenAI, Anthropic, Mistral, Groq
 */

export * from './provider.js';
export { 
  LLMManager, 
  getLLMManager,
  LOCAL_PROVIDERS,
  REMOTE_PROVIDERS,
  API_KEY_ENV_VARS,
  DEFAULT_MODELS,
} from './manager.js';
export { 
  LLMSetupManager, 
  getLLMSetupManager,
  LLMSetupStatus,
  DownloadProgress,
  LLMModel,
} from './setup.js';

// any-llm integration
export { 
  AnyLLMAdapter, 
  createAnyLLMAdapter, 
  getAnyLLMProviders 
} from './any-llm-adapter.js';

// Re-export key any-llm types and functions for convenience
export {
  completion,
  completionStream,
  AnyLLM,
  getSupportedProviders,
} from '../any-llm/index.js';

export type { LLMProviderType, ProviderConfig } from '../any-llm/index.js';

// Legacy providers (kept for backward compatibility, but deprecated)
// TODO: Remove these in a future version
export { LlamafileProvider, createLlamafileProvider } from './llamafile.js';
export { OllamaProvider, createOllamaProvider } from './ollama.js';

