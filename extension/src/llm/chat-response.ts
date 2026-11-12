/** Shared boundary for the Rust bridge's OpenAI-compatible chat completions. */

export interface ChatToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface BridgeChatRequest {
  messages: ChatMessage[];
  model?: string;
  system_prompt?: string;
  temperature?: number;
  max_tokens?: number;
  tools?: Array<{ name: string; description?: string; input_schema: unknown }>;
}

export interface ChatChoice {
  message: { role: string; content: string | null; tool_calls?: ChatToolCall[] | null };
  finish_reason?: string;
}

export interface ChatCompletion {
  content: string;
  message: ChatChoice['message'];
  choices: ChatChoice[];
  model?: string;
  finish_reason?: string;
}

/** Keep provider parsing here; callers consume content/message without guessing shapes. */
export function normalizeChatResponse(raw: unknown): ChatCompletion {
  if (!raw || typeof raw !== 'object' || !('choices' in raw) || !Array.isArray(raw.choices)) {
    throw new Error('Invalid chat response: missing choices');
  }
  const message = raw.choices[0]?.message;
  if (!message || typeof message.role !== 'string' ||
      (message.content !== null && typeof message.content !== 'string')) {
    throw new Error('Invalid chat response: missing assistant message');
  }
  if (message.tool_calls != null && (!Array.isArray(message.tool_calls) ||
      !message.tool_calls.every((call: unknown) => {
        if (!call || typeof call !== 'object') return false;
        const tc = call as ChatToolCall;
        return typeof tc.id === 'string' && tc.function &&
          typeof tc.function.name === 'string' && typeof tc.function.arguments === 'string';
      }))) {
    throw new Error('Invalid chat response: malformed tool calls');
  }
  const response = raw as { choices: ChatChoice[]; model?: string };
  return {
    content: message.content ?? '',
    message,
    choices: response.choices,
    model: response.model,
    finish_reason: response.choices[0].finish_reason,
  };
}
