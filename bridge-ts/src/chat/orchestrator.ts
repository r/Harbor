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
import { ChatSession, addMessage, PluginToolDefinition } from './session.js';
import { McpTool } from '../types.js';
import { getToolRouter, RoutingResult } from './tool-router.js';

/**
 * Pending plugin tool call that needs execution by the extension.
 */
export interface PendingPluginToolCall {
  /** Tool call ID */
  id: string;

  /** Plugin ID */
  pluginId: string;

  /** Tool name */
  toolName: string;

  /** Arguments */
  arguments: Record<string, unknown>;
}

/**
 * Result of a plugin tool execution from the extension.
 */
export interface PluginToolResult {
  /** Tool call ID */
  toolCallId: string;

  /** Result content */
  content: string;

  /** Whether the call errored */
  isError: boolean;
}

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

  /** Whether orchestration is paused waiting for plugin tools */
  paused?: boolean;

  /** Plugin tool calls that need to be executed by the extension */
  pendingPluginToolCalls?: PendingPluginToolCall[];
}

/**
 * Mapping from tool name to its source (MCP server or plugin).
 */
interface ToolMapping {
  [toolName: string]: {
    /** 'mcp' for MCP server tools, 'plugin' for extension plugin tools */
    type: 'mcp' | 'plugin';
    /** Server ID for MCP tools */
    serverId?: string;
    /** Plugin ID for plugin tools */
    pluginId?: string;
    /** Original tool name (without prefix) */
    originalName: string;
    /** MCP tool definition (for MCP tools) */
    tool?: McpTool;
    /** Plugin tool definition (for plugin tools) */
    pluginTool?: PluginToolDefinition;
  };
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
    
    // Collect tools from selected MCP servers and plugins
    const { tools, toolMapping } = await this.collectTools(serversToUse, session.pluginTools);
    const mcpToolCount = tools.filter(t => !t.name.startsWith('plugin__')).length;
    const pluginToolCount = tools.length - mcpToolCount;
    log(`[Orchestrator] Collected ${tools.length} tools (${mcpToolCount} MCP, ${pluginToolCount} plugin)`);
    
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
        
        // Build the request - use provider-specific system prompt
        const systemPrompt = session.systemPrompt || this.buildSystemPrompt(tools, activeProvider);
        
        const request: ChatRequest = {
          messages: [...session.messages],
          tools: tools.length > 0 ? tools : undefined,
          systemPrompt,
        };
        log(`[Orchestrator] Calling LLM: provider=${activeProvider}, model=${activeModel}, tools=${tools.length}`);
        
        const response = await llmManager.chat(request);
        
