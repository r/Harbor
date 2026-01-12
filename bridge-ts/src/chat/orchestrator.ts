/**
 * Chat Orchestrator - the agent loop that connects LLM to MCP tools.
 * 
 * The orchestrator:
 * 1. Collects available tools from enabled MCP servers
 * 2. Sends user messages to the LLM with tool definitions
 * 3. Executes any tool calls via MCP
 * 4. Feeds tool results back to the LLM
 * 5. Repeats until the LLM produces a final response
 */

import { ChatMessage, ToolDefinition, ToolCall, ChatRequest } from '../llm/index.js';
import { getLLMManager } from '../llm/manager.js';
import { getMcpClientManager } from '../mcp/manager.js';
import { log } from '../native-messaging.js';
import { ChatSession, addMessage } from './session.js';
import { McpTool } from '../types.js';
import { getToolRouter, RoutingResult } from './tool-router.js';
import { 
  parseToolCallFromText, 
  cleanLLMTokens, 
  ToolNameToServerMap 
} from './tool-call-parser.js';

/**
 * Result of a single orchestration step.
 */
export interface OrchestrationStep {
  /** Step number (0-indexed) */
  index: number;
  
  /** What happened in this step */
  type: 'llm_response' | 'tool_calls' | 'tool_results' | 'error' | 'final';
  
  /** Content from LLM (if type is llm_response or final) */
  content?: string;
  
  /** Tool calls made (if type is tool_calls) */
  toolCalls?: ToolCallInfo[];
  
  /** Tool results (if type is tool_results) */
  toolResults?: ToolCallResult[];
  
  /** Error message (if type is error) */
  error?: string;
  
  /** Timestamp */
  timestamp: number;
}

/**
 * Info about a tool call (simplified for orchestration step).
 */
export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Result of a tool call.
 */
export interface ToolCallResult {
  /** The tool call ID */
  toolCallId: string;
  
  /** Name of the tool */
  toolName: string;
  
  /** Server that provided the tool */
  serverId: string;
  
  /** Result content */
  content: string;
  
  /** Whether the tool call errored */
  isError: boolean;
}

/**
 * Full result of an orchestration run.
 */
export interface OrchestrationResult {
  /** Final response from LLM */
  finalResponse: string;
  
  /** All steps taken */
  steps: OrchestrationStep[];
  
  /** Total iterations used */
  iterations: number;
  
  /** Whether max iterations was reached */
  reachedMaxIterations: boolean;
  
  /** Total time in milliseconds */
  durationMs: number;
  
  /** Tool routing information (if router was used) */
  routing?: RoutingResult;
}

/**
 * Mapping from tool name to server ID with full metadata.
 */
interface ToolMapping {
  [toolName: string]: {
    serverId: string;
    originalName: string;
    tool: McpTool;
  };
}

/**
 * Convert the rich ToolMapping to a simple name->serverId map for parsing.
 */
function toSimpleToolMapping(mapping: ToolMapping): ToolNameToServerMap {
  const result: ToolNameToServerMap = {};
  for (const [name, info] of Object.entries(mapping)) {
    result[name] = info.serverId;
  }
  return result;
}

/**
 * The Chat Orchestrator.
 */
