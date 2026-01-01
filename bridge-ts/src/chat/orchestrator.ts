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
 * Mapping from tool name to server ID.
 */
interface ToolMapping {
  [toolName: string]: {
    serverId: string;
    originalName: string;
    tool: McpTool;
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
    
    // Collect tools from selected MCP servers
    const { tools, toolMapping } = await this.collectTools(serversToUse);
    log(`[Orchestrator] Collected ${tools.length} tools from ${serversToUse.length} servers`);
    
    // Main agent loop
    while (iterations < session.config.maxIterations) {
      iterations++;
      log(`[Orchestrator] Iteration ${iterations}/${session.config.maxIterations}`);
      
      try {
        // Build the request
        const systemPrompt = session.systemPrompt || this.buildSystemPrompt(tools);
        
        const request: ChatRequest = {
          messages: [...session.messages],
          tools: tools.length > 0 ? tools : undefined,
          systemPrompt,
        };
        
        // Call LLM
        const llmManager = getLLMManager();
        const response = await llmManager.chat(request);
        
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
        
        // Fallback: Check if LLM wrote tool call as text (common with some Ollama models)
        if ((!toolCalls || toolCalls.length === 0) && response.message.content) {
          log(`[Orchestrator] Checking for text-based tool call in: ${response.message.content.substring(0, 200)}`);
          const parsedToolCall = this.parseToolCallFromText(response.message.content, toolMapping);
          if (parsedToolCall) {
            log('[Orchestrator] Detected tool call written as text, converting...');
            toolCalls = [parsedToolCall];
            response.finishReason = 'tool_calls';
          } else {
            log('[Orchestrator] No text-based tool call found');
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
        
        // LLM produced a final response
        const finalContent = response.message.content || '';
        
        // Debug: Check if this looks like a tool call that should have been parsed
        let debugInfo = '';
        if (finalContent.includes('{"name"')) {
          debugInfo = ` [DEBUG: Content contains {"name" but wasn't parsed as tool call. toolCalls=${JSON.stringify(response.message.toolCalls)}, finishReason=${response.finishReason}]`;
          log(`[Orchestrator] WARNING: Final content looks like a tool call but wasn't parsed: ${finalContent.substring(0, 200)}`);
        }
        
        // Add assistant message to session
        addMessage(session, response.message);
        
        // Record final step
        const finalStep: OrchestrationStep = {
          index: steps.length,
          type: 'final',
          content: finalContent + debugInfo,
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
   * Parse a tool call from text when LLM writes it out instead of using proper format.
   * This is a fallback for models that don't support tool calling well.
   */
  private parseToolCallFromText(
    content: string, 
    toolMapping: ToolMapping
  ): ToolCall | null {
    try {
      // Find the start of JSON (look for {"name")
      const startIdx = content.indexOf('{"name"');
      log(`[Orchestrator] parseToolCall: startIdx=${startIdx}`);
      if (startIdx === -1) {
        log('[Orchestrator] parseToolCall: No {"name" found in content');
        return null;
      }
      
      // Extract from the start to the end, handling nested braces
      let braceCount = 0;
      let endIdx = startIdx;
      for (let i = startIdx; i < content.length; i++) {
        if (content[i] === '{') braceCount++;
        else if (content[i] === '}') {
          braceCount--;
          if (braceCount === 0) {
            endIdx = i + 1;
            break;
          }
        }
      }
      
      const jsonStr = content.slice(startIdx, endIdx);
      log(`[Orchestrator] parseToolCall: Extracted JSON: ${jsonStr}`);
      
      const parsed = JSON.parse(jsonStr);
      log(`[Orchestrator] parseToolCall: Parsed object: ${JSON.stringify(parsed)}`);
      
      if (parsed.name) {
        const toolName = parsed.name as string;
        // Accept parameters, arguments, or no args at all (empty object)
        const args = (parsed.parameters || parsed.arguments || {}) as Record<string, unknown>;
        
        log(`[Orchestrator] parseToolCall: Looking for tool "${toolName}" in mapping`);
        log(`[Orchestrator] parseToolCall: Available tools: ${Object.keys(toolMapping).join(', ')}`);
        
        // Verify this is a known tool
        if (toolMapping[toolName]) {
          log(`[Orchestrator] Successfully parsed text tool call: ${toolName} with args: ${JSON.stringify(args)}`);
          return {
            id: `text_call_${Date.now()}`,
            name: toolName,
            arguments: args,
          };
        } else {
          log(`[Orchestrator] Tool not found in mapping: ${toolName}`);
        }
      } else {
        log('[Orchestrator] parseToolCall: parsed.name is falsy');
      }
    } catch (e) {
      // Not valid JSON or wrong format
      log(`[Orchestrator] Failed to parse tool call from text: ${e}`);
    }
    
    return null;
  }

  /**
   * Build a system prompt that helps the LLM use tools correctly.
   */
  private buildSystemPrompt(tools: ToolDefinition[]): string {
    if (tools.length === 0) {
      return 'You are a helpful assistant.';
    }
    
    // Group tools by server prefix
    const toolsByServer: Record<string, ToolDefinition[]> = {};
    for (const tool of tools) {
      // Tool names are prefixed like "server_id__tool_name"
      const parts = tool.name.split('__');
      const serverId = parts.length > 1 ? parts[0] : 'unknown';
      if (!toolsByServer[serverId]) {
        toolsByServer[serverId] = [];
      }
      toolsByServer[serverId].push(tool);
    }
    
    let serverInfo = '';
    for (const [serverId, serverTools] of Object.entries(toolsByServer)) {
      const toolList = serverTools.map(t => {
        const shortName = t.name.split('__').pop() || t.name;
        return `  - ${shortName}: ${t.description || 'No description'}`;
      }).join('\n');
      serverInfo += `\n${serverId}:\n${toolList}\n`;
    }
    
    return `You are a helpful assistant with access to tools. When the user asks you to do something that requires using a tool, you MUST call the appropriate tool - do not describe how to use tools or ask the user to call them.

AVAILABLE TOOLS BY SERVER:
${serverInfo}
INSTRUCTIONS:
- When the user's request can be fulfilled by calling a tool, CALL the tool directly.
- Do NOT describe how to use tools or write out tool calls as text.
- Do NOT ask the user to call tools themselves.
- If a tool returns an error, read the error message carefully and adjust your approach.
- Use discovery tools (like list_allowed_directories) to learn about the environment before making assumptions.`;
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
      if (typeof value === 'string') {
        const propSchema = properties[key] as Record<string, unknown> | undefined;
        const expectedType = propSchema?.type;
        
        // If schema expects array or object, try to parse the string
        if (expectedType === 'array' || expectedType === 'object') {
          try {
            // Try to parse as JSON
            const parsed = JSON.parse(value);
            if (expectedType === 'array' && Array.isArray(parsed)) {
              fixed[key] = parsed;
              log(`[Orchestrator] Fixed stringified array for key "${key}"`);
            } else if (expectedType === 'object' && typeof parsed === 'object' && !Array.isArray(parsed)) {
              fixed[key] = parsed;
              log(`[Orchestrator] Fixed stringified object for key "${key}"`);
            }
          } catch {
            // Not valid JSON, try to detect if it looks like JSON
            const trimmed = value.trim();
            if ((trimmed.startsWith('[') && trimmed.endsWith(']')) ||
                (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
              // Looks like JSON but failed to parse - try cleaning it
              try {
                // Sometimes LLMs add escape characters
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
