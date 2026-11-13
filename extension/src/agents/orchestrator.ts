/**
 * Agent Orchestrator
 *
 * The core agent loop that handles:
 * - Tool routing based on task keywords
 * - LLM calls with tool definitions
 * - Tool execution
 * - Streaming events
 * - maxToolCalls limit
 */

import { bridgeChat } from '../llm/chat';
import type {
  AgentRunOptions,
  RunEvent,
  ToolDescriptor,
  Citation,
} from './types';

import { listServersWithStatus, callTool, startServer } from '../mcp/host';
import { isToolAllowed } from '../policy/permissions';

// =============================================================================
// Tool Routing Keywords
// =============================================================================

const TOOL_KEYWORDS: Record<string, string[]> = {
  time: ['time', 'clock', 'date', 'hour', 'minute', 'timezone'],
  search: ['search', 'find', 'lookup', 'google', 'web'],
  memory: ['remember', 'memory', 'save', 'recall', 'store', 'note'],
  file: ['file', 'read', 'write', 'directory', 'folder', 'path'],
  github: ['github', 'repo', 'repository', 'commit', 'pull request', 'issue'],
  weather: ['weather', 'forecast', 'temperature', 'rain', 'sunny'],
  database: ['database', 'query', 'sql', 'table'],
  api: ['api', 'request', 'fetch', 'endpoint'],
};

/**
 * Route tools based on task keywords.
 * Returns tools that match keywords in the task.
 */
function routeToolsByKeywords(task: string, tools: ToolDescriptor[]): ToolDescriptor[] {
  const taskLower = task.toLowerCase();
  const matchedCategories = new Set<string>();

  // Find matching categories based on keywords
  for (const [category, keywords] of Object.entries(TOOL_KEYWORDS)) {
    for (const keyword of keywords) {
      if (taskLower.includes(keyword)) {
        matchedCategories.add(category);
        break;
      }
    }
  }

  // If no categories matched, return all tools (fallback)
  if (matchedCategories.size === 0) {
    return tools;
  }

  // Filter tools based on matched categories
  return tools.filter((tool) => {
    const toolNameLower = tool.name.toLowerCase();
    const toolDescLower = (tool.description || '').toLowerCase();

    for (const category of matchedCategories) {
      const keywords = TOOL_KEYWORDS[category];
      for (const keyword of keywords) {
        if (toolNameLower.includes(keyword) || toolDescLower.includes(keyword)) {
          return true;
        }
      }
    }

    return false;
  });
}

// =============================================================================
// LLM Tool Calling
// =============================================================================

interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

interface LLMToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * Call the LLM with tool definitions.
 */
async function callLLMWithTools(
  messages: LLMMessage[],
  tools: LLMToolDefinition[],
  model?: string,
  temperature?: number,
): Promise<{
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}> {
  // For now, use basic chat and parse tool calls from the response
  // TODO: Use proper function calling when bridge supports it
  const response = await bridgeChat({
    model: model === 'apple' ? 'apple:system' : model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature,
    // tools, // TODO: Add when bridge supports it
  });

  // Parse tool calls from content if not provided
  const content = response.content;
  const rawToolCalls = response.message.tool_calls;
  
  // Normalize tool_calls to have type: 'function'
  let toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> | undefined;

  if (rawToolCalls) {
    toolCalls = rawToolCalls.map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: tc.function,
    }));
  } else {
    // Try to parse tool calls from text format
    const parsed = parseToolCallsFromText(content, tools);
    if (parsed) {
      toolCalls = parsed.map(tc => ({ ...tc, type: 'function' as const }));
    }
  }

  return {
    content: toolCalls && toolCalls.length > 0 ? '' : content,
    tool_calls: toolCalls,
  };
}

/**
 * Parse tool calls from text format.
 * Looks for patterns like: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 * Or: Use tool: tool_name with arguments: {...}
 */
