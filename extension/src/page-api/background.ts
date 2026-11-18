/**
 * Harbor Page API - Background wiring
 *
 * Serves window.ai / window.agent / navigator.modelContext requests from the
 * page-api content script, in-process: llm.*, mcp.*, session.*,
 * permissions.* and system.* calls go through harbor-core.ts to Harbor's own
 * extension-api router, so gatePageCall/requireAction run exactly as they do
 * for a call forwarded from the (now retired) Web Agents API extension.
 *
 * The page's origin always comes from the connecting port's `sender` (its
 * URL in Firefox, its `origin` in Chrome) — never from the message, which a
 * page or a compromised content script could otherwise forge.
 */
import { harborRequest, harborStreamRequest } from './harbor-core';
import { featureRefusal, getFeatureFlags } from './policy/feature-flags';
import { toolResultText } from './tool-messages';
import type { TransportStreamEvent } from './types';

import {
  routeMessage,
  type RequestContext,
  // Permission utilities
  hasPermission,
  getPermissions,
  // AI utilities
  resolveTextSession,
  recordExplicitPrompt,
  // Tab utilities
  restoreSpawnedTabs,
  handleTabRemoved,
  getAllSpawnedTabs,
  // Agent utilities
  cleanupAgentsForTab,
  resolveInvocationResponse,
} from './handlers';
import { browserAPI } from '../browser-compat';

const PORT_NAME = 'harbor-page-api';

function log(...args: unknown[]): void {
  console.log('[Harbor PageAPI]', ...args);
}

/**
 * The page's origin, derived from the connecting port's sender — never from
 * the message a page sent, which could claim to be any origin.
 */
function originFromSender(sender: chrome.runtime.Port['sender']): string {
  const raw = sender?.url ?? (sender as unknown as { origin?: string } | undefined)?.origin;
  if (!raw) return '';
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
}

// =============================================================================
// Streaming Handlers (kept here for port access)
// =============================================================================

async function handleSessionPromptStreaming(
  ctx: RequestContext,
  sendEvent: (event: TransportStreamEvent) => void,
): Promise<void> {
  const { sessionId, input } = ctx.payload as { sessionId: string; input: string };

  const resolved = await resolveTextSession(sessionId, ctx.origin, ctx.tabId);
  if (!('session' in resolved)) {
    sendEvent({ id: ctx.id, event: { type: 'error', error: { code: resolved.code, message: resolved.message } }, done: true });
    return;
  }
  const { session } = resolved;

  try {
    session.history.push({ role: 'user', content: input });

    const messages: Array<{ role: string; content: string }> = [];
    if (session.options.systemPrompt) {
      messages.push({ role: 'system', content: session.options.systemPrompt as string });
    }
    messages.push(...session.history);

    const { stream } = harborStreamRequest('llm.chatStream', {
      origin: ctx.origin,
      tabId: ctx.tabId,
      messages,
      model: session.options.model,
      temperature: session.options.temperature,
    }, ctx.id);

    let fullContent = '';

    for await (const event of stream) {
      if (event.type === 'token' && event.token) {
        fullContent += event.token;
        sendEvent({ id: ctx.id, event: { type: 'token', token: event.token } });
      } else if (event.type === 'done') {
        session.history.push({ role: 'assistant', content: fullContent });
        recordExplicitPrompt(session, input, fullContent);
        sendEvent({ id: ctx.id, event: { type: 'done' }, done: true });
        break;
      } else if (event.type === 'error') {
        sendEvent({
          id: ctx.id,
          event: { type: 'error', error: { code: 'ERR_MODEL_FAILED', message: event.error?.message || 'Stream error' } },
          done: true,
        });
        break;
      }
    }
  } catch (e) {
    sendEvent({
      id: ctx.id,
      event: { type: 'error', error: { code: 'ERR_MODEL_FAILED', message: e instanceof Error ? e.message : 'Streaming failed' } },
      done: true,
    });
  }
}

