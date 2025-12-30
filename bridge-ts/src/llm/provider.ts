/**
 * LLM Provider interface.
 * 
 * Defines the contract for LLM providers (llamafile, ollama, OpenAI, etc.)
 * Start with llamafile, but design for swappability.
 */

// =============================================================================
// Core Types
// =============================================================================

/**
 * Information about an LLM model.
 */
export interface LLMModel {
  /** Model identifier */
  id: string;
  
  /** Human-readable name */
  name: string;
  
  /** Context window size in tokens */
  contextLength?: number;
  
  /** Whether this model supports function/tool calling */
  supportsTools: boolean;
  
  /** Model provider (for display) */
  provider?: string;
}

/**
 * A message in a chat conversation.
 */
export interface ChatMessage {
  /** Role of the message sender */
  role: 'system' | 'user' | 'assistant' | 'tool';
  
  /** Text content of the message */
  content: string;
  
  /** For tool role: the ID of the tool call this is responding to */
  toolCallId?: string;
  
  /** For assistant role: tool calls the assistant wants to make */
  toolCalls?: ToolCall[];
}

/**
 * A tool call requested by the LLM.
 */
export interface ToolCall {
  /** Unique ID for this tool call */
  id: string;
  
  /** Name of the tool to call */
  name: string;
  
  /** Arguments to pass to the tool (parsed) */
  arguments: Record<string, unknown>;
}

/**
 * Definition of a tool that the LLM can call.
 */
export interface ToolDefinition {
  /** Tool name (should match MCP tool name) */
  name: string;
  
  /** Description of what the tool does */
  description: string;
  
  /** JSON Schema for the tool's input parameters */
  inputSchema: object;
}

/**
 * OpenAI-format tool definition for LLM APIs.
 */
export interface LLMTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Request for a chat completion.
 */
export interface ChatRequest {
  /** Model to use (optional, uses default if not specified) */
  model?: string;
  
  /** Conversation messages */
  messages: ChatMessage[];
  
  /** Tools available for the LLM to call */
  tools?: ToolDefinition[];
  
  /** Maximum tokens to generate */
  maxTokens?: number;
  
  /** Temperature for sampling (0-2) */
  temperature?: number;
  
  /** System prompt (prepended to messages if not already present) */
  systemPrompt?: string;
}

/**
 * Response from a chat completion.
 */
export interface ChatResponse {
  /** The assistant's response message */
  message: ChatMessage;
  
  /** Token usage statistics */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  
  /** Why the generation stopped */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  
  /** Error message if finishReason is 'error' */
  error?: string;
}

/**
 * A chunk from streaming chat completion.
 */
export interface ChatChunk {
  /** Partial message content */
  delta: Partial<ChatMessage>;
  
  /** Set when streaming is complete */
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error';
}

// =============================================================================
// Provider Interface
// =============================================================================

/**
 * LLM Provider interface.
 * 
 * Implementations should:
 * - Be stateless (no conversation memory)
 * - Handle their own connection management
 * - Translate between our types and the provider's API
 */
export interface LLMProvider {
  /** Unique identifier for this provider */
  readonly id: string;
  
  /** Human-readable name */
  readonly name: string;
  
  /** Base URL for the provider's API */
  readonly baseUrl: string;
  
  /**
   * Check if this provider is available.
   * Should return true if the provider is running and accessible.
   */
  detect(): Promise<boolean>;
  
  /**
   * Get available models from this provider.
   */
  listModels(): Promise<LLMModel[]>;
  
  /**
   * Send a chat completion request.
   * For tool calling: if the response has toolCalls, the caller should
   * execute them and send a follow-up request with the results.
   */
  chat(request: ChatRequest): Promise<ChatResponse>;
  
  /**
   * Stream a chat completion.
   * Yields chunks as they arrive.
   */
  chatStream?(request: ChatRequest): AsyncIterable<ChatChunk>;
}

// =============================================================================
// Provider Configuration
// =============================================================================

/**
 * Configuration for an LLM provider.
 */
export interface LLMProviderConfig {
  /** Provider type (llamafile, ollama, openai, etc.) */
  type: string;
  
  /** Base URL for the API */
  baseUrl: string;
  
  /** API key (for providers that require it) */
  apiKey?: string;
  
  /** Default model to use */
  defaultModel?: string;
  
  /** Custom options */
  options?: Record<string, unknown>;
}

/**
 * Status of an LLM provider.
 */
export interface LLMProviderStatus {
  /** Provider ID */
  id: string;
  
  /** Provider name */
  name: string;
  
  /** Whether the provider is available */
  available: boolean;
  
  /** Base URL */
  baseUrl: string;
  
  /** Provider version (if available) */
  version?: string;
  
  /** Whether the provider supports tool calling */
  supportsTools?: boolean;
  
  /** Available models (if detected) */
  models?: LLMModel[];
  
  /** Error message if not available */
  error?: string;
  
  /** Warning message (e.g., version too old) */
  warning?: string;
  
  /** When this status was last checked */
  checkedAt: number;
}

