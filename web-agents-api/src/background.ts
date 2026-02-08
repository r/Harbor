/**
 * Web Agents API - Background Script
 *
 * Routes messages from content scripts to Harbor extension.
 * Handles permissions and session management.
 * 
 * This is the simplified entry point that uses the modular handler system.
 */

import {
  harborRequest,
  harborStreamRequest,
  discoverHarbor,
  setHarborExtensionId,
  getHarborState,
} from './harbor-client';
import { getFeatureFlags } from './policy/feature-flags';
import type { TransportResponse, TransportStreamEvent } from './types';

// Import handler registry and utilities
import {
  routeMessage,
  isStreamingMessage,
  type RequestContext,
  // Permission utilities
  hasPermission,
  getPermissions,
  listAllPermissions,
  revokeOriginPermissions,
  resolvePromptClosed,
  handlePermissionPromptResponse,
  // AI utilities
  getTextSession,
  // Tab utilities
  restoreSpawnedTabs,
  handleTabRemoved,
  getAllSpawnedTabs,
  isSpawnedTab,
  // Agent utilities
  handleIncomingInvocation,
  resolveInvocationResponse,
  cleanupAgentsForTab,
  agentInvocationTabs,
} from './handlers';

// =============================================================================
// Initialization
// =============================================================================

const STARTUP_TIME = Date.now();
const STARTUP_ID = Math.random().toString(36).slice(2, 8);
console.log('[Web Agents API] Extension starting...', { startupId: STARTUP_ID, time: new Date().toISOString() });

// Initialize: restore tabs from storage
restoreSpawnedTabs();

// =============================================================================
// Tab Event Handlers
// =============================================================================

// Clean up spawned tabs when they are closed
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const wasTracked = Object.values(getAllSpawnedTabs()).some(tabs => tabs.includes(tabId));
  
  if (wasTracked) {
    try {
      await chrome.tabs.get(tabId);
      // Tab still exists - spurious event
      return;
    } catch {
      // Tab is truly gone
    }
  }
  
  handleTabRemoved(tabId);
  cleanupAgentsForTab(tabId);
});

// =============================================================================
// Streaming Handlers (kept in background.ts for port access)
// =============================================================================