async function handleAgentRun(
  ctx: RequestContext,
  sendEvent: (event: TransportStreamEvent) => void,
): Promise<void> {
  const { task, maxToolCalls = 5, systemPrompt } = ctx.payload as {
    task: string;
    maxToolCalls?: number;
    systemPrompt?: string;
  };

  log('agent.run starting:', { taskLength: task?.length ?? 0, maxToolCalls, origin: ctx.origin });

  // Enforce the setting at the receiver: a page can send transport messages
  // directly, without going through the injected API's disabled wrapper.
  const refusal = featureRefusal(ctx.type, await getFeatureFlags());
  if (refusal) {
    sendEvent({ id: ctx.id, event: { type: 'error', error: refusal }, done: true });
    return;
  }

  for (const scope of ['model:prompt', 'model:tools'] as const) {
    if (!await hasPermission(ctx.origin, scope, ctx.tabId)) {
      sendEvent({
        id: ctx.id,
        event: { type: 'error', error: { code: 'ERR_PERMISSION_DENIED', message: `Permission ${scope} required` } },
        done: true,
      });
      return;
    }
  }

  try {
    // Get available tools
    let tools: Array<{ serverId: string; name: string; description?: string; inputSchema?: unknown }> = [];

    if (await hasPermission(ctx.origin, 'mcp:tools.list', ctx.tabId)) {
      const toolsResult = await harborRequest<{ tools: typeof tools }>('mcp.listTools', {
        origin: ctx.origin,
        tabId: ctx.tabId,
      });
      tools = toolsResult.tools || [];

      // Offer only the tools the site was granted. No allowlist means no tools.
      const permissions = await getPermissions(ctx.origin, ctx.tabId);
      tools = tools.filter(t =>
        permissions.allowedTools.includes(t.name) ||
        permissions.allowedTools.includes(`${t.serverId}/${t.name}`)
      );
    }

    // Build tool definitions for the LLM
    const llmTools = tools.map(t => ({
      name: `${t.serverId}_${t.name}`.replace(/[^a-zA-Z0-9_]/g, '_'),
      description: t.description || `Tool: ${t.serverId}/${t.name}`,
      input_schema: t.inputSchema || { type: 'object', properties: {} },
      _serverId: t.serverId,
      _toolName: t.name,
    }));

    // Send thinking event
    sendEvent({
      id: ctx.id,
      event: { type: 'token', token: JSON.stringify({
        type: 'thinking',
        content: llmTools.length > 0
          ? `Available tools: ${tools.map(t => `${t.serverId}/${t.name}`).join(', ')}`
          : 'No tools available (check mcp:tools.list permission)'
      }) },
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

    // A run spans several model calls. Re-check model:prompt before each one
    // after the first (checked above), so revoking the site, or a one-time
    // grant expiring, ends the run instead of letting it keep prompting.
    const promptRevoked = async (): Promise<boolean> => {
      if (await hasPermission(ctx.origin, 'model:prompt', ctx.tabId)) return false;
      sendEvent({
        id: ctx.id,
        event: { type: 'error', error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission model:prompt required' } },
        done: true,
      });
      return true;
    };

    let toolCallCount = 0;
    let firstTurn = true;

    while (toolCallCount < maxToolCalls) {
      if (!firstTurn && await promptRevoked()) return;
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
          origin: ctx.origin,
          tabId: ctx.tabId,
          messages,
          tools: llmTools.length > 0 ? llmTools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          })) : undefined,
        });
      } catch (e) {
        sendEvent({
          id: ctx.id,
          event: { type: 'token', token: JSON.stringify({ type: 'error', error: `LLM request failed: ${e}` }) },
        });
        sendEvent({ id: ctx.id, event: { type: 'done' }, done: true });
        return;
      }

      const choice = result.choices?.[0];
      const responseContent = result.content;
      const toolCalls = choice?.message?.tool_calls;

      if (toolCalls && toolCalls.length > 0) {
        if (!await hasPermission(ctx.origin, 'mcp:tools.call', ctx.tabId)) {
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

          sendEvent({
            id: ctx.id,
            event: { type: 'token', token: JSON.stringify({ type: 'tool_call', tool: displayName, args }) },
          });

          let toolResult: unknown;
          try {
            const callResult = await harborRequest<{ result: unknown }>('mcp.callTool', {
              origin: ctx.origin,
              tabId: ctx.tabId,
              serverId,
              toolName: actualToolName,
              args,
            });
            toolResult = callResult.result;
          } catch (e) {
            toolResult = { error: e instanceof Error ? e.message : 'Tool call failed' };
          }

          sendEvent({
            id: ctx.id,
            event: { type: 'token', token: JSON.stringify({ type: 'tool_result', tool: displayName, result: toolResult }) },
          });

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: toolResultText(toolResult),
          });

          toolCallCount++;
        }
      } else {
        sendEvent({
          id: ctx.id,
          event: { type: 'token', token: JSON.stringify({ type: 'final', output: responseContent }) },
        });
        sendEvent({ id: ctx.id, event: { type: 'done' }, done: true });
        return;
      }
    }

    // Max tool calls reached
    if (await promptRevoked()) return;
    messages.push({ role: 'user', content: 'Please provide your final answer based on the information gathered.' });
    const finalResult = await harborRequest<{ content: string }>('llm.chat', {
      origin: ctx.origin,
      tabId: ctx.tabId,
      messages,
    });
    const finalContent = finalResult.content;

    sendEvent({
      id: ctx.id,
      event: { type: 'token', token: JSON.stringify({ type: 'final', output: finalContent }) },
    });
    sendEvent({ id: ctx.id, event: { type: 'done' }, done: true });

  } catch (e) {
    sendEvent({
      id: ctx.id,
      event: { type: 'error', error: { code: 'ERR_AGENT_FAILED', message: e instanceof Error ? e.message : 'Agent run failed' } },
      done: true,
    });
  }
}