export class ChatOrchestrator {
  /**
   * Run the orchestration loop for a user message.
   * 
   * @param session - The chat session
   * @param userMessage - The user's message
   * @param onStep - Optional callback for each step (for streaming updates)
   */
  async run(
    session: ChatSession,
    userMessage: string,
    onStep?: (step: OrchestrationStep) => void
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const steps: OrchestrationStep[] = [];
    let iterations = 0;
    
    log(`[Orchestrator] Starting orchestration for session ${session.id}`);
    
    // Add user message to session
    const userMsg: ChatMessage = { role: 'user', content: userMessage };
    addMessage(session, userMsg);
    
    // Determine which servers to use (router or all)
    let serversToUse = session.enabledServers;
    let routingResult: RoutingResult | undefined;
    
    if (session.config.useToolRouter !== false) {
      const router = getToolRouter();
      routingResult = router.route(userMessage, session.enabledServers);
      serversToUse = routingResult.selectedServers;
      log(`[Orchestrator] Router: ${routingResult.reason}`);
    } else {
      log('[Orchestrator] Router disabled, using all servers');
    }
    
    // Collect tools from selected MCP servers
    const { tools, toolMapping } = await this.collectTools(serversToUse);
    log(`[Orchestrator] Collected ${tools.length} tools from ${serversToUse.length} servers`);
    
    // Log tool names and descriptions for debugging
    log(`[Orchestrator] === TOOLS SENT TO LLM ===`);
    for (const tool of tools) {
      log(`[Orchestrator] Tool: ${tool.name}`);
      log(`[Orchestrator]   Description: ${tool.description || '(no description)'}`);
    }
    log(`[Orchestrator] === END TOOLS ===`);
    
    // Main agent loop
    while (iterations < session.config.maxIterations) {
      iterations++;
      log(`[Orchestrator] Iteration ${iterations}/${session.config.maxIterations}`);
      
      try {
        // Call LLM - log the provider/model info
        const llmManager = getLLMManager();
        const activeProvider = llmManager.getActiveId();
        const activeModel = llmManager.getActiveModelId();
        
        // Build the request - use provider/model-specific system prompt
        log(`[Orchestrator] Building system prompt for provider: ${activeProvider}, model: ${activeModel}`);
        const systemPrompt = session.systemPrompt || this.buildSystemPrompt(tools, activeProvider, activeModel);
        const useNativeTools = this.modelSupportsNativeTools(activeProvider, activeModel);
        log(`[Orchestrator] System prompt type: ${useNativeTools ? 'native tool calling' : 'text-based tool calling'}`);
        log(`[Orchestrator] System prompt length: ${systemPrompt?.length || 0} chars`);
        
        const request: ChatRequest = {
          messages: [...session.messages],
          // Only pass tools natively if model supports it, otherwise use text-based prompting
          tools: useNativeTools && tools.length > 0 ? tools : undefined,
          systemPrompt,
        };
        log(`[Orchestrator] Calling LLM: provider=${activeProvider}, model=${activeModel}, tools=${tools.length}, native=${useNativeTools}`);
        log(`[Orchestrator] Tools being passed: ${tools.slice(0, 5).map(t => t.name).join(', ')}${tools.length > 5 ? '...' : ''}`);
        log(`[Orchestrator] System prompt (first 200 chars): ${request.systemPrompt?.substring(0, 200)}`);
        
        const response = await llmManager.chat(request);
        
        // Log the LLM response details
        log(`[Orchestrator] LLM response: finishReason=${response.finishReason}, toolCalls=${response.message.toolCalls?.length || 0}, content=${response.message.content?.substring(0, 100)}`);
        if (response.message.toolCalls && response.message.toolCalls.length > 0) {
          log(`[Orchestrator] Tool calls received: ${response.message.toolCalls.map(tc => `${tc.name}(${JSON.stringify(tc.arguments)})`).join(', ')}`);
        }
        if (response.error) {
          log(`[Orchestrator] LLM error: ${response.error}`);
        }
        
        // Check for error
        if (response.finishReason === 'error') {
          const errorStep: OrchestrationStep = {
            index: steps.length,
            type: 'error',
            error: response.error || 'Unknown LLM error',
            timestamp: Date.now(),
          };
          steps.push(errorStep);
          onStep?.(errorStep);
          
          return {
            finalResponse: `Error: ${response.error || 'Unknown LLM error'}`,
            steps,
            iterations,
            reachedMaxIterations: false,
            durationMs: Date.now() - startTime,
            routing: routingResult,
          };
        }
        
        // Check for tool calls - either proper tool calls or text-based tool calls
        let toolCalls = response.message.toolCalls;
        
        log(`[Orchestrator] Native tool_calls from LLM: ${toolCalls?.length || 0}`);
        
        // Fallback: Check if LLM wrote tool call as text (common with some Ollama models)
        if ((!toolCalls || toolCalls.length === 0) && response.message.content) {
          log(`[Orchestrator] No native tool calls, checking for text-based tool call...`);
          log(`[Orchestrator] Full LLM response: ${response.message.content}`);
          
          const simpleMapping = toSimpleToolMapping(toolMapping);
          log(`[Orchestrator] Tool mapping has ${Object.keys(simpleMapping).length} tools: ${Object.keys(simpleMapping).slice(0, 5).join(', ')}...`);
          
          const parsedToolCall = parseToolCallFromText(
            response.message.content, 
            simpleMapping
          );
          if (parsedToolCall) {
            log('[Orchestrator] ✓ Detected tool call written as text!');
            log(`[Orchestrator] Parsed tool: ${parsedToolCall.name} with args: ${JSON.stringify(parsedToolCall.arguments)}`);
            toolCalls = [parsedToolCall];
            response.finishReason = 'tool_calls';
          } else {
            log('[Orchestrator] ✗ No text-based tool call found');
            log('[Orchestrator] Available tool names: ' + Object.keys(toolMapping).join(', '));
            log('[Orchestrator] Content looks like JSON: ' + (response.message.content.trim().startsWith('{') ? 'YES' : 'NO'));
          }
        }
        
        if (response.finishReason === 'tool_calls' && toolCalls?.length) {
          
          // Record tool calls step
          const toolCallStep: OrchestrationStep = {
            index: steps.length,
            type: 'tool_calls',
            toolCalls: toolCalls.map(tc => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            })),
            timestamp: Date.now(),
          };
          steps.push(toolCallStep);
          onStep?.(toolCallStep);
          
          // Add assistant message with tool calls to conversation
          addMessage(session, response.message);
          
          // Execute tool calls
          const toolResults = await this.executeToolCalls(toolCalls, toolMapping);
          
          // Record tool results step
          const toolResultStep: OrchestrationStep = {
            index: steps.length,
            type: 'tool_results',
            toolResults,
            timestamp: Date.now(),
          };
          steps.push(toolResultStep);
          onStep?.(toolResultStep);
          
          // Add tool results to conversation
          for (const result of toolResults) {
            const toolMsg: ChatMessage = {
              role: 'tool',
              content: result.content,
              toolCallId: result.toolCallId,
            };
            addMessage(session, toolMsg);
          }
          
          // Continue loop to get LLM response
          continue;
        }
        
        // LLM produced a final response - clean any special tokens
        const finalContent = cleanLLMTokens(response.message.content || '');
        
        // Check if LLM is describing how to use a tool instead of calling it
        const describePatterns = [
          /you can use/i,
          /you could use/i,
          /try calling/i,
          /try using/i,
          /to find .+, use/i,
          /to get .+, use/i,
          /here'?s how/i,
          /the .+ function/i,
          /the .+ tool/i,
          /use the following/i,
        ];
        
        const isDescribingTool = describePatterns.some(p => p.test(finalContent));
        const mentionsToolName = Object.keys(toolMapping).some(name => 
          finalContent.toLowerCase().includes(name.toLowerCase())
        );
        
        // If LLM is describing a tool instead of calling it, nudge it to actually call
        if (isDescribingTool && mentionsToolName && iterations < session.config.maxIterations) {
          log(`[Orchestrator] Detected tool description instead of call, nudging LLM...`);
          
          // Add the assistant's response to the conversation
          addMessage(session, response.message);
          
          // Add a nudge message
          const nudgeMsg: ChatMessage = {
            role: 'user',
            content: 'Please execute the tool call now - don\'t describe how to use it, just call it directly and show me the results.',
          };
          addMessage(session, nudgeMsg);
          
          // Record this as a step
          const nudgeStep: OrchestrationStep = {
            index: steps.length,
            type: 'llm_response',
            content: `[Agent tried to describe tool instead of calling it. Nudging to execute...]`,
            timestamp: Date.now(),
          };
          steps.push(nudgeStep);
          onStep?.(nudgeStep);
          
          // Continue the loop to get another response
          continue;
        }
        
        // Add assistant message to session
        addMessage(session, response.message);
        
        // Record final step
        const finalStep: OrchestrationStep = {
          index: steps.length,
          type: 'final',
          content: finalContent,
          timestamp: Date.now(),
        };
        steps.push(finalStep);
        onStep?.(finalStep);
        
        return {
          finalResponse: finalContent,
          steps,
          iterations,
          reachedMaxIterations: false,
          durationMs: Date.now() - startTime,
          routing: routingResult,
        };
        
      } catch (error) {
        log(`[Orchestrator] Error in iteration ${iterations}: ${error}`);
        
        const errorStep: OrchestrationStep = {
          index: steps.length,
          type: 'error',
          error: String(error),
          timestamp: Date.now(),
        };
        steps.push(errorStep);
        onStep?.(errorStep);
        
        // On error, try to return gracefully
        return {
          finalResponse: `I encountered an error: ${error}`,
          steps,
          iterations,
          reachedMaxIterations: false,
          durationMs: Date.now() - startTime,
          routing: routingResult,
        };
      }
    }
    
    // Reached max iterations
    log(`[Orchestrator] Reached max iterations (${session.config.maxIterations})`);
    
    return {
      finalResponse: 'I reached the maximum number of steps. Please try a simpler request or increase the limit.',
      steps,
      iterations,
      reachedMaxIterations: true,
      durationMs: Date.now() - startTime,
      routing: routingResult,
    };
  }

  /**
   * Check if a provider/model combo supports native tool calling.
   * 
   * Native tool calling means the model can receive tools in the API request
   * and return structured tool_calls in the response.
   */
  private modelSupportsNativeTools(provider?: string | null, model?: string | null): boolean {
    // Cloud providers with native tool support
    const nativeToolProviders = ['openai', 'anthropic', 'mistral', 'groq'];
    if (provider && nativeToolProviders.includes(provider)) {
      return true;
    }
    
    // Ollama - only specific models support native tool calling
    if (provider === 'ollama' && model) {
      const ollamaModelsWithNativeTools = [
        'llama3.1', 'llama3.2', 'llama3.3',
        'mistral-nemo', 'mistral-large',
        'qwen2.5',
        'command-r',
      ];
      return ollamaModelsWithNativeTools.some(m => model.toLowerCase().includes(m));
    }
    
    return false;
  }

  /**
   * Build a system prompt that helps the LLM use tools correctly.
   * 
   * For providers with native tool calling (OpenAI, Anthropic), keep it simple.
   * For providers without native tool calling (llamafile), include explicit
   * instructions on how to format tool calls as JSON.
   */
  private buildSystemPrompt(tools: ToolDefinition[], provider?: string | null, model?: string | null): string {
    if (tools.length === 0) {
      return 'You are a helpful assistant.';
    }
    
    // Providers that have native tool calling support
    const nativeToolCallingProviders = ['openai', 'anthropic', 'mistral', 'groq'];
    
    // Ollama models that support native tool calling
    // Note: mistral:7b-instruct does NOT support native tools despite the name
    const ollamaModelsWithNativeTools = [
      'llama3.1', 'llama3.2', 'llama3.3',  // Llama 3.1+ has native tool support
      'mistral-nemo', 'mistral-large',      // Newer Mistral models (not 7b-instruct)
      'qwen2.5',                            // Qwen 2.5 has tool support
      'command-r',                          // Command R models
    ];
    
    // Check if this is an Ollama model with native tool support
    const isOllamaWithNativeTools = provider === 'ollama' && model && 
      ollamaModelsWithNativeTools.some(m => model.toLowerCase().includes(m));
    
    // Use native tool calling prompt for supported providers/models
    if ((provider && nativeToolCallingProviders.includes(provider)) || isOllamaWithNativeTools) {
      log(`[Orchestrator] Using native tool calling prompt for ${provider}/${model}`);
      return `You are a helpful assistant that takes actions using tools. The tools ARE connected to real services.

Think step by step. You can make multiple tool calls - each returns results, then you decide the next action.

Strategy:
1. SEARCH first to find items (returns IDs and summaries)
2. Then READ/GET specific items using IDs from search results
3. Keep parameters simple - only use values from the user's request or previous results

After getting results:
- If found: Summarize for user or get more details
- If empty: Say "No results found" - don't say you can't access things
- Never say "I can't access" after a tool call - the tools work`;
    }
    
    // For Ollama models without native tool support, log which model
    if (provider === 'ollama') {
      log(`[Orchestrator] Model ${model} does not support native tools, using text-based tool calling`);
    }
    
    // For llamafile, ollama, and other local models - provide explicit tool calling instructions
    // These models need to be told HOW to call tools since they don't have native support
    const toolList = tools.map(t => {
      // Extract required parameters from schema
      const schema = t.inputSchema as Record<string, unknown> | undefined;
      const properties = schema?.properties as Record<string, { description?: string }> | undefined;
      const required = schema?.required as string[] | undefined;
      
      let paramInfo = '';
      if (properties) {
        const params = Object.entries(properties).map(([name, prop]) => {
          const isRequired = required?.includes(name);
          return `${name}${isRequired ? ' (required)' : ''}: ${prop.description || 'no description'}`;
        });
        if (params.length > 0) {
          paramInfo = `\n  Parameters: ${params.join('; ')}`;
        }
      }
      
      return `- ${t.name}: ${t.description || 'No description'}${paramInfo}`;
    }).join('\n');
    
    return `You are a helpful assistant that takes actions using tools. The tools WORK - you are connected to real services.

## Available Tools
${toolList}

## How This Works
1. You call a tool by outputting JSON
2. The tool executes and you receive the results  
3. You can then call another tool OR give a final answer to the user

## Strategy - Think Step by Step
- SEARCH first to find items (returns IDs and summaries)
- Then READ/GET specific items using IDs from search results
- Keep queries simple - just use what the user mentioned

## Tool Call Format
To call a tool, respond with ONLY this JSON:
{"name": "tool_name", "parameters": {"param": "value"}}

## After Getting Results
When you receive tool results:
- If results found: Summarize them for the user, or call another tool to get more details
- If empty/no results: Tell the user "No results found for X" - don't say you can't access things
- If error: Explain the error and suggest alternatives

## Critical Rules
- The tools ARE connected and working - never say "I can't access" after calling a tool
- Work one step at a time - you'll see results before the next step
- Use only real values - no placeholders like [your_email]
- After search returns IDs, you can call read/get to see full details`;
  }

  /**
   * Fix stringified JSON in tool arguments.
   * LLMs sometimes pass JSON as strings instead of actual objects/arrays.
   */
  private fixToolArguments(
    args: Record<string, unknown>,
    schema?: Record<string, unknown>
  ): Record<string, unknown> {
    const fixed: Record<string, unknown> = { ...args };
    const properties = (schema?.properties as Record<string, unknown>) || {};
    
    for (const [key, value] of Object.entries(fixed)) {
      const propSchema = properties[key] as Record<string, unknown> | undefined;
      const expectedType = propSchema?.type;
      
      if (typeof value === 'string') {
        // Coerce string to number if schema expects number/integer
        if (expectedType === 'number' || expectedType === 'integer') {
          const num = Number(value);
          if (!isNaN(num)) {
            fixed[key] = expectedType === 'integer' ? Math.floor(num) : num;
            log(`[Orchestrator] Coerced string "${value}" to ${expectedType} for key "${key}"`);
          }
        }
        // Coerce string to boolean if schema expects boolean
        else if (expectedType === 'boolean') {
          const lower = value.toLowerCase();
          if (lower === 'true' || lower === '1' || lower === 'yes') {
            fixed[key] = true;
            log(`[Orchestrator] Coerced string "${value}" to boolean true for key "${key}"`);
          } else if (lower === 'false' || lower === '0' || lower === 'no') {
            fixed[key] = false;
            log(`[Orchestrator] Coerced string "${value}" to boolean false for key "${key}"`);
          }
        }
        // If schema expects array or object, try to parse the string
        else if (expectedType === 'array' || expectedType === 'object') {
          try {
            const parsed = JSON.parse(value);
            if (expectedType === 'array' && Array.isArray(parsed)) {
              fixed[key] = parsed;
              log(`[Orchestrator] Fixed stringified array for key "${key}"`);
            } else if (expectedType === 'object' && typeof parsed === 'object' && !Array.isArray(parsed)) {
              fixed[key] = parsed;
              log(`[Orchestrator] Fixed stringified object for key "${key}"`);
            }
          } catch {
            const trimmed = value.trim();
            if ((trimmed.startsWith('[') && trimmed.endsWith(']')) ||
                (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
              try {
                const cleaned = value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                const parsed = JSON.parse(cleaned);
                fixed[key] = parsed;
                log(`[Orchestrator] Fixed escaped JSON for key "${key}"`);
              } catch {
                log(`[Orchestrator] Could not parse value for key "${key}" as JSON`);
              }
            }
          }
        }
      }
    }
    
    return fixed;
  }
  
  /**
   * Collect tools from all enabled MCP servers.
   */
  private async collectTools(serverIds: string[]): Promise<{
    tools: ToolDefinition[];
    toolMapping: ToolMapping;
  }> {
    const tools: ToolDefinition[] = [];
    const toolMapping: ToolMapping = {};
    const mcpManager = getMcpClientManager();
    
    for (const serverId of serverIds) {
      try {
        // Check if connected first
        if (!mcpManager.isConnected(serverId)) {
          log(`[Orchestrator] Skipping ${serverId} - not connected`);
          continue;
        }
        
        const mcpTools = await mcpManager.listTools(serverId);
        
        for (const mcpTool of mcpTools) {
          // Prefix tool name with server ID to avoid collisions
          const prefixedName = `${serverId}__${mcpTool.name}`;
          
          tools.push({
            name: prefixedName,
            description: mcpTool.description || `Tool from ${serverId}`,
            inputSchema: mcpTool.inputSchema || { type: 'object', properties: {} },
          });
          
          toolMapping[prefixedName] = {
            serverId,
            originalName: mcpTool.name,
            tool: mcpTool,
          };
        }
      } catch (error) {
        log(`[Orchestrator] Failed to get tools from ${serverId}: ${error}`);
      }
    }
    
    return { tools, toolMapping };
  }
  
  /**
   * Execute tool calls via MCP.
   */
  private async executeToolCalls(
    toolCalls: ToolCall[],
    toolMapping: ToolMapping
  ): Promise<ToolCallResult[]> {
    const results: ToolCallResult[] = [];
    const mcpManager = getMcpClientManager();
    
    for (const toolCall of toolCalls) {
      const prefixedName = toolCall.name;
      const mapping = toolMapping[prefixedName];
      
      if (!mapping) {
        log(`[Orchestrator] Unknown tool: ${prefixedName}`);
        results.push({
          toolCallId: toolCall.id,
          toolName: prefixedName,
          serverId: 'unknown',
          content: `Error: Unknown tool "${prefixedName}"`,
          isError: true,
        });
        continue;
      }
      
      try {
        log(`[Orchestrator] Calling tool ${mapping.originalName} on ${mapping.serverId}`);
        log(`[Orchestrator] Raw arguments: ${JSON.stringify(toolCall.arguments)}`);
        
        // Fix stringified JSON in arguments (common LLM issue)
        const fixedArguments = this.fixToolArguments(toolCall.arguments, mapping.tool.inputSchema);
        log(`[Orchestrator] Fixed arguments: ${JSON.stringify(fixedArguments)}`);
        
        // Call the tool via MCP
        const result = await mcpManager.callTool(
          mapping.serverId,
          mapping.originalName,
          fixedArguments
        );
        
        // DEBUG: Log raw result to understand what's coming back
        log(`[Orchestrator] Raw tool result for ${mapping.originalName}:`);
        log(`[Orchestrator]   result object: ${JSON.stringify(result)}`);
        log(`[Orchestrator]   result.content: ${JSON.stringify(result.content)}`);
        log(`[Orchestrator]   result.content length: ${result.content?.length ?? 'undefined'}`);
        
        // Extract text content from result
        let content = '';
        if (result.content && result.content.length > 0) {
          content = result.content
            .map(c => {
              log(`[Orchestrator]   content item: type=${c.type}, text=${c.text?.substring(0, 100)}...`);
              if (c.type === 'text') return c.text || '';
              if (c.type === 'image') return '[Image data]';
              return JSON.stringify(c);
            })
            .join('\n');
        }
        
        log(`[Orchestrator] Extracted content (first 200 chars): ${content.substring(0, 200)}`);
        log(`[Orchestrator] Content length: ${content.length}`);
        
        results.push({
          toolCallId: toolCall.id,
          toolName: mapping.originalName,
          serverId: mapping.serverId,
          content,
          isError: result.isError || false,
        });
        
      } catch (error) {
        log(`[Orchestrator] Tool call error for ${mapping.originalName}: ${error}`);
        results.push({
          toolCallId: toolCall.id,
          toolName: mapping.originalName,
          serverId: mapping.serverId,
          content: `Error: ${error}`,
          isError: true,
        });
      }
    }
    
    return results;
  }
}

// Singleton instance
let _orchestrator: ChatOrchestrator | null = null;

export function getChatOrchestrator(): ChatOrchestrator {
  if (!_orchestrator) {
    _orchestrator = new ChatOrchestrator();
  }
  return _orchestrator;
}

/**
 * Reset the singleton instance. FOR TESTING ONLY.
 */
export function __resetChatOrchestratorForTesting(): void {
  _orchestrator = null;
}