async function handleSessionPromptStreaming(
  ctx: RequestContext,
  sendEvent: (event: TransportStreamEvent) => void,
): Promise<void> {
  const { sessionId, input } = ctx.payload as { sessionId: string; input: string };
  
  console.log('[Web Agents API] handleSessionPromptStreaming called', {
    sessionId,
    inputLength: input?.length || 0,
    origin: ctx.origin,
  });
  
  const session = getTextSession(sessionId);
  if (!session) {
    sendEvent({ id: ctx.id, event: { type: 'error', error: { code: 'ERR_SESSION_NOT_FOUND', message: 'Session not found' } }, done: true });
    return;
  }
  
  if (session.origin !== ctx.origin) {
    sendEvent({ id: ctx.id, event: { type: 'error', error: { code: 'ERR_PERMISSION_DENIED', message: 'Session belongs to different origin' } }, done: true });
    return;
  }

  try {
    // Add user message to history
    session.history.push({ role: 'user', content: input });
    
    // Build messages array
    const messages: Array<{ role: string; content: string }> = [];
    if (session.options.systemPrompt) {
      messages.push({ role: 'system', content: session.options.systemPrompt as string });
    }
    messages.push(...session.history);
    
    // Stream from Harbor
    const { stream } = harborStreamRequest('llm.chatStream', {
      messages,
      model: session.options.model,
      temperature: session.options.temperature,
    });

    let fullContent = '';
    
    for await (const event of stream) {
      if (event.type === 'token' && event.token) {
        fullContent += event.token;
        sendEvent({ id: ctx.id, event: { type: 'token', token: event.token } });
      } else if (event.type === 'done') {
        session.history.push({ role: 'assistant', content: fullContent });
        sendEvent({ id: ctx.id, event: { type: 'done' }, done: true });
        break;
      } else if (event.type === 'error') {
        sendEvent({ 
          id: ctx.id, 
          event: { type: 'error', error: { code: 'ERR_MODEL_FAILED', message: event.error?.message || 'Stream error' } }, 
          done: true 
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

  console.log('[Web Agents API] agent.run starting:', { task, maxToolCalls, origin: ctx.origin });

  // Check permissions
  if (!await hasPermission(ctx.origin, 'model:prompt')) {
    sendEvent({
      id: ctx.id,
      event: { type: 'error', error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission model:prompt required' } },
      done: true,
    });
    return;
  }

  try {
    // Get available tools
    let tools: Array<{ serverId: string; name: string; description?: string; inputSchema?: unknown }> = [];
    
    if (await hasPermission(ctx.origin, 'mcp:tools.list')) {
      const toolsResult = await harborRequest<{ tools: typeof tools }>('mcp.listTools', {});
      tools = toolsResult.tools || [];
      
      const permissions = await getPermissions(ctx.origin);
      if (permissions.allowedTools && permissions.allowedTools.length > 0) {
        tools = tools.filter(t => 
          permissions.allowedTools!.includes(t.name) || 
          permissions.allowedTools!.includes(`${t.serverId}/${t.name}`)
        );
      }
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
    const messages: Array<{ role: string; content: string }> = [];
    messages.push({ role: 'system', content: systemPrompt || 'You are a helpful assistant that can use tools to help users.' });
    messages.push({ role: 'user', content: task });

    let toolCallCount = 0;

    while (toolCallCount < maxToolCalls) {
      type LLMResponse = {
        content?: string;
        choices?: Array<{
          message: {
            role: string;
            content: string;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
          };
          finish_reason?: string;
        }>;
      };
      
      let result: LLMResponse;
      try {
        result = await harborRequest<LLMResponse>('llm.chat', { 
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
      const responseContent = choice?.message?.content || result.content || '';
      const toolCalls = choice?.message?.tool_calls;

      if (toolCalls && toolCalls.length > 0) {
        if (!await hasPermission(ctx.origin, 'mcp:tools.call')) {
          messages.push({ role: 'assistant', content: responseContent || 'I need to use tools but permission was denied.' });
          messages.push({ role: 'user', content: 'Tool calling is not permitted. Please provide an answer without using tools.' });
          continue;
        }

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

          messages.push({ role: 'assistant', content: `[Called tool: ${displayName}(${JSON.stringify(args)})]` });
          messages.push({ role: 'user', content: `Tool "${displayName}" returned: ${JSON.stringify(toolResult)}` });

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
    messages.push({ role: 'user', content: 'Please provide your final answer based on the information gathered.' });
    const finalResult = await harborRequest<{ content?: string; choices?: Array<{ message: { content: string } }> }>('llm.chat', { messages });
    const finalContent = finalResult.choices?.[0]?.message?.content || finalResult.content || '';
    
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
// Port Connection Handler
// =============================================================================

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'web-agent-transport') return;
  
  console.log('[Web Agents API] Port connected');

  port.onMessage.addListener(async (message: RequestContext & { type: string }) => {
    const tabId = port.sender?.tab?.id;
    const cookieStoreId = (port.sender?.tab as chrome.tabs.Tab & { cookieStoreId?: string })?.cookieStoreId;
    
    const ctx: RequestContext = {
      id: message.id,
      type: message.type,
      payload: message.payload,
      origin: message.origin || '',
      tabId,
      cookieStoreId,
    };

    // Handle streaming requests
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

    // Handle regular requests via router
    const response = await routeMessage(ctx);
    try {
      port.postMessage(response);
    } catch {
      /* Port disconnected */
    }
  });
});

// =============================================================================
// Permission Prompt Handler
// =============================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'permission_prompt_response') {
    return false;
  }

  const success = handlePermissionPromptResponse(message.response);
  sendResponse({ ok: success });
  return true;
});

chrome.windows.onRemoved.addListener((windowId) => {
  resolvePromptClosed(windowId);
});

// =============================================================================
// Permission Management Messages
// =============================================================================

function handleWebAgentsPermissionsMessage(
  message: { type?: string; origin?: string },
  sendResponse: (response?: unknown) => void,
): boolean {
  if (message?.type === 'web_agents_permissions.list_all') {
    listAllPermissions()
      .then(permissions => sendResponse({ ok: true, permissions }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message?.type === 'web_agents_permissions.revoke_origin') {
    const { origin } = message as { origin?: string };
    if (!origin) {
      sendResponse({ ok: false, error: 'Missing origin' });
      return true;
    }

    revokeOriginPermissions(origin)
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  return false;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  return handleWebAgentsPermissionsMessage(message, sendResponse);
});

chrome.runtime.onMessageExternal?.addListener((message, _sender, sendResponse) => {
  return handleWebAgentsPermissionsMessage(message, sendResponse);
});

// =============================================================================
// Harbor Discovery Handler
// =============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'harbor_discovered' && message.extensionId) {
    setHarborExtensionId(message.extensionId);
    sendResponse({ ok: true });
  }
  return false;
});

// =============================================================================
// Agent Invocation Response Handler
// =============================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'agentInvocationResponse') {
    return false;
  }
  
  const success = resolveInvocationResponse(message.response);
  sendResponse({ ok: success });
  return true;
});

// =============================================================================
// Harbor Forwarded Invocation Handler
// =============================================================================

const processedForwardedInvocations = new Set<string>();

function handleForwardedInvocation(
  message: { agentId: string; request: { from: string; task: string; input?: unknown; timeout?: number }; handlerInfo: { origin: string; tabId?: number }; traceId?: string },
  sendResponse: (response: unknown) => void,
  source: string
): boolean {
  const { agentId, request, handlerInfo, traceId } = message;
  const trace = traceId || 'no-trace';
  
  const invocationKey = `${agentId}-${request.from}-${request.task}-${JSON.stringify(request.input || {}).slice(0, 100)}`;
  
  if (processedForwardedInvocations.has(invocationKey)) {
    return false;
  }
  processedForwardedInvocations.add(invocationKey);
  setTimeout(() => processedForwardedInvocations.delete(invocationKey), 30000);
  
  const tabId = handlerInfo.tabId || agentInvocationTabs.get(agentId);
  
  if (!tabId) {
    sendResponse({ success: false, error: { code: 'ERR_NO_TAB', message: 'Agent tab not found' } });
    return true;
  }
  
  handleIncomingInvocation(agentId, request, trace)
    .then(response => sendResponse(response))
    .catch(error => sendResponse({ success: false, error: { code: 'ERR_FAILED', message: error.message } }));
  
  return true;
}

chrome.runtime.onMessageExternal?.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'agent.host.run') {
    const { payload } = message as { payload?: { method: string; params: Record<string, unknown>; context: { origin?: string; tabId?: number } } };
    if (!payload) {
      sendResponse({ ok: false, error: 'Missing payload' });
      return true;
    }
    import('./handlers/host-run-handlers').then(({ handleHostRun }) => {
      handleHostRun(payload)
        .then((out) => sendResponse(out))
        .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    });
    return true;
  }
  if (message?.type !== 'harbor.forwardInvocation') {
    return false;
  }
  return handleForwardedInvocation(message, sendResponse, 'onMessageExternal');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'harbor.forwardInvocation') {
    return false;
  }
  
  if (sender.id === chrome.runtime.id) {
    return false;
  }
  
  return handleForwardedInvocation(message, sendResponse, 'onMessage');
});