// =============================================================================
// Initialization
// =============================================================================

let initialized = false;

/**
 * Wire up the page API's background listeners. Called once from Harbor's
 * main background.ts entry point, alongside initializeExtensionApi() and
 * initializeRouter().
 */
export function initializePageApi(): void {
  if (initialized) return;
  initialized = true;

  log('Initializing...');

  // Restore tracked spawned tabs from storage.
  restoreSpawnedTabs();

  // Clean up spawned tabs when they are closed.
  browserAPI.tabs.onRemoved.addListener(async (tabId: number) => {
    const wasTracked = Object.values(getAllSpawnedTabs()).some(tabs => tabs.includes(tabId));

    if (wasTracked) {
      try {
        await browserAPI.tabs.get(tabId);
        // Tab still exists - spurious event
        return;
      } catch {
        // Tab is truly gone
      }
    }

    handleTabRemoved(tabId);
    cleanupAgentsForTab(tabId);
  });

  // Port connection handler: the page-facing transport.
  browserAPI.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
    if (port.name !== PORT_NAME) return;

    const origin = originFromSender(port.sender);
    const tabId = port.sender?.tab?.id;
    const cookieStoreId = (port.sender?.tab as (chrome.tabs.Tab & { cookieStoreId?: string }) | undefined)?.cookieStoreId;

    port.onMessage.addListener(async (message: { id: string; type: string; payload: unknown }) => {
      const ctx: RequestContext = {
        id: message.id,
        type: message.type,
        payload: message.payload,
        // The origin always comes from the port's sender, established once
        // when the port connected — never from a per-message field, which a
        // page (or a compromised content script) could otherwise forge.
        origin,
        tabId,
        cookieStoreId,
      };

      if (ctx.type === 'session.promptStreaming') {
        const sendEvent = (event: TransportStreamEvent) => {
          try { port.postMessage(event); } catch { /* Port disconnected */ }
        };
        await handleSessionPromptStreaming(ctx, sendEvent);
        return;
      }

      if (ctx.type === 'agent.run') {
        const sendEvent = (event: TransportStreamEvent) => {
          try { port.postMessage(event); } catch { /* Port disconnected */ }
        };
        await handleAgentRun(ctx, sendEvent);
        return;
      }

      const response = await routeMessage(ctx);
      try {
        port.postMessage(response);
      } catch {
        /* Port disconnected */
      }
    });
  });

  // The content script asks for feature flags before injecting the page API.
  browserAPI.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
    if (message?.type === 'getFeatureFlags') {
      getFeatureFlags().then(flags => sendResponse(flags));
      return true;
    }
    return false;
  });

  // A tab's content script relaying the page's answer to an invocation it
  // was asked to handle (see content-script.ts's `agentInvocationResponse`
  // forwarding). Every tab's content script now shares this one extension,
  // so this is checked carefully before resolving anything:
  //  - only Harbor's own content script may answer (never a page directly,
  //    and never another extension);
  //  - only the tab the invocation was actually sent to may answer, and
  //    only from that tab's top frame — resolveInvocationResponse() enforces
  //    the tab match, and content-script.ts only runs in the top frame
  //    (manifest.json's `all_frames: false`), so frameId is always 0 there.
  browserAPI.runtime.onMessage.addListener(
    (
      message: { type?: string; response?: Parameters<typeof resolveInvocationResponse>[0] },
      sender: chrome.runtime.MessageSender,
      _sendResponse: (response?: unknown) => void,
    ) => {
      if (message?.type !== 'agentInvocationResponse') return false;

      if (sender.id !== browserAPI.runtime.id || !sender.tab) {
        log('Ignoring agentInvocationResponse: not from Harbor\'s own content script', sender.id);
        return false;
      }
      if (sender.frameId !== undefined && sender.frameId !== 0) {
        log('Ignoring agentInvocationResponse: not the top frame', sender.frameId);
        return false;
      }
      if (!message.response) return false;

      const resolved = resolveInvocationResponse(message.response, sender.tab.id!);
      if (!resolved) {
        log('agentInvocationResponse did not match a pending invocation for this tab:', message.response.invocationId, sender.tab.id);
      }
      return false;
    },
  );

  log('Initialized.');
}
