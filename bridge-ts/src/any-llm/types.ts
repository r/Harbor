/**
 * Core types for any-llm TypeScript port.
 * 
 * These types follow the OpenAI API format as the de facto standard,
 * matching the patterns from mozilla-ai/any-llm.
 */

// =============================================================================
// Provider Types
// =============================================================================

/**
 * Supported LLM providers.
 */
export type LLMProviderType = 
  | 'openai'
  | 'anthropic'
  | 'ollama'
  | 'llamafile'
  | 'mistral'
  | 'groq'
  | 'together'
  | 'openrouter'
  | 'lmstudio'
  | 'deepseek';

/**
 * Provider configuration.
 */
export interface ProviderConfig {
  /** API key for the provider */
  apiKey?: string;
  /** Base URL override for the provider's API */
  baseUrl?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Additional provider-specific options */
  [key: string]: unknown;
}

/**
 * Provider metadata describing capabilities.
 */
export interface ProviderMetadata {
  /** Provider identifier */
  name: string;
  /** Environment variable name for API key */
  envKey: string;
  /** Link to provider documentation */
  docUrl: string;
  /** Whether provider supports streaming */
  streaming: boolean;
  /** Whether provider supports reasoning/thinking output */
  reasoning: boolean;
  /** Whether provider supports chat completion */
  completion: boolean;
  /** Whether provider supports embeddings */
  embedding: boolean;
  /** Whether provider supports image inputs */
  image: boolean;
  /** Whether provider supports listing models */
  listModels: boolean;
}

// =============================================================================
// Message Types (OpenAI-compatible)
// =============================================================================

/**
 * Role of a message in a conversation.
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * A tool call made by the assistant.
 */
export interface ToolCall {
  /** Unique identifier for this tool call */
  id: string;
  /** Type of tool call (always 'function') */
  type: 'function';
  /** Function details */
  function: {
    /** Name of the function to call */
    name: string;
    /** JSON-encoded arguments */
    arguments: string;
  };
}

/**
 * Text content part of a message.
 */
export interface TextContentPart {
  type: 'text';
  text: string;
}

/**
 * Image content part of a message.
 */
export interface ImageContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

/**
 * Content can be a string or an array of parts.
 */
export type MessageContent = string | null | (TextContentPart | ImageContentPart)[];

/**
 * A message in a conversation.
 */
export interface Message {
  /** Role of the message sender */
  role: MessageRole;
  /** Content of the message */
  content: MessageContent;
  /** For assistant messages: tool calls requested */
  tool_calls?: ToolCall[];
  /** For tool messages: the ID of the tool call this responds to */
  tool_call_id?: string;
  /** Optional name (for user messages) */
  name?: string;
}

/**
 * Extended message with reasoning (for models that support thinking).
 */
export interface MessageWithReasoning extends Message {
  /** Reasoning/thinking content (for models that expose it) */
  reasoning?: {
    content: string;
  };
}

// =============================================================================
// Tool Types
// =============================================================================

/**
 * A tool definition that can be passed to the LLM.
 */
export interface Tool {
  type: 'function';
  function: {
    /** Name of the function */
    name: string;
    /** Description of what the function does */
    description?: string;
    /** JSON Schema for the function parameters */
    parameters: Record<string, unknown>;
  };
}

// =============================================================================
// Completion Request/Response Types
// =============================================================================

/**
 * Completion request parameters.
 */
export interface CompletionRequest {
  /** 
   * Model identifier. Can be:
   * - Just model name: "gpt-4o" (requires provider param)
   * - Provider:model format: "openai:gpt-4o"
   */
  model: string;
  
  /** Provider to use (optional if model contains provider prefix) */
  provider?: LLMProviderType | string;
  
  /** Conversation messages */
  messages: Message[];
  
  /** Tools available for the model to call */
  tools?: Tool[];
  
  /** Controls which tools the model can call */
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  
  /** Temperature for sampling (0-2) */
  temperature?: number;
  
  /** Nucleus sampling probability (0-1) */
  top_p?: number;
  
  /** Maximum tokens to generate */
  max_tokens?: number;
  
  /** Whether to stream the response */
  stream?: boolean;
  
  /** Number of completions to generate */
  n?: number;
  
  /** Stop sequences */
  stop?: string | string[];
  
  /** Presence penalty (-2 to 2) */
  presence_penalty?: number;
  
  /** Frequency penalty (-2 to 2) */
  frequency_penalty?: number;
  
  /** Random seed for reproducibility */
  seed?: number;
  