        // Log the LLM response details
        log(`[Orchestrator] LLM response: finishReason=${response.finishReason}, toolCalls=${response.message.toolCalls?.length || 0}, content=${response.message.content?.substring(0, 100)}`);
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
          log(`[Orchestrator] Full LLM response (first 500 chars): ${response.message.content.substring(0, 500)}`);
          const parsedToolCall = this.parseToolCallFromText(response.message.content, toolMapping);
          if (parsedToolCall) {
            log('[Orchestrator] Detected tool call written as text, converting...');
            log(`[Orchestrator] Parsed tool: ${parsedToolCall.name} with args: ${JSON.stringify(parsedToolCall.arguments)}`);
            toolCalls = [parsedToolCall];
            response.finishReason = 'tool_calls';
          } else {
            log('[Orchestrator] No text-based tool call found - model may not support tool calling');
            log('[Orchestrator] Available tool names: ' + Object.keys(toolMapping).join(', '));
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

          // Execute tool calls (MCP tools executed, plugin tools returned for extension)
          const { results: toolResults, pendingPluginCalls } = await this.executeToolCalls(toolCalls, toolMapping);

          // If there are pending plugin tool calls, pause and return them
          if (pendingPluginCalls.length > 0) {
            log(`[Orchestrator] Pausing for ${pendingPluginCalls.length} plugin tool calls`);

            // Still record any MCP tool results we got
            if (toolResults.length > 0) {
              const toolResultStep: OrchestrationStep = {
                index: steps.length,
                type: 'tool_results',
                toolResults,
                timestamp: Date.now(),
              };
              steps.push(toolResultStep);
              onStep?.(toolResultStep);

              // Add MCP tool results to conversation
              for (const result of toolResults) {
                const toolMsg: ChatMessage = {
                  role: 'tool',
                  content: result.content,
                  toolCallId: result.toolCallId,
                };
                addMessage(session, toolMsg);
              }
            }

            // Return paused state with pending plugin calls
            return {
              finalResponse: '',
              steps,
              iterations,
              reachedMaxIterations: false,
              durationMs: Date.now() - startTime,
              routing: routingResult,
              paused: true,
              pendingPluginToolCalls: pendingPluginCalls,
            };
          }

          // Record tool results step (only MCP results)
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
        const finalContent = this.cleanLLMTokens(response.message.content || '');
        
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
   * Continue orchestration after plugin tool results are provided.
   *
   * @param session - The chat session
   * @param pluginResults - Results from plugin tool executions
   * @param onStep - Optional callback for each step
   */
  async continueWithPluginResults(
    session: ChatSession,
    pluginResults: PluginToolResult[],
    onStep?: (step: OrchestrationStep) => void
  ): Promise<OrchestrationResult> {
    log(`[Orchestrator] Continuing with ${pluginResults.length} plugin tool results`);

    // Add plugin tool results to conversation
    for (const result of pluginResults) {
      const toolMsg: ChatMessage = {
        role: 'tool',
        content: result.content,
        toolCallId: result.toolCallId,
      };
      addMessage(session, toolMsg);
    }

    // Continue orchestration from where we left off
    // We call run() with an empty message since the tool results are already added
    // Actually, we need to continue the loop - let's just call run with a synthetic continuation
    return this.runContinuation(session, onStep);
  }

  /**
   * Internal method to continue orchestration after tool results.
   * Similar to run() but doesn't add a user message.
   */
  private async runContinuation(
    session: ChatSession,
    onStep?: (step: OrchestrationStep) => void
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const steps: OrchestrationStep[] = [];
    let iterations = 0;

    log(`[Orchestrator] Running continuation for session ${session.id}`);

    // Collect tools from enabled servers and plugins
    const { tools, toolMapping } = await this.collectTools(session.enabledServers, session.pluginTools);

    // Main agent loop
    while (iterations < session.config.maxIterations) {
      iterations++;
      log(`[Orchestrator] Continuation iteration ${iterations}/${session.config.maxIterations}`);

      try {
        const llmManager = getLLMManager();
        const activeProvider = llmManager.getActiveId();

        const systemPrompt = session.systemPrompt || this.buildSystemPrompt(tools, activeProvider);

        const request: ChatRequest = {
          messages: [...session.messages],
          tools: tools.length > 0 ? tools : undefined,
          systemPrompt,
        };

        const response = await llmManager.chat(request);

        if (response.finishReason === 'error') {
          return {
            finalResponse: `Error: ${response.error || 'Unknown LLM error'}`,
            steps,
            iterations,
            reachedMaxIterations: false,
            durationMs: Date.now() - startTime,
          };
        }

        let toolCalls = response.message.toolCalls;

        // Fallback for text-based tool calls
        if ((!toolCalls || toolCalls.length === 0) && response.message.content) {
          const parsedToolCall = this.parseToolCallFromText(response.message.content, toolMapping);
          if (parsedToolCall) {
            toolCalls = [parsedToolCall];
            response.finishReason = 'tool_calls';
          }
        }

        if (response.finishReason === 'tool_calls' && toolCalls?.length) {
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

          addMessage(session, response.message);

          const { results: toolResults, pendingPluginCalls } = await this.executeToolCalls(toolCalls, toolMapping);

          // If there are pending plugin calls, pause again
          if (pendingPluginCalls.length > 0) {
            if (toolResults.length > 0) {
              for (const result of toolResults) {
                addMessage(session, {
                  role: 'tool',
                  content: result.content,
                  toolCallId: result.toolCallId,
                });
              }
            }

            return {
              finalResponse: '',
              steps,
              iterations,
              reachedMaxIterations: false,
              durationMs: Date.now() - startTime,
              paused: true,
              pendingPluginToolCalls: pendingPluginCalls,
            };
          }

          // Add results to conversation
          for (const result of toolResults) {
            addMessage(session, {
              role: 'tool',
              content: result.content,
              toolCallId: result.toolCallId,
            });
          }

          continue;
        }

        // Final response
        const finalContent = this.cleanLLMTokens(response.message.content || '');
        addMessage(session, response.message);

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
        };

      } catch (error) {
        return {
          finalResponse: `I encountered an error: ${error}`,
          steps,
          iterations,
          reachedMaxIterations: false,
          durationMs: Date.now() - startTime,
        };
      }
    }

    return {
      finalResponse: 'I reached the maximum number of steps.',
      steps,
      iterations,
      reachedMaxIterations: true,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Parse a tool call from text when LLM writes it out instead of using proper format.
   * This is a fallback for models that don't support tool calling well.
   * 
   * Handles multiple formats:
   * 1. {"name": "tool_name", "parameters": {...}} or {"name": "tool_name", "arguments": {...}}
   * 2. "tool_name": {...args...}  (common LLM format)
   * 3. tool_name({...args...}) (function call style)
   */
  private parseToolCallFromText(
    content: string, 
    toolMapping: ToolMapping
  ): ToolCall | null {
    // Clean up LLM special tokens (Llama, Mistral, etc.)
    let cleanedContent = this.cleanLLMTokens(content);
    
    // Extract JSON from markdown code blocks if present
    // Handles ```json ... ``` or ``` ... ```
    const codeBlockMatch = cleanedContent.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      cleanedContent = codeBlockMatch[1].trim();
      log(`[Orchestrator] parseToolCall: Extracted JSON from code block`);
    }
    
    log(`[Orchestrator] parseToolCall: Attempting to parse: ${cleanedContent.substring(0, 300)}`);
    
    const toolNames = Object.keys(toolMapping);
    
    // Format 1: {"name": "tool_name", ...}
    const result1 = this.tryParseNameFormat(cleanedContent, toolMapping);
    if (result1) return result1;
    
    // Format 2: "tool_name": {...} or tool_name: {...}
    const result2 = this.tryParseKeyValueFormat(cleanedContent, toolNames, toolMapping);
    if (result2) return result2;
    
    // Format 3: tool_name({...}) function call style
    const result3 = this.tryParseFunctionCallFormat(cleanedContent, toolNames, toolMapping);
    if (result3) return result3;
    
    // Format 4: Check if LLM mentioned a tool name and we can extract params
    const result4 = this.tryParseLooseFormat(cleanedContent, toolNames, toolMapping);
    if (result4) return result4;
    
    // Format 5: Just tool name by itself (for tools with no required parameters)
    // Handles cases like "get_me" or "get_me()" with no JSON
    const result5 = this.tryParseBareToolName(cleanedContent, toolNames, toolMapping);
    if (result5) return result5;
    
    log('[Orchestrator] parseToolCall: No valid tool call format found');
    return null;
  }
  
  /**
   * Try to parse {"name": "tool_name", "parameters": {...}} format.
   */
  private tryParseNameFormat(content: string, toolMapping: ToolMapping): ToolCall | null {
    try {
      // Look for {"name" or { "name" (with whitespace)
      let startIdx = content.indexOf('{"name"');
      if (startIdx === -1) {
        // Try with whitespace/newlines between { and "name"
        const match = content.match(/\{\s*"name"/);
        if (match && match.index !== undefined) {
          startIdx = match.index;
        }
      }
      if (startIdx === -1) return null;
      
      const jsonStr = this.extractJsonObject(content, startIdx);
      if (!jsonStr) {
        log(`[Orchestrator] tryParseNameFormat: Could not extract JSON object`);
        return null;
      }
      
      log(`[Orchestrator] tryParseNameFormat: Extracted JSON: ${jsonStr}`);
      
      const parsed = JSON.parse(jsonStr);
      if (parsed.name) {
        log(`[Orchestrator] tryParseNameFormat: Looking for tool "${parsed.name}"`);
        log(`[Orchestrator] tryParseNameFormat: Available tools: ${Object.keys(toolMapping).join(', ')}`);
        
        // Try exact match first
        let matchedName = toolMapping[parsed.name] ? parsed.name : null;
        
        // If not found, try to find a prefixed version (server__toolname)
        if (!matchedName) {
          for (const prefixedName of Object.keys(toolMapping)) {
            const shortName = prefixedName.split('__').pop();
            if (shortName === parsed.name) {
              matchedName = prefixedName;
              log(`[Orchestrator] Matched unprefixed name "${parsed.name}" to "${prefixedName}"`);
              break;
            }
            // Also try matching if the model used a similar prefix
            // e.g., model outputs "github__search" but actual is "github-npm__search"
            const modelPrefix = parsed.name.split('__')[0];
            const actualPrefix = prefixedName.split('__')[0];
            const modelTool = parsed.name.split('__').slice(1).join('__');
            const actualTool = prefixedName.split('__').slice(1).join('__');
            if (modelTool && actualTool && modelTool === actualTool) {
              // Tool name matches, just prefix is different
              log(`[Orchestrator] Tool name matches but prefix differs: model="${modelPrefix}" actual="${actualPrefix}"`);
              matchedName = prefixedName;
              break;
            }
          }
        }
        
        if (matchedName) {
          const args = (parsed.parameters || parsed.arguments || {}) as Record<string, unknown>;
          log(`[Orchestrator] Parsed name format: ${matchedName} with args: ${JSON.stringify(args)}`);
          return {
            id: `text_call_${Date.now()}`,
            name: matchedName,
            arguments: args,
          };
        } else {
          log(`[Orchestrator] tryParseNameFormat: No matching tool found for "${parsed.name}"`);
        }
      }
    } catch (e) {
      log(`[Orchestrator] tryParseNameFormat failed: ${e}`);
    }
    return null;
  }
  
  /**
   * Try to parse "tool_name": {...} or tool_name: {...} format.
   */
  private tryParseKeyValueFormat(
    content: string, 
    toolNames: string[], 
    toolMapping: ToolMapping
  ): ToolCall | null {
    // Build a list of both prefixed and short names to search for
    const namesToSearch: { searchName: string; prefixedName: string }[] = [];
    for (const prefixedName of toolNames) {
      namesToSearch.push({ searchName: prefixedName, prefixedName });
      // Also add short name (without server prefix)
      const shortName = prefixedName.split('__').pop();
      if (shortName && shortName !== prefixedName) {
        namesToSearch.push({ searchName: shortName, prefixedName });
      }
    }
    
    for (const { searchName, prefixedName } of namesToSearch) {
      // Look for "tool_name": { or tool_name: {
      const escapedName = searchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const patterns = [
        `"${escapedName}":\\s*\\{`,
        `${escapedName}:\\s*\\{`,
        `\`${escapedName}\`:\\s*\\{`,
      ];
      
      for (const pattern of patterns) {
        const regex = new RegExp(pattern);
        const match = content.match(regex);
        if (match && match.index !== undefined) {
          try {
            // Find the { after the tool name
            const braceStart = content.indexOf('{', match.index);
            if (braceStart === -1) continue;
            
            const jsonStr = this.extractJsonObject(content, braceStart);
            if (!jsonStr) continue;
            
            const args = JSON.parse(jsonStr);
            log(`[Orchestrator] Parsed key-value format for: ${searchName} -> ${prefixedName}`);
            return {
              id: `text_call_${Date.now()}`,
              name: prefixedName,
              arguments: args as Record<string, unknown>,
            };
          } catch (e) {
            log(`[Orchestrator] tryParseKeyValueFormat failed for ${searchName}: ${e}`);
          }
        }
      }
    }
    return null;
  }
  
  /**
   * Try to parse tool_name({...}) function call format.
   */
  private tryParseFunctionCallFormat(
    content: string, 
    toolNames: string[], 
    toolMapping: ToolMapping
  ): ToolCall | null {
    // Build a list of both prefixed and short names to search for
    const namesToSearch: { searchName: string; prefixedName: string }[] = [];
    for (const prefixedName of toolNames) {
      namesToSearch.push({ searchName: prefixedName, prefixedName });
      // Also add short name (without server prefix)
      const shortName = prefixedName.split('__').pop();
      if (shortName && shortName !== prefixedName) {
        namesToSearch.push({ searchName: shortName, prefixedName });
      }
    }
    
    for (const { searchName, prefixedName } of namesToSearch) {
      const pattern = new RegExp(`${searchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(\\s*\\{`);
      const match = content.match(pattern);
      if (match && match.index !== undefined) {
        try {
          const braceStart = content.indexOf('{', match.index);
          if (braceStart === -1) continue;
          
          const jsonStr = this.extractJsonObject(content, braceStart);
          if (!jsonStr) continue;
          
          const args = JSON.parse(jsonStr);
          log(`[Orchestrator] Parsed function call format for: ${searchName} -> ${prefixedName}`);
          return {
            id: `text_call_${Date.now()}`,
            name: prefixedName,
            arguments: args as Record<string, unknown>,
          };
        } catch (e) {
          log(`[Orchestrator] tryParseFunctionCallFormat failed for ${searchName}: ${e}`);
        }
      }
    }
    return null;
  }
  
  /**
   * Try to loosely match tool names and extract any JSON object as parameters.
   */
  private tryParseLooseFormat(
    content: string, 
    toolNames: string[], 
    toolMapping: ToolMapping
  ): ToolCall | null {
    const contentLower = content.toLowerCase();
    
    for (const prefixedName of toolNames) {
      // Get short name for matching
      const shortName = prefixedName.split('__').pop() || prefixedName;
      
      // Check if tool name is mentioned (case insensitive, with or without underscores)
      const normalizedTool = prefixedName.toLowerCase().replace(/__/g, '_');
      const normalizedShort = shortName.toLowerCase().replace(/_/g, ' '); // "get_current_time" -> "get current time"
      const shortLower = shortName.toLowerCase();
      
      if (contentLower.includes(normalizedTool) || 
          contentLower.includes(prefixedName.toLowerCase()) ||
          contentLower.includes(shortLower) ||
          contentLower.includes(normalizedShort)) {
        // Find the first JSON object in the content
        const braceStart = content.indexOf('{');
        if (braceStart === -1) continue;
        
        try {
          const jsonStr = this.extractJsonObject(content, braceStart);
          if (!jsonStr) continue;
          
          const parsed = JSON.parse(jsonStr);
          // Make sure it looks like arguments (not a meta-object with name/tool which we handle elsewhere)
          if (parsed && typeof parsed === 'object' && !parsed.name && !parsed.tool) {
            log(`[Orchestrator] Parsed loose format for: ${shortName} -> ${prefixedName}`);
            return {
              id: `text_call_${Date.now()}`,
              name: prefixedName,
              arguments: parsed as Record<string, unknown>,
            };
          }
        } catch (e) {
          log(`[Orchestrator] tryParseLooseFormat failed for ${prefixedName}: ${e}`);
        }
      }
    }
    return null;
  }
  
  /**
   * Try to parse a bare tool name (with no parameters).
   * Handles: "get_me", "get_me()", tool names embedded in text like "I'll call get_me now"
   */
  private tryParseBareToolName(
    content: string, 
    toolNames: string[], 
    toolMapping: ToolMapping
  ): ToolCall | null {
    const contentTrimmed = content.trim();
    const contentLower = contentTrimmed.toLowerCase();
    
    // Build list of names to check (both prefixed and short)
    const namesToSearch: { searchName: string; prefixedName: string }[] = [];
    for (const prefixedName of toolNames) {
      namesToSearch.push({ searchName: prefixedName, prefixedName });
      const shortName = prefixedName.split('__').pop();
      if (shortName && shortName !== prefixedName) {
        namesToSearch.push({ searchName: shortName, prefixedName });
      }
    }
    
    // Sort by name length (longer names first) to avoid partial matches
    namesToSearch.sort((a, b) => b.searchName.length - a.searchName.length);
    
    for (const { searchName, prefixedName } of namesToSearch) {
      const searchLower = searchName.toLowerCase();
      
      // Check for exact match (content is just the tool name)
      if (contentLower === searchLower || 
          contentLower === `${searchLower}()` || 
          contentLower === `${searchLower}({})`) {
        log(`[Orchestrator] Parsed bare tool name (exact): ${searchName} -> ${prefixedName}`);
        return {
          id: `text_call_${Date.now()}`,
          name: prefixedName,
          arguments: {},
        };
      }
      
      // Check for tool name at word boundaries in short content (< 100 chars suggests just calling a tool)
      // Only do this check if content is short enough to be a tool call response
      if (contentTrimmed.length < 100 && contentTrimmed.length > 0) {
        // Simple check: look for the tool name as a standalone word
        // Escape special regex characters in the tool name
        const escaped = searchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        try {
          const pattern = new RegExp(`(?:^|\\s)${escaped}(?:\\s*\\(\\s*\\{?\\s*\\}?\\s*\\))?(?:\\s|$)`, 'i');
          if (pattern.test(contentTrimmed)) {
            log(`[Orchestrator] Parsed bare tool name (word boundary): ${searchName} -> ${prefixedName}`);
            return {
              id: `text_call_${Date.now()}`,
              name: prefixedName,
              arguments: {},
            };
          }
        } catch {
          // Invalid regex, skip
          log(`[Orchestrator] Invalid regex for tool name: ${searchName}`);
        }
      }
    }
    
    return null;
  }
  
  /**
   * Extract a balanced JSON object starting at a given index.
   */
  private extractJsonObject(content: string, startIdx: number): string | null {
    let braceCount = 0;
    let endIdx = startIdx;
    let inString = false;
    let escapeNext = false;
    
    for (let i = startIdx; i < content.length; i++) {
      const char = content[i];
      
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      
      if (char === '\\' && inString) {
        escapeNext = true;
        continue;
      }
      
      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }
      
      if (!inString) {
        if (char === '{') braceCount++;
        else if (char === '}') {
          braceCount--;
          if (braceCount === 0) {
            endIdx = i + 1;
            break;
          }
        }
      }
    }
    
    if (braceCount !== 0) {
      log(`[Orchestrator] extractJsonObject: Unbalanced braces`);
      return null;
    }
    
    return content.slice(startIdx, endIdx);
  }

  /**
   * Clean LLM special tokens from output.
   * These tokens (like <|eot_id|>) sometimes leak into responses from local models.
   */
  private cleanLLMTokens(content: string): string {
    return content
      .replace(/<\|eot_id\|>/g, '')
      .replace(/<\|end_of_text\|>/g, '')
      .replace(/<\|begin_of_text\|>/g, '')
      .replace(/<\|start_header_id\|>.*?<\|end_header_id\|>/g, '')
      .replace(/<\|im_end\|>/g, '')
      .replace(/<\|im_start\|>/g, '')
      .replace(/<\/s>/g, '')
      .replace(/<s>/g, '')
      .trim();
  }

  /**
   * Build a system prompt that helps the LLM use tools correctly.
   * 
   * For providers with native tool calling (OpenAI, Anthropic), keep it simple.
   * For providers without native tool calling (llamafile), include explicit
   * instructions on how to format tool calls as JSON.
   */
  private buildSystemPrompt(tools: ToolDefinition[], provider?: string | null): string {
    if (tools.length === 0) {
      return 'You are a helpful assistant.';
    }
    
    // Providers that have native tool calling support
    const nativeToolCallingProviders = ['openai', 'anthropic', 'mistral', 'groq'];
    
    if (provider && nativeToolCallingProviders.includes(provider)) {
      // Simple prompt for native tool calling - don't confuse the model
      return `You are a helpful AI assistant with access to tools. When the user asks a question that can be answered using a tool, call the appropriate tool. Do not say you cannot help - use the available tools instead.`;
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
          paramInfo = ` | Parameters: ${params.join(', ')}`;
        }
      }
      
      return `- ${t.name}: ${t.description || 'No description'}${paramInfo}`;
    }).join('\n');
    
    return `You are an AI assistant that MUST use tools to answer questions. You cannot answer from memory - you MUST call a tool first.

## Available Tools
${toolList}

## IMPORTANT: You MUST call a tool
- Do NOT answer questions directly - ALWAYS call a tool first
- Do NOT make up information - use tools to get real data
- Output ONLY the JSON tool call, nothing else

## Tool Call Format
{"name": "exact_tool_name_from_list", "parameters": {"param": "value"}}

## After Receiving Tool Results  
Summarize the results in plain language for the user.`;
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
   * Collect tools from all enabled MCP servers and plugin tools.
   */
  private async collectTools(
    serverIds: string[],
    pluginTools: PluginToolDefinition[] = []
  ): Promise<{
    tools: ToolDefinition[];
    toolMapping: ToolMapping;
  }> {
    const tools: ToolDefinition[] = [];
    const toolMapping: ToolMapping = {};
    const mcpManager = getMcpClientManager();

    // Collect MCP server tools
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
            type: 'mcp',
            serverId,
            originalName: mcpTool.name,
            tool: mcpTool,
          };
        }
      } catch (error) {
        log(`[Orchestrator] Failed to get tools from ${serverId}: ${error}`);
      }
    }

    // Collect plugin tools
    for (const pluginTool of pluginTools) {
      // Use plugin__toolname format for consistency
      const prefixedName = `plugin__${pluginTool.name}`;

      tools.push({
        name: prefixedName,
        description: pluginTool.description || `Plugin tool ${pluginTool.name}`,
        inputSchema: pluginTool.inputSchema || { type: 'object', properties: {} },
      });

      toolMapping[prefixedName] = {
        type: 'plugin',
        pluginId: pluginTool.pluginId,
        originalName: pluginTool.name,
        pluginTool,
      };
    }

    return { tools, toolMapping };
  }
  
  /**
   * Execute tool calls - MCP tools are executed directly, plugin tools are returned for extension.
   */
  private async executeToolCalls(
    toolCalls: ToolCall[],
    toolMapping: ToolMapping
  ): Promise<{
    results: ToolCallResult[];
    pendingPluginCalls: PendingPluginToolCall[];
  }> {
    const results: ToolCallResult[] = [];
    const pendingPluginCalls: PendingPluginToolCall[] = [];
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

      // Handle plugin tools - return them for extension to execute
      if (mapping.type === 'plugin') {
        log(`[Orchestrator] Plugin tool call: ${mapping.originalName} (plugin: ${mapping.pluginId})`);

        // Fix arguments before returning
        const schema = mapping.pluginTool?.inputSchema;
        const fixedArguments = this.fixToolArguments(toolCall.arguments, schema);

        pendingPluginCalls.push({
          id: toolCall.id,
          pluginId: mapping.pluginId!,
          toolName: mapping.originalName,
          arguments: fixedArguments,
        });
        continue;
      }

      // Handle MCP tools - execute directly
      try {
        log(`[Orchestrator] Calling MCP tool ${mapping.originalName} on ${mapping.serverId}`);
        log(`[Orchestrator] Raw arguments: ${JSON.stringify(toolCall.arguments)}`);

        // Fix stringified JSON in arguments (common LLM issue)
        const fixedArguments = this.fixToolArguments(toolCall.arguments, mapping.tool?.inputSchema);
        log(`[Orchestrator] Fixed arguments: ${JSON.stringify(fixedArguments)}`);

        // Call the tool via MCP
        const result = await mcpManager.callTool(
          mapping.serverId!,
          mapping.originalName,
          fixedArguments
        );

        // Extract text content from result
        let content = '';
        if (result.content && result.content.length > 0) {
          content = result.content
            .map(c => {
              if (c.type === 'text') return c.text || '';
              if (c.type === 'image') return '[Image data]';
              return JSON.stringify(c);
            })
            .join('\n');
        }

        results.push({
          toolCallId: toolCall.id,
          toolName: mapping.originalName,
          serverId: mapping.serverId!,
          content,
          isError: result.isError || false,
        });

      } catch (error) {
        log(`[Orchestrator] Tool call error for ${mapping.originalName}: ${error}`);
        results.push({
          toolCallId: toolCall.id,
          toolName: mapping.originalName,
          serverId: mapping.serverId || 'unknown',
          content: `Error: ${error}`,
          isError: true,
        });
      }
    }

    return { results, pendingPluginCalls };
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
