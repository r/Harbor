/**
 * LLM module - manages LLM providers and chat interactions.
 */

export * from './provider.js';
export { LlamafileProvider, createLlamafileProvider } from './llamafile.js';
export { OllamaProvider, createOllamaProvider } from './ollama.js';
export { LLMManager, getLLMManager } from './manager.js';
export { 
  LLMSetupManager, 
  getLLMSetupManager,
  LLMSetupStatus,
  DownloadProgress,
  LLMModel,
} from './setup.js';