  /** User identifier for abuse tracking */
  user?: string;
  
  /** Response format (e.g., for JSON mode) */
  response_format?: { type: 'text' | 'json_object' } | { type: 'json_schema'; json_schema: Record<string, unknown> };
  
  /** API key override */
  api_key?: string;
  
  /** Base URL override */
  api_base?: string;
}

/**
 * A choice in a completion response.
 */
export interface CompletionChoice {
  /** Index of this choice */
  index: number;
  /** The message generated */
  message: MessageWithReasoning;
  /** Why generation stopped */
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  /** Log probabilities (if requested) */
  logprobs?: unknown;
}

/**
 * Token usage statistics.
 */
export interface CompletionUsage {
  /** Tokens in the prompt */
  prompt_tokens: number;
  /** Tokens in the completion */
  completion_tokens: number;
  /** Total tokens used */
  total_tokens: number;
}

/**
 * A chat completion response.
 */
export interface ChatCompletion {
  /** Unique identifier */
  id: string;
  /** Object type */
  object: 'chat.completion';
  /** Unix timestamp of creation */
  created: number;
  /** Model used */
  model: string;
  /** Provider that handled the request */
  provider?: string;
  /** Generated choices */
  choices: CompletionChoice[];
  /** Token usage */
  usage?: CompletionUsage;
}

// =============================================================================
// Streaming Types
// =============================================================================

/**
 * Delta for a streaming chunk.
 */
export interface ChunkDelta {
  /** Role (usually only in first chunk) */
  role?: MessageRole;
  /** Content fragment */
  content?: string | null;
  /** Tool calls (may be partial) */
  tool_calls?: Partial<ToolCall>[];
  /** Reasoning content (for models that support it) */
  reasoning?: { content: string };
}

/**
 * A choice in a streaming chunk.
 */
export interface ChunkChoice {
  /** Index of this choice */
  index: number;
  /** The delta (partial content) */
  delta: ChunkDelta;
  /** Why generation stopped (only in final chunk) */
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

/**
 * A streaming chunk from a chat completion.
 */
export interface ChatCompletionChunk {
  /** Unique identifier */
  id: string;
  /** Object type */
  object: 'chat.completion.chunk';
  /** Unix timestamp of creation */
  created: number;
  /** Model used */
  model: string;
  /** Choices in this chunk */
  choices: ChunkChoice[];
}

// =============================================================================
// Model Types
// =============================================================================

/**
 * Information about a model.
 */
export interface ModelInfo {
  /** Model identifier */
  id: string;
  /** Object type */
  object: 'model';
  /** Unix timestamp of creation */
  created?: number;
  /** Owner/provider of the model */
  owned_by?: string;
  /** Provider that offers this model */
  provider?: string;
  /** Context window size */
  context_length?: number;
  /** Whether model supports tool calling */
  supports_tools?: boolean;
  /** Whether model supports vision/images */
  supports_vision?: boolean;
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Parsed model string result.
 */
export interface ParsedModel {
  /** Provider identifier */
  provider: string;
  /** Model identifier */
  model: string;
}

/**
 * Result of a provider availability check.
 */
export interface ProviderStatus {
  /** Provider identifier */
  provider: string;
  /** Whether the provider is available */
  available: boolean;
  /** Error message if not available */
  error?: string;
  /** Provider version (if detectable) */
  version?: string;
  /** Available models (if listable) */
  models?: ModelInfo[];
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error codes for any-llm errors.
 */
export enum AnyLLMErrorCode {
  /** API key is missing */
  MissingApiKey = 'MISSING_API_KEY',
  /** Provider is not supported */
  UnsupportedProvider = 'UNSUPPORTED_PROVIDER',
  /** Request failed */
  RequestFailed = 'REQUEST_FAILED',
  /** Rate limited */
  RateLimited = 'RATE_LIMITED',
  /** Invalid request */
  InvalidRequest = 'INVALID_REQUEST',
  /** Provider unavailable */
  ProviderUnavailable = 'PROVIDER_UNAVAILABLE',
  /** Model not found */
  ModelNotFound = 'MODEL_NOT_FOUND',
  /** Timeout */
  Timeout = 'TIMEOUT',
}

/**
 * Custom error class for any-llm errors.
 */
export class AnyLLMError extends Error {
  constructor(
    message: string,
    public readonly code: AnyLLMErrorCode,
    public readonly provider?: string,
    public readonly statusCode?: number,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'AnyLLMError';
  }
}

