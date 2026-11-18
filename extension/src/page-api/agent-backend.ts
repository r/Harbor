/**
 * Harbor Page API - Agent backend interface
 *
 * What runs a page's `window.agent.run` loop, behind one small interface so
 * a future backend (for example the proposed ACP backend, see
 * docs/ACP_BACKEND_DESIGN.md section 6) can run the same requests without
 * background.ts changing.
 *
 * Everything that applies to every backend stays in background.ts's
 * handleAgentRun: the `toolCalling` feature flag, the `model:prompt` /
 * `model:tools` grant checks before the run starts, listing Harbor's tools
 * and filtering them to the site's `allowedTools`, and delivering events to
 * the page. A backend runs the task against the model and the tools it's
 * handed, stops promptly once its signal aborts, and re-checks the grants
 * that cover each step as it takes it: `model:prompt` before each model
 * call after the first, `mcp:tools.call` before each tool call.
 */
import { harborRequest } from './harbor-core';
import { hasPermission } from './handlers';
import { toolResultText } from './tool-messages';
import { ErrorCodes, type StreamToken } from './types';

/** A tool the run may offer the model, already filtered to the site's `allowedTools`. */
export interface AgentBackendTool {
  serverId: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface AgentRunRequest {
  origin: string;
  tabId?: number;
  task: string;
  systemPrompt?: string;
  maxToolCalls: number;
  tools: AgentBackendTool[];
}

export interface AgentBackend {
  /**
   * Run one `agent.run` request. `emit` delivers one `StreamToken` at a
   * time to the page; background.ts derives the transport's `done` flag
   * from the token's type (`done` and `error` end the stream, `token`
   * doesn't), so a backend never sends more than one terminal token.
   * `signal` aborts when the page cancels the run or its port disconnects;
   * a backend checks it between turns and before each tool call, and ends
   * the stream with one terminal event when it's already aborted.
   */
  run(req: AgentRunRequest, emit: (event: StreamToken) => void, signal: AbortSignal): Promise<void>;
}

function abortedEvent(): StreamToken {
  return { type: 'error', error: { code: ErrorCodes.ABORTED, message: 'Run aborted' } };
}

/**
 * A run spans several model calls, so a grant checked when it started can
 * be gone by a later one: the user revoked the site, or a one-time grant
 * expired. Ends the run with a permission error when `model:prompt` is gone.
 */
async function promptRevoked(origin: string, tabId: number | undefined, emit: (event: StreamToken) => void): Promise<boolean> {
  if (await hasPermission(origin, 'model:prompt', tabId)) return false;
  emit({ type: 'error', error: { code: ErrorCodes.PERMISSION_DENIED, message: 'Permission model:prompt required' } });
  return true;
}

/**
 * Harbor's own model loop: Harbor's bridge-backed `llm.chat`, tool calls
 * gated per call by `mcp:tools.call`, moved here unchanged from
 * background.ts's `handleAgentRun` other than the cancellation checks.
 */
export const builtinAgentBackend: AgentBackend = {
  async run(req, emit, signal) {
    const { origin, tabId, task, systemPrompt, maxToolCalls, tools } = req;

    // Build tool definitions for the LLM
    const llmTools = tools.map(t => ({
      name: `${t.serverId}_${t.name}`.replace(/[^a-zA-Z0-9_]/g, '_'),
      description: t.description || `Tool: ${t.serverId}/${t.name}`,
      input_schema: t.inputSchema || { type: 'object', properties: {} },
      _serverId: t.serverId,
      _toolName: t.name,
    }));

    // Send thinking event
    emit({
      type: 'token',
      token: JSON.stringify({
        type: 'thinking',
        content: llmTools.length > 0
          ? `Available tools: ${tools.map(t => `${t.serverId}/${t.name}`).join(', ')}`
          : 'No tools available (check mcp:tools.list permission)',
      }),
    });

    // Agentic loop
    type LLMToolCall = { id: string; type?: string; function: { name: string; arguments: string } };
    const messages: Array<{
      role: string;
      content: string;
      tool_calls?: LLMToolCall[];
      tool_call_id?: string;
    }> = [];
    messages.push({ role: 'system', content: systemPrompt || 'You are a helpful assistant that can use tools to help users.' });
    messages.push({ role: 'user', content: task });

    let toolCallCount = 0;
    // handleAgentRun checked model:prompt just before the first model call.
    let firstTurn = true;

    while (toolCallCount < maxToolCalls) {
      if (signal.aborted) {
        emit(abortedEvent());
        return;
      }
      if (!firstTurn && await promptRevoked(origin, tabId, emit)) return;
      firstTurn = false;

      type LLMResponse = {
        content: string;
        choices?: Array<{
          message: {
            role: string;
            content: string;
            tool_calls?: LLMToolCall[];
          };
          finish_reason?: string;
        }>;
      };

      let result: LLMResponse;
      try {
        result = await harborRequest<LLMResponse>('llm.chat', {
          origin,
          tabId,
          messages,
          tools: llmTools.length > 0 ? llmTools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          })) : undefined,
        });
      } catch (e) {
        emit({
          type: 'error',
          error: { code: ErrorCodes.MODEL_FAILED, message: `LLM request failed: ${e instanceof Error ? e.message : String(e)}` },
        });
        return;
      }

