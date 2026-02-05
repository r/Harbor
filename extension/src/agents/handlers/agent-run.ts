/**
 * Agent run handler - autonomous task execution with tool calling.
 */

import type { RequestContext, ResponseSender } from './router-types';
import { log } from './helpers';
import { checkPermissions } from '../../policy/permissions';
import { listServersWithStatus, callTool } from '../../mcp/host';
import { bridgeRequest } from '../../llm/bridge-client';

/**
 * Handle agent.run - Execute an autonomous agent task.
 */
export async function handleAgentRun(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  log('handleAgentRun called for:', ctx.id);
  
  // Check permission for model:tools
  const permCheck = await checkPermissions(ctx.origin, ['model:tools'], ctx.tabId);
  log('Permission check result:', permCheck);
  
  if (!permCheck.granted) {
    log('Permission denied, sending error stream event');
    sender.sendStreamEvent({
      id: ctx.id,
      event: {
        type: 'error',
        error: {
          code: 'ERR_SCOPE_REQUIRED',
          message: 'Permission "model:tools" is required. Call agent.requestPermissions() first.',
        },
      },
      done: true,
    });
    return;
  }

  const payload = ctx.payload as {
    task: string;
    tools?: string[];
    useAllTools?: boolean;
    maxToolCalls?: number;
  };
  log('Payload:', payload);

  try {
    // Send status event
    log('Sending status event: Starting agent...');
    sender.sendStreamEvent({
      id: ctx.id,
      event: { type: 'status', message: 'Starting agent...' },
    });

    // Get available tools
    log('Getting available tools...');
    const servers = await listServersWithStatus();
    log('Servers:', servers.map(s => ({ id: s.id, running: s.running, tools: s.tools?.length })));
    const availableTools: Array<{ name: string; serverId: string; description?: string; inputSchema?: Record<string, unknown> }> = [];
    
    for (const server of servers) {
      if (server.running && server.tools) {
        for (const tool of server.tools) {
          availableTools.push({
            name: `${server.id}/${tool.name}`,
            serverId: server.id,
            description: tool.description,
            inputSchema: tool.inputSchema,
          });
        }
      }
    }

    // Filter tools if specific ones requested
    let toolsToUse = availableTools;
    if (payload.tools && payload.tools.length > 0 && !payload.useAllTools) {
      toolsToUse = availableTools.filter(t => payload.tools!.includes(t.name));
    }

    if (toolsToUse.length === 0) {
      sender.sendStreamEvent({
        id: ctx.id,
        event: { type: 'status', message: 'No tools available, running without tools...' },
      });
    }

    // Build messages for LLM
    const toolNames = toolsToUse.map(t => t.name.replace('/', '_')).join(', ');
    const systemPrompt = toolsToUse.length > 0
      ? `You are a helpful assistant with access to tools. For each user query:
1. If you can answer directly, respond without using tools.
2. If you need external data, call the appropriate tool.
3. When you receive a tool result, use that information to respond to the user.
Available tools: ${toolNames}`
      : 'You are a helpful assistant.';
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: any }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: payload.task },
    ];

    // Build tools array for LLM (bridge expects {name, description, input_schema})
    const llmTools = toolsToUse.map(t => ({
      name: t.name.replace('/', '_'), // LLM-safe name
      description: t.description || `Tool: ${t.name}`,
      input_schema: t.inputSchema || { type: 'object', properties: {} },
    }));

    const maxToolCalls = payload.maxToolCalls || 5;
    let toolCallCount = 0;

    log('Tools to use:', toolsToUse.map(t => t.name));
    log('LLM tools:', llmTools);

    // Agent loop
    while (toolCallCount < maxToolCalls) {
      log('Agent loop iteration:', toolCallCount);
      sender.sendStreamEvent({
        id: ctx.id,
        event: { type: 'status', message: toolCallCount === 0 ? 'Thinking...' : 'Continuing...' },
      });

      // Call LLM
      log('Calling LLM with messages:', messages.length, 'tools:', llmTools.length);
      const llmResult = await bridgeRequest<{
        choices?: Array<{
          message: {
            role: string;
            content: string;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
          };
          finish_reason?: string;
        }>;
      }>('llm.chat', {
        messages,
        tools: llmTools.length > 0 ? llmTools : undefined,
      });

      log('LLM result received:', llmResult);
      
      // Extract response from choices[0].message (standard OpenAI format)
      const choice = llmResult.choices?.[0];
      if (!choice) {
        throw new Error('No response from LLM');
      }
      
      const response = choice.message;
      const toolCalls = response.tool_calls;
      log('Response:', response);
      log('Tool calls:', toolCalls);
      log('Finish reason:', choice.finish_reason);

      // Add assistant message to history
      // WORKAROUND: Bridge doesn't support tool_calls in messages, so we encode 
      // the tool call info in the content so the LLM knows what it called
      if (toolCalls && toolCalls.length > 0) {
        const toolCallSummary = toolCalls.map(tc => 
          `[Called tool: ${tc.function.name}(${tc.function.arguments})]`
        ).join('\n');
        messages.push({
          role: 'assistant',
          content: toolCallSummary,
        });
      } else {
        messages.push({
          role: 'assistant', 
          content: response.content ?? '',
        });
      }

      // If no tool calls, we're done
      if (!toolCalls || toolCalls.length === 0) {
        log('No tool calls, sending final event');
        sender.sendStreamEvent({
          id: ctx.id,
          event: {
            type: 'final',
            output: response.content || '',
          },
          done: true,
        });
        return;
      }

      // Process tool calls
      for (const toolCall of toolCalls) {
        toolCallCount++;
        
        // Convert LLM-safe name back to original
        const toolName = toolCall.function.name.replace('_', '/');
        let args: Record<string, unknown> = {};
        
        try {
          args = JSON.parse(toolCall.function.arguments || '{}');
        } catch {
          args = {};
        }

        // Send tool_call event
        sender.sendStreamEvent({
          id: ctx.id,
          event: {
            type: 'tool_call',
            tool: toolName,
            args,
          },
        });

        // Find the tool and call it
        const tool = toolsToUse.find(t => t.name === toolName);
        log('Looking for tool:', toolName, 'Found:', !!tool);
        let toolResult: { ok: boolean; result?: unknown; error?: string };
        
        if (tool) {
          try {
            log('Calling tool:', tool.serverId, toolName.split('/')[1] || toolName, args);
            toolResult = await callTool(tool.serverId, toolName.split('/')[1] || toolName, args);
            log('Tool result:', toolResult);
          } catch (error) {
            log('Tool call error:', error);
            toolResult = { ok: false, error: error instanceof Error ? error.message : 'Tool call failed' };
          }
        } else {
          toolResult = { ok: false, error: `Tool not found: ${toolName}` };
        }

        // Send tool_result event
        sender.sendStreamEvent({
          id: ctx.id,
          event: {
            type: 'tool_result',
            tool: toolName,
            result: toolResult.ok ? toolResult.result : undefined,
            error: toolResult.error ? { code: 'ERR_TOOL_FAILED', message: toolResult.error } : undefined,
          },
        });

        // Extract text from MCP result format: { content: [{ type: 'text', text: '...' }] }
        let extractedResult = '';
        if (toolResult.ok && toolResult.result) {
          const mcpResult = toolResult.result as { content?: Array<{ type: string; text?: string }> };
          if (mcpResult.content && Array.isArray(mcpResult.content)) {
            extractedResult = mcpResult.content
              .filter(c => c.type === 'text' && c.text)
              .map(c => c.text)
              .join('\n');
          }
          // Fallback to JSON if not MCP format
          if (!extractedResult) {
            extractedResult = typeof toolResult.result === 'string' 
              ? toolResult.result 
              : JSON.stringify(toolResult.result);
          }
        }
        
        const resultContent = toolResult.ok 
          ? `Tool ${toolName} returned: ${extractedResult}`
          : `Tool ${toolName} failed: ${toolResult.error}`;
        log('Tool result (extracted):', resultContent);
        
        // After getting a successful tool result, ask LLM to summarize WITHOUT tools
        // This prevents the infinite tool-calling loop
        if (toolResult.ok) {
          log('Got successful tool result, asking LLM to summarize...');
          
          const summaryMessages = [
            { role: 'system', content: 'You are a helpful assistant. Answer the user based on the tool result provided.' },
            { role: 'user', content: payload.task },
            { role: 'assistant', content: `I called ${toolName} to get this information.` },
            { role: 'user', content: resultContent },
          ];
          
          try {
            const summaryResult = await bridgeRequest<{
              choices?: Array<{ message: { content: string } }>;
            }>('llm.chat', {
              messages: summaryMessages,
              // NO tools - force text response
            });
            
            const summaryContent = summaryResult.choices?.[0]?.message?.content || resultContent;
            log('Summary from LLM:', summaryContent);
            
            sender.sendStreamEvent({
              id: ctx.id,
              event: {
                type: 'final',
                output: summaryContent,
              },
              done: true,
            });
            return;
          } catch (summaryError) {
            log('Summary failed, using raw result:', summaryError);
            // Fall back to raw result
            sender.sendStreamEvent({
              id: ctx.id,
              event: {
                type: 'final',
                output: resultContent,
              },
              done: true,
            });
            return;
          }
        }
      }
      
      // Log current message history before next iteration (only if no successful tool result)
      log('Messages after tool processing:', messages.map(m => ({ role: m.role, content: m.content?.slice(0, 100) })));
    }

    // Max tool calls reached without success
    sender.sendStreamEvent({
      id: ctx.id,
      event: {
        type: 'final',
        output: 'Unable to complete the task. The tools did not return useful results.',
      },
      done: true,
    });

  } catch (error) {
    log('agent.run error:', error);
    sender.sendStreamEvent({
      id: ctx.id,
      event: {
        type: 'error',
        error: {
          code: 'ERR_INTERNAL',
          message: error instanceof Error ? error.message : 'Agent run failed',
        },
      },
      done: true,
    });
  }
}