// =============================================================================
// Sidebar Message Handlers
// =============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'checkHarborConnection') {
    (async () => {
      const state = getHarborState();
      if (!state.connected) {
        const id = await discoverHarbor();
        sendResponse({ connected: !!id, extensionId: id });
      } else {
        sendResponse({ connected: true, extensionId: state.extensionId });
      }
    })();
    return true;
  }

  if (message?.type === 'getPermissionsForOrigin') {
    const { origin } = message as { origin?: string };
    if (!origin) {
      sendResponse({ scopes: {}, allowedTools: [] });
      return true;
    }

    (async () => {
      const permissions = await getPermissions(origin);
      const scopes: Record<string, string> = {};
      
      for (const [scope, grant] of Object.entries(permissions.scopes || {})) {
        if (grant.type === 'granted-once' && grant.expiresAt && Date.now() > grant.expiresAt) {
          scopes[scope] = 'not-granted';
        } else {
          scopes[scope] = grant.type;
        }
      }

      sendResponse({ scopes, allowedTools: permissions.allowedTools || [] });
    })();
    return true;
  }

  if (message?.type === 'listAllPermissions') {
    listAllPermissions().then(permissions => sendResponse({ permissions }));
    return true;
  }

  if (message?.type === 'revokePermissions') {
    const { origin } = message as { origin?: string };
    if (!origin) {
      sendResponse({ ok: false, error: 'Missing origin' });
      return true;
    }

    revokeOriginPermissions(origin).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === 'revokeAllPermissions') {
    (async () => {
      const result = await chrome.storage.local.get(null);
      const keysToRemove = Object.keys(result).filter(key => key.startsWith('permissions:'));
      
      if (keysToRemove.length > 0) {
        await chrome.storage.local.remove(keysToRemove);
      }
      
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === 'getFeatureFlags') {
    getFeatureFlags().then(flags => sendResponse(flags));
    return true;
  }

  return false;
});

// =============================================================================
// Initialization
// =============================================================================

// Try to discover Harbor on startup
discoverHarbor().then((id) => {
  if (id) {
    console.log('[Web Agents API] Harbor found:', id);
  } else {
    console.log('[Web Agents API] Harbor not found - will retry on first request');
  }
});

console.log('[Web Agents API] Extension initialized.');