function parseToolCallsFromText(
  content: string,
  tools: LLMToolDefinition[],
): Array<{ id: string; function: { name: string; arguments: string } }> | undefined {
  const toolNames = new Set(tools.map((t) => t.function.name));
  const calls: Array<{ id: string; function: { name: string; arguments: string } }> = [];

  // Try to parse XML-style tool calls
  const xmlPattern = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  let match;

  while ((match = xmlPattern.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name && toolNames.has(parsed.name)) {
        calls.push({
          id: crypto.randomUUID(),
          function: {
            name: parsed.name,
            arguments: JSON.stringify(parsed.arguments || {}),
          },
        });
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Try JSON format in fenced code blocks
  const jsonPattern = /```(?:json)?\s*(\{[\s\S]*?"(?:name|function)"[\s\S]*?\})\s*```/g;
  while ((match = jsonPattern.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      const name = parsed.name || parsed.function;
      if (name && toolNames.has(name)) {
        calls.push({
          id: crypto.randomUUID(),
          function: {
            name,
            arguments: JSON.stringify(parsed.arguments || parsed.parameters || {}),
          },
        });
      }
    } catch {
      // Ignore parse errors
    }
  }

  return calls.length > 0 ? calls : undefined;
}

// =============================================================================
// Agent Run Loop
// =============================================================================

/**
 * Run the agent with the given task.
 * Yields streaming events.
 */
export async function* runAgent(
  origin: string,
  options: AgentRunOptions,
  tabId?: number,
): AsyncGenerator<RunEvent> {
  const {
    task,
    tools: allowedTools,
    provider,
    useAllTools = false,
    requireCitations = false,
    maxToolCalls = 5,
  } = options;

  yield { type: 'status', message: 'Starting agent...' };

  // Get all available tools
  let allTools: ToolDescriptor[] = [];
  try {
    const servers = await listServersWithStatus();
    for (const server of servers) {
      if (server.tools) {
        for (const tool of server.tools) {
          const fullName = `${server.id}/${tool.name}`;

          // Check if tool is in allowlist (if specified)
          if (allowedTools && !allowedTools.includes(fullName)) {
            continue;
          }

          // Check if origin has permission for this tool
          const isAllowed = await isToolAllowed(origin, fullName);
          if (!isAllowed && !allowedTools) {
            continue; // Skip tools not in origin's allowlist (unless explicitly requested)
          }

          allTools.push({
            name: fullName,
            description: tool.description,
            inputSchema: tool.inputSchema,
            serverId: server.id,
          });
        }
      }
    }
  } catch (error) {
    yield {
      type: 'error',
      error: {
        code: 'ERR_INTERNAL',
        message: `Failed to list tools: ${error instanceof Error ? error.message : 'Unknown error'}`,
      },
    };
    return;
  }

  // Route tools by keywords (unless useAllTools is true)
  const routedTools = useAllTools ? allTools : routeToolsByKeywords(task, allTools);

  yield { type: 'status', message: `Found ${routedTools.length} relevant tools` };

  // Build tool definitions for LLM
  const toolDefinitions: LLMToolDefinition[] = routedTools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  }));

  // Conversation messages
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: `You are a helpful assistant with access to tools.

## Available Tools
${routedTools.map((t) => `- ${t.name}: ${t.description || 'No description'}`).join('\n')}

## TOOL SELECTION STRATEGY
1. Before calling any tool, carefully analyze what the user is asking for
2. Call a tool ONLY when you need information or capabilities you don't have
3. Choose the most appropriate tool based on the user's actual intent
4. Most requests need at most ONE tool call

## ARGUMENT EXTRACTION - CRITICAL
When determining tool arguments:
1. Use EXACTLY what the user provides - never invent or assume values
2. If the user references "this", "that", or similar pronouns, look for the actual content in their message or conversation history
3. If the user's request is ambiguous or missing required information, ASK for clarification instead of guessing
4. Do NOT use placeholder or example data - only use actual values from the user

CORRECT: User says "reverse hello" → arguments: {"text": "hello"}
INCORRECT: User says "reverse this" (no text given) → making up text (WRONG - should ask for the text)

## How to Call a Tool
When you need to use a tool, respond with a tool call in this format:
<tool_call>{"name": "tool_name", "arguments": {"arg1": "value1"}}</tool_call>

## RESPONSE RULES
After receiving tool results, synthesize the information and provide a helpful response.
Do NOT call additional tools unless explicitly needed for the user's request.`,
    },
    {
      role: 'user',
      content: task,
    },
  ];

  const citations: Citation[] = [];
  let toolCallCount = 0;

  // Agent loop
  while (toolCallCount < maxToolCalls) {
    yield { type: 'status', message: 'Thinking...' };

    try {
      const response = await callLLMWithTools(
        messages,
        toolDefinitions,
        provider,
        0.7, // temperature
      );

      // If no tool calls, we have a final response
      if (!response.tool_calls || response.tool_calls.length === 0) {
        // Stream the response tokens
        const content = response.content;
        const chunkSize = 20;
        for (let i = 0; i < content.length; i += chunkSize) {
          yield { type: 'token', token: content.slice(i, i + chunkSize) };
        }

        yield {
          type: 'final',
          output: content,
          citations: requireCitations && citations.length > 0 ? citations : undefined,
        };
        return;
      }

      // Process tool calls
      for (const toolCall of response.tool_calls) {
        if (toolCallCount >= maxToolCalls) {
          break;
        }

        const toolName = toolCall.function.name;
        let toolArgs: Record<string, unknown>;

        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          toolArgs = {};
        }

        yield { type: 'tool_call', tool: toolName, args: toolArgs };

        // Execute the tool
        const [serverId, actualToolName] = toolName.split('/');

        try {
          // Start server if needed
          await startServer(serverId);

          // Call the tool
          const result = await callTool(serverId, actualToolName, toolArgs);

          if (result.ok) {
            yield { type: 'tool_result', tool: toolName, result: result.result };

            // Add to citations
            citations.push({
              source: 'tool',
              ref: toolName,
              excerpt: typeof result.result === 'string'
                ? result.result.slice(0, 200)
                : JSON.stringify(result.result).slice(0, 200),
            });

            // Add tool result to conversation
            messages.push({
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: toolCall.id,
                type: 'function' as const,
                function: toolCall.function,
              }],
            });
            messages.push({
              role: 'tool',
              content: typeof result.result === 'string' ? result.result : JSON.stringify(result.result),
              tool_call_id: toolCall.id,
            });
          } else {
            yield {
              type: 'tool_result',
              tool: toolName,
              error: { code: 'ERR_TOOL_FAILED', message: result.error || 'Tool call failed' },
            };

            // Add error to conversation
            messages.push({
              role: 'tool',
              content: `Error: ${result.error || 'Tool call failed'}`,
              tool_call_id: toolCall.id,
            });
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          yield {
            type: 'tool_result',
            tool: toolName,
            error: { code: 'ERR_TOOL_FAILED', message: errorMessage },
          };

          messages.push({
            role: 'tool',
            content: `Error: ${errorMessage}`,
            tool_call_id: toolCall.id,
          });
        }

        toolCallCount++;
      }
    } catch (error) {
      yield {
        type: 'error',
        error: {
          code: 'ERR_MODEL_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
      return;
    }
  }

  // Max tool calls reached - generate final response
  yield { type: 'status', message: 'Generating final response...' };

  messages.push({
    role: 'user',
    content: 'Please provide a final summary based on the tool results.',
  });

  try {
    const finalResponse = await callLLMWithTools(messages, [], provider, 0.7);
    const content = finalResponse.content;

    const chunkSize = 20;
    for (let i = 0; i < content.length; i += chunkSize) {
      yield { type: 'token', token: content.slice(i, i + chunkSize) };
    }

    yield {
      type: 'final',
      output: content,
      citations: requireCitations && citations.length > 0 ? citations : undefined,
    };
  } catch (error) {
    yield {
      type: 'error',
      error: {
        code: 'ERR_MODEL_FAILED',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    };
  }
}