      // The page may have aborted while the model was answering.
      if (signal.aborted) {
        emit(abortedEvent());
        return;
      }

      const choice = result.choices?.[0];
      const responseContent = result.content;
      const toolCalls = choice?.message?.tool_calls;

      if (toolCalls && toolCalls.length > 0) {
        if (!await hasPermission(origin, 'mcp:tools.call', tabId)) {
          messages.push({ role: 'assistant', content: responseContent || 'I need to use tools but permission was denied.' });
          messages.push({ role: 'user', content: 'Tool calling is not permitted. Please provide an answer without using tools.' });
          continue;
        }

        // Record the model's tool calls as a real assistant turn, then answer each
        // with a `tool` message. Sending results back as plain user text ("Tool X
        // returned: …") makes local models call the same tool again until they
        // hit maxToolCalls.
        messages.push({
          role: 'assistant',
          content: responseContent || '',
          tool_calls: toolCalls.map(tc => ({ ...tc, type: tc.type || 'function' })),
        });

        for (const tc of toolCalls) {
          if (signal.aborted) {
            emit(abortedEvent());
            return;
          }

          const llmToolName = tc.function.name;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            args = {};
          }

          const toolInfo = llmTools.find(t => t.name === llmToolName);
          const serverId = toolInfo?._serverId || '';
          const actualToolName = toolInfo?._toolName || llmToolName;
          const displayName = `${serverId}/${actualToolName}`;

          emit({ type: 'token', token: JSON.stringify({ type: 'tool_call', tool: displayName, args }) });

          let toolResult: unknown;
          try {
            const callResult = await harborRequest<{ result: unknown }>('mcp.callTool', {
              origin,
              tabId,
              serverId,
              toolName: actualToolName,
              args,
            });
            toolResult = callResult.result;
          } catch (e) {
            toolResult = { error: e instanceof Error ? e.message : 'Tool call failed' };
          }

          emit({ type: 'token', token: JSON.stringify({ type: 'tool_result', tool: displayName, result: toolResult }) });

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: toolResultText(toolResult),
          });

          toolCallCount++;
        }
      } else {
        emit({ type: 'token', token: JSON.stringify({ type: 'final', output: responseContent }) });
        emit({ type: 'done' });
        return;
      }
    }

    if (signal.aborted) {
      emit(abortedEvent());
      return;
    }
    if (await promptRevoked(origin, tabId, emit)) return;

    // Max tool calls reached
    messages.push({ role: 'user', content: 'Please provide your final answer based on the information gathered.' });
    const finalResult = await harborRequest<{ content: string }>('llm.chat', {
      origin,
      tabId,
      messages,
    });
    const finalContent = finalResult.content;

    if (signal.aborted) {
      emit(abortedEvent());
      return;
    }

    emit({ type: 'token', token: JSON.stringify({ type: 'final', output: finalContent }) });
    emit({ type: 'done' });
  },
};
