/**
 * Harbor JS AI Provider - Background Router
 * 
 * Handles all provider API requests from content scripts.
 * Manages sessions, enforces permissions, and routes to appropriate handlers.
 */

import browser from 'webextension-polyfill';
import type {
  ProviderMessage,
  ApiError,
  PermissionScope,
  TextSessionState,
  TextSessionOptions,
  ToolDescriptor,
  ActiveTabReadability,
  StreamToken,
  RunEvent,
} from './types';
import {
  getPermissionStatus,
  hasPermission,
  hasAllPermissions,
  getMissingPermissions,
  grantPermissions,
  denyPermissions,
  buildGrantResult,
  SCOPE_DESCRIPTIONS,
  GESTURE_REQUIRED_SCOPES,
  clearTabGrants,
  isToolAllowed,
  getAllowedTools,
} from './permissions';

const DEBUG = true;

function log(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[Harbor Provider Router]', ...args);
  }
}

// =============================================================================
// State Management
// =============================================================================

// Active text sessions
const textSessions = new Map<string, TextSessionState>();

// Pending permission requests waiting for user response
const pendingPermissionRequests = new Map<string, {
  port: browser.Runtime.Port;
  requestId: string;
  origin: string;
  scopes: PermissionScope[];
  reason?: string;
  requestedTools?: string[];
}>();

// Active streaming requests
const streamingRequests = new Map<string, {
  port: browser.Runtime.Port;
  aborted: boolean;
}>();

// Session ID counter
let sessionIdCounter = 0;

// =============================================================================
// Helper Functions
// =============================================================================

function generateSessionId(): string {
  return `session-${Date.now()}-${++sessionIdCounter}`;
}

function createError(code: ApiError['code'], message: string, details?: unknown): ApiError {
  return { code, message, details };
}

function sendResponse(port: browser.Runtime.Port, type: string, requestId: string, payload?: unknown): void {
  try {
    port.postMessage({
      namespace: 'harbor-provider',
      type,
      requestId,
      payload,
    });
  } catch (err) {
    log('Failed to send response:', err);
  }
}

function sendError(port: browser.Runtime.Port, requestId: string, error: ApiError): void {
  sendResponse(port, 'error', requestId, { error });
}

// =============================================================================
// Permission Enforcement
// =============================================================================

async function requirePermission(
  port: browser.Runtime.Port,
  requestId: string,
  origin: string,
  scope: PermissionScope
): Promise<boolean> {
  if (await hasPermission(origin, scope)) {
    return true;
  }
  
  sendError(port, requestId, createError(
    'ERR_SCOPE_REQUIRED',
    `Permission "${scope}" is required. Call agent.requestPermissions() first.`,
    { requiredScope: scope }
  ));
  return false;
}

async function requireAllPermissions(
  port: browser.Runtime.Port,
  requestId: string,
  origin: string,
  scopes: PermissionScope[]
): Promise<boolean> {
  if (await hasAllPermissions(origin, scopes)) {
    return true;
  }
  
  const missing = await getMissingPermissions(origin, scopes);
  sendError(port, requestId, createError(
    'ERR_SCOPE_REQUIRED',
    `Missing permissions: ${missing.join(', ')}. Call agent.requestPermissions() first.`,
    { requiredScopes: scopes, missingScopes: missing }
  ));
  return false;
}

// =============================================================================
// Permission Request UI
// =============================================================================

async function showPermissionPrompt(
  port: browser.Runtime.Port,
  requestId: string,
  origin: string,
  scopes: PermissionScope[],
  reason?: string,
  requestedTools?: string[]
): Promise<void> {
  // Store the pending request
  const promptId = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  pendingPermissionRequests.set(promptId, {
    port,
    requestId,
    origin,
    scopes,
    reason,
    requestedTools,
  });
  
  // Build permission prompt URL with query params
  const promptUrl = browser.runtime.getURL('permission-prompt.html');
  const params = new URLSearchParams({
    promptId,
    origin,
    scopes: JSON.stringify(scopes),
    reason: reason || '',
  });
  
  // If requesting mcp:tools.call, include the tools list
  if (scopes.includes('mcp:tools.call')) {
    // Get available tools to show in the prompt
    let availableTools: string[] = [];
    try {
      const connectionsResponse = await browser.runtime.sendMessage({
        type: 'mcp_list_connections',
      }) as { type: string; connections?: Array<{ serverId: string; serverName: string; toolCount: number }> };
      
      if (connectionsResponse.connections) {
        for (const conn of connectionsResponse.connections) {
          const toolsResponse = await browser.runtime.sendMessage({
            type: 'mcp_list_tools',
            server_id: conn.serverId,
          }) as { type: string; tools?: Array<{ name: string; description?: string }> };
          
          if (toolsResponse.tools) {
            for (const tool of toolsResponse.tools) {
              availableTools.push(`${conn.serverId}/${tool.name}`);
            }
          }
        }
      }
    } catch (err) {
      log('Failed to fetch available tools for prompt:', err);
    }
    
    // If specific tools were requested, filter to those
    if (requestedTools && requestedTools.length > 0) {
      availableTools = availableTools.filter(t => requestedTools.includes(t));
    }
    
    if (availableTools.length > 0) {
      params.set('tools', JSON.stringify(availableTools));
    }
  }
  
  // Open as a popup window - increase height to accommodate tools
  const hasTools = params.has('tools');
  try {
    await browser.windows.create({
      url: `${promptUrl}?${params.toString()}`,
      type: 'popup',
      width: 420,
      height: hasTools ? 600 : 500,
      focused: true,
    });
  } catch (err) {
    log('Failed to open permission prompt:', err);
    pendingPermissionRequests.delete(promptId);
    sendError(port, requestId, createError('ERR_INTERNAL', 'Failed to show permission prompt'));
  }
}

// Handle permission prompt response (called from permission-prompt.ts)
export function handlePermissionPromptResponse(
  promptId: string,
  decision: 'allow-once' | 'allow-always' | 'deny',
  allowedTools?: string[]
): void {
  const pending = pendingPermissionRequests.get(promptId);
  if (!pending) {
    log('No pending request for promptId:', promptId);
    return;
  }
  
  pendingPermissionRequests.delete(promptId);
  
  const { port, requestId, origin, scopes } = pending;
  
  (async () => {
    if (decision === 'deny') {
      await denyPermissions(origin, scopes);
      const result = await buildGrantResult(origin, scopes);
      sendResponse(port, 'permissions_result', requestId, result);
    } else {
      const mode = decision === 'allow-once' ? 'once' : 'always';
      await grantPermissions(origin, scopes, mode, { allowedTools });
      const result = await buildGrantResult(origin, scopes);
      sendResponse(port, 'permissions_result', requestId, result);
    }
  })().catch(err => {
    log('Error handling permission response:', err);
    sendError(port, requestId, createError('ERR_INTERNAL', 'Failed to process permission decision'));
  });
}

// =============================================================================
// Request Handlers
// =============================================================================

async function handleRequestPermissions(
  port: browser.Runtime.Port,
  requestId: string,
  origin: string,
  payload: { scopes: PermissionScope[]; reason?: string; tools?: string[] }
): Promise<void> {
  const { scopes, reason, tools } = payload;
  
  // Filter to valid scopes
  const validScopes = scopes.filter(s => SCOPE_DESCRIPTIONS[s] !== undefined);
  
  if (validScopes.length === 0) {
    const result = await buildGrantResult(origin, []);
    sendResponse(port, 'permissions_result', requestId, result);
    return;
  }
  
  // Check for web:fetch - not implemented in v1
  if (validScopes.includes('web:fetch')) {
    sendError(port, requestId, createError(
      'ERR_NOT_IMPLEMENTED',
      'web:fetch permission is not implemented in v1'
    ));
    return;
  }
  
  // Check if all scopes are already granted
  const missing = await getMissingPermissions(origin, validScopes);
  
  if (missing.length === 0) {
    const result = await buildGrantResult(origin, validScopes);
    sendResponse(port, 'permissions_result', requestId, result);
    return;
  }
  
  // Check if any are denied
  const status = await getPermissionStatus(origin);
  const denied = missing.filter(s => status.scopes[s] === 'denied');
  
  if (denied.length > 0) {
    // User previously denied - return current status without re-prompting
    const result = await buildGrantResult(origin, validScopes);
    sendResponse(port, 'permissions_result', requestId, result);
    return;
  }
  
  // Show permission prompt for missing scopes (include requested tools)
  await showPermissionPrompt(port, requestId, origin, missing, reason, tools);
}

async function handleListPermissions(
  port: browser.Runtime.Port,
  requestId: string,
  origin: string
): Promise<void> {
  const status = await getPermissionStatus(origin);
  sendResponse(port, 'list_permissions_result', requestId, status);
}

async function handleCreateTextSession(
  port: browser.Runtime.Port,
  requestId: string,
  origin: string,
  payload: { options?: TextSessionOptions }
): Promise<void> {
  // Require model:prompt permission
  if (!(await requirePermission(port, requestId, origin, 'model:prompt'))) {
    return;
  }
  
  const options = payload.options || {};
  const sessionId = generateSessionId();
  
  const session: TextSessionState = {
    id: sessionId,
    origin,
    options,
    messages: [],
    createdAt: Date.now(),
  };
  
  // Add system prompt if provided
  if (options.systemPrompt) {
    session.messages.push({ role: 'system', content: options.systemPrompt });
  }
  
  textSessions.set(sessionId, session);
  
  sendResponse(port, 'create_text_session_result', requestId, { sessionId });
}

async function handleTextSessionPrompt(
  port: browser.Runtime.Port,
  requestId: string,
  origin: string,
  payload: { sessionId: string; input: string; streaming: boolean }
): Promise<void> {
  const { sessionId, input, streaming } = payload;
  
  const session = textSessions.get(sessionId);
  if (!session) {
    sendError(port, requestId, createError('ERR_SESSION_NOT_FOUND', 'Session not found'));
    return;
  }
  
  if (session.origin !== origin) {
    sendError(port, requestId, createError('ERR_PERMISSION_DENIED', 'Session belongs to different origin'));
    return;
  }
  
  // Add user message to session
  session.messages.push({ role: 'user', content: input });
  
  try {
    // Call LLM via background sendToBridge
    // We need to send a message to the main background script handler
    const llmResponse = await browser.runtime.sendMessage({
      type: 'llm_chat',
      messages: session.messages.map(m => ({ role: m.role, content: m.content })),
      model: session.options.model,
      temperature: session.options.temperature,
      // No tools for basic text session
    }) as { type: string; response?: { message?: { content?: string } }; error?: { message: string } };
    
    if (llmResponse.type === 'error' || !llmResponse.response?.message?.content) {
      const errorMsg = llmResponse.error?.message || 'LLM request failed';
      sendError(port, requestId, createError('ERR_MODEL_FAILED', errorMsg));
      return;
    }
    
    const assistantContent = llmResponse.response.message.content;
    session.messages.push({ role: 'assistant', content: assistantContent });
    
    if (streaming) {
      // For streaming, we simulate token-by-token for now
      // TODO: Implement proper streaming from bridge
      const tokens = assistantContent.split(/(\s+)/);
      for (const token of tokens) {
        if (token) {
          sendResponse(port, 'text_session_stream_token', requestId, {
            requestId,
            token: { type: 'token', token },
          });
        }
      }
      sendResponse(port, 'text_session_stream_done', requestId, { requestId });
    } else {
      sendResponse(port, 'text_session_prompt_result', requestId, { result: assistantContent });
    }
  } catch (err) {
    log('LLM error:', err);
    sendError(port, requestId, createError('ERR_MODEL_FAILED', String(err)));
  }
}

async function handleTextSessionDestroy(
  port: browser.Runtime.Port,
  requestId: string,
  origin: string,
  payload: { sessionId: string }
): Promise<void> {
  const { sessionId } = payload;
  
  const session = textSessions.get(sessionId);
  if (session && session.origin === origin) {
    textSessions.delete(sessionId);
  }
  
  sendResponse(port, 'text_session_destroy_result', requestId, { success: true });
}

async function handleToolsList(
  port: browser.Runtime.Port,
  requestId: string,
  origin: string
): Promise<void> {
  // Require mcp:tools.list permission
  if (!(await requirePermission(port, requestId, origin, 'mcp:tools.list'))) {
    return;
  }
  
  try {
    // Get list of connected MCP servers and their tools
    const connectionsResponse = await browser.runtime.sendMessage({
      type: 'mcp_list_connections',
    }) as { type: string; connections?: Array<{ serverId: string; serverName: string; toolCount: number }> };
    
    if (!connectionsResponse.connections) {
      sendResponse(port, 'tools_list_result', requestId, { tools: [] });
      return;
    }
    
    const allTools: ToolDescriptor[] = [];
    
    // For each connected server, get its tools
    for (const conn of connectionsResponse.connections) {
      const toolsResponse = await browser.runtime.sendMessage({
        type: 'mcp_list_tools',
        server_id: conn.serverId,
      }) as { type: string; tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
      
      if (toolsResponse.tools) {
        for (const tool of toolsResponse.tools) {
          allTools.push({
            name: `${conn.serverId}/${tool.name}`,
            description: tool.description,
            inputSchema: tool.inputSchema,
            serverId: conn.serverId,
          });
        }
      }
    }
    
    sendResponse(port, 'tools_list_result', requestId, { tools: allTools });
  } catch (err) {
    log('Tools list error:', err);
    sendError(port, requestId, createError('ERR_INTERNAL', String(err)));
  }
}

async function handleToolsCall(
  port: browser.Runtime.Port,
  requestId: string,
  origin: string,
  payload: { tool: string; args: Record<string, unknown> }
): Promise<void> {
  // Require mcp:tools.call permission
  if (!(await requirePermission(port, requestId, origin, 'mcp:tools.call'))) {
    return;
  }
  
  const { tool, args } = payload;
  
  // Parse tool name: "serverId/toolName"
  const slashIndex = tool.indexOf('/');
  if (slashIndex === -1) {
    sendError(port, requestId, createError(
      'ERR_TOOL_NOT_ALLOWED',
      'Tool name must be in format "serverId/toolName"'
    ));
    return;
  }
  
  // Check if this specific tool is allowed for this origin
  const toolAllowed = await isToolAllowed(origin, tool);
  if (!toolAllowed) {
    const allowedTools = await getAllowedTools(origin);
    sendError(port, requestId, createError(
      'ERR_TOOL_NOT_ALLOWED',
      `Tool "${tool}" is not in the allowlist for this origin. Request permission with this tool first.`,
      { tool, allowedTools }
    ));
    return;
  }
  
  const serverId = tool.slice(0, slashIndex);
  const toolName = tool.slice(slashIndex + 1);
  
  try {
    // Call the tool via MCP
    const callResponse = await browser.runtime.sendMessage({
      type: 'mcp_call_tool',
      server_id: serverId,
      tool_name: toolName,
      arguments: args,
    }) as { type: string; result?: unknown; error?: { message: string } };
    
    if (callResponse.type === 'error') {
      sendError(port, requestId, createError('ERR_TOOL_FAILED', callResponse.error?.message || 'Tool call failed'));
      return;
    }
    
    sendResponse(port, 'tools_call_result', requestId, {
      success: true,
      result: callResponse.result,
    });
  } catch (err) {
    log('Tool call error:', err);
    sendError(port, requestId, createError('ERR_TOOL_FAILED', String(err)));
  }
}

async function handleActiveTabRead(
  port: browser.Runtime.Port,
  requestId: string,
  origin: string
): Promise<void> {
  // Require browser:activeTab.read permission
  if (!(await requirePermission(port, requestId, origin, 'browser:activeTab.read'))) {
    return;
  }
  
  // Note: In a full implementation, we would check for user gesture here
  // For v1, we trust the permission grant
  
  try {
    // Get the active tab
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    
    if (!activeTab?.id || !activeTab.url) {
      sendError(port, requestId, createError('ERR_INTERNAL', 'No active tab found'));
      return;
    }
    
    // Don't read from extension pages, about:, chrome:, etc.
    const url = new URL(activeTab.url);
    if (!['http:', 'https:'].includes(url.protocol)) {
      sendError(port, requestId, createError(
        'ERR_PERMISSION_DENIED',
        'Cannot read from this type of page'
      ));
      return;
    }
    
    // Inject content script to extract readable content
    const results = await browser.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: extractReadableContent,
    });
    
    if (!results || results.length === 0 || !results[0].result) {
      sendError(port, requestId, createError('ERR_INTERNAL', 'Failed to extract content'));
      return;
    }
    
    const content = results[0].result as ActiveTabReadability;
    sendResponse(port, 'active_tab_read_result', requestId, content);
  } catch (err) {
    log('Active tab read error:', err);
    sendError(port, requestId, createError('ERR_INTERNAL', String(err)));
  }
}

// Content extraction function (injected into page)
function extractReadableContent(): ActiveTabReadability {
  // Clone the document to avoid modifying the actual page
  const clone = document.cloneNode(true) as Document;
  
  // Remove non-content elements
  const removeSelectors = [
    'script', 'style', 'noscript', 'iframe', 'object', 'embed',
    'nav', 'footer', 'header', 'aside',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '.nav', '.navigation', '.menu', '.sidebar', '.footer', '.header',
    '.advertisement', '.ad', '.ads', '.social-share',
  ];
  
  for (const selector of removeSelectors) {
    clone.querySelectorAll(selector).forEach(el => el.remove());
  }
  
  // Try to find main content
  const mainContent = clone.querySelector('main, article, [role="main"], .content, .post, .entry') 
    || clone.body;
  
  // Get text content
  let text = mainContent?.textContent || '';
  
  // Clean up whitespace
  text = text
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
  
  // Truncate to reasonable size (50k chars)
  const MAX_LENGTH = 50000;
  if (text.length > MAX_LENGTH) {
    text = text.slice(0, MAX_LENGTH) + '\n\n[Content truncated...]';
  }
  
  return {
    url: window.location.href,
    title: document.title,
    text,
  };
}

// =============================================================================
// Agent Run Handler
// =============================================================================

async function handleAgentRun(
  port: browser.Runtime.Port,
  requestId: string,
  origin: string,
  payload: { task: string; tools?: string[]; requireCitations?: boolean; maxToolCalls?: number }
): Promise<void> {
  // Require model:tools permission
  if (!(await requirePermission(port, requestId, origin, 'model:tools'))) {
    return;
  }
  
  const { task, tools, requireCitations, maxToolCalls = 5 } = payload;
  
  // Track this streaming request
  streamingRequests.set(requestId, { port, aborted: false });
  
  const sendEvent = (event: RunEvent): void => {
    const req = streamingRequests.get(requestId);
    if (req && !req.aborted) {
      sendResponse(port, 'agent_run_event', requestId, { requestId, event });
    }
  };
  
  try {
    sendEvent({ type: 'status', message: 'Initializing agent...' });
    
    // Get available tools
    let availableTools: ToolDescriptor[] = [];
    if (await hasPermission(origin, 'mcp:tools.list')) {
      const connectionsResponse = await browser.runtime.sendMessage({
        type: 'mcp_list_connections',
      }) as { type: string; connections?: Array<{ serverId: string; serverName: string; toolCount: number }> };
      
      if (connectionsResponse.connections) {
        for (const conn of connectionsResponse.connections) {
          const toolsResponse = await browser.runtime.sendMessage({
            type: 'mcp_list_tools',
            server_id: conn.serverId,
          }) as { type: string; tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
          
          if (toolsResponse.tools) {
            for (const tool of toolsResponse.tools) {
              availableTools.push({
                name: `${conn.serverId}/${tool.name}`,
                description: tool.description,
                inputSchema: tool.inputSchema,
                serverId: conn.serverId,
              });
            }
          }
        }
      }
    }
    
    // Filter to allowed tools if specified
    if (tools && tools.length > 0) {
      availableTools = availableTools.filter(t => tools.includes(t.name));
    }
    
    // Check if we can read active tab
    const canReadTab = await hasPermission(origin, 'browser:activeTab.read');
    
    sendEvent({ type: 'status', message: `Found ${availableTools.length} tools` });
    
    // Build system prompt
    let systemPrompt = `You are a helpful AI assistant with access to tools.
Your task is to help the user by using the available tools when needed.
Always explain what you're doing and why.
If you need more information, ask for clarification.
${requireCitations ? 'When using information from tools or the browser, cite your sources.' : ''}

Available tools:
${availableTools.map(t => `- ${t.name}: ${t.description || 'No description'}`).join('\n')}
${canReadTab ? '- BROWSER_READ_TAB: Read the content of the currently active browser tab' : ''}
`;
    
    // Agent loop
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task },
    ];
    
    let toolCallCount = 0;
    const citations: Array<{ source: 'tab' | 'tool'; ref: string; excerpt: string }> = [];
    
    while (toolCallCount < maxToolCalls) {
      // Check if aborted
      const req = streamingRequests.get(requestId);
      if (!req || req.aborted) {
        sendEvent({ type: 'error', error: createError('ERR_INTERNAL', 'Request aborted') });
        return;
      }
      
      // Call LLM with tools
      const toolsForLlm = availableTools.map(t => ({
        type: 'function',
        function: {
          name: t.name.replace('/', '_'), // LLM-safe name
          description: t.description,
          parameters: t.inputSchema || { type: 'object', properties: {} },
        },
      }));
      
      if (canReadTab) {
        toolsForLlm.push({
          type: 'function',
          function: {
            name: 'BROWSER_READ_TAB',
            description: 'Read the content of the currently active browser tab',
            parameters: { type: 'object', properties: {} },
          },
        });
      }
      
      const llmResponse = await browser.runtime.sendMessage({
        type: 'llm_chat',
        messages,
        tools: toolsForLlm.length > 0 ? toolsForLlm : undefined,
      }) as { 
        type: string; 
        response?: { 
          message?: { 
            content?: string;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
          } 
        }; 
        error?: { message: string } 
      };
      
      if (llmResponse.type === 'error' || !llmResponse.response?.message) {
        sendEvent({ type: 'error', error: createError('ERR_MODEL_FAILED', llmResponse.error?.message || 'LLM failed') });
        return;
      }
      
      const message = llmResponse.response.message;
      
      // Check for tool calls
      if (message.tool_calls && message.tool_calls.length > 0) {
        // Process each tool call
        for (const toolCall of message.tool_calls) {
          if (toolCallCount >= maxToolCalls) {
            break;
          }
          
          toolCallCount++;
          const toolName = toolCall.function.name.replace('_', '/');
          let args: Record<string, unknown> = {};
          
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            // Empty args
          }
          
          sendEvent({ type: 'tool_call', tool: toolName, args });
          
          let toolResult: string;
          let toolError: ApiError | undefined;
          
          if (toolName === 'BROWSER/READ_TAB' || toolCall.function.name === 'BROWSER_READ_TAB') {
            // Read active tab
            try {
              const tabs = await browser.tabs.query({ active: true, currentWindow: true });
              const activeTab = tabs[0];
              
              if (activeTab?.id) {
                const results = await browser.scripting.executeScript({
                  target: { tabId: activeTab.id },
                  func: extractReadableContent,
                });
                
                if (results && results[0]?.result) {
                  const content = results[0].result as ActiveTabReadability;
                  toolResult = `URL: ${content.url}\nTitle: ${content.title}\n\n${content.text}`;
                  
                  if (requireCitations) {
                    citations.push({
                      source: 'tab',
                      ref: content.url,
                      excerpt: content.text.slice(0, 200),
                    });
                  }
                } else {
                  toolResult = 'Failed to extract content';
                }
              } else {
                toolResult = 'No active tab found';
              }
            } catch (err) {
              toolResult = `Error: ${err}`;
              toolError = createError('ERR_INTERNAL', String(err));
            }
          } else {
            // Call MCP tool
            try {
              const slashIndex = toolName.indexOf('/');
              const serverId = toolName.slice(0, slashIndex);
              const mcpToolName = toolName.slice(slashIndex + 1);
              
              const callResponse = await browser.runtime.sendMessage({
                type: 'mcp_call_tool',
                server_id: serverId,
                tool_name: mcpToolName,
                arguments: args,
              }) as { type: string; result?: unknown; error?: { message: string } };
              
              if (callResponse.type === 'error') {
                toolResult = `Error: ${callResponse.error?.message || 'Tool call failed'}`;
                toolError = createError('ERR_TOOL_FAILED', callResponse.error?.message || 'Tool call failed');
              } else {
                toolResult = typeof callResponse.result === 'string' 
                  ? callResponse.result 
                  : JSON.stringify(callResponse.result, null, 2);
                
                if (requireCitations) {
                  citations.push({
                    source: 'tool',
                    ref: toolName,
                    excerpt: toolResult.slice(0, 200),
                  });
                }
              }
            } catch (err) {
              toolResult = `Error: ${err}`;
              toolError = createError('ERR_TOOL_FAILED', String(err));
            }
          }
          
          sendEvent({ type: 'tool_result', tool: toolName, result: toolResult, error: toolError });
          
          // Add tool result to messages
          messages.push({
            role: 'assistant',
            content: `Calling tool: ${toolName}`,
          });
          messages.push({
            role: 'tool',
            content: toolResult,
          });
        }
        
        // Continue loop to get next LLM response
        continue;
      }
      
      // No tool calls - this is the final response
      const output = message.content || '';
      
      // Stream the output token by token
      const tokens = output.split(/(\s+)/);
      for (const token of tokens) {
        if (token) {
          sendEvent({ type: 'token', token });
          await new Promise(r => setTimeout(r, 10)); // Small delay for streaming effect
        }
      }
      
      sendEvent({ 
        type: 'final', 
        output,
        citations: requireCitations ? citations : undefined,
      });
      
      break;
    }
    
    // If we hit max tool calls without a final response
    if (toolCallCount >= maxToolCalls) {
      sendEvent({
        type: 'error',
        error: createError('ERR_INTERNAL', `Maximum tool calls (${maxToolCalls}) reached`),
      });
    }
    
  } catch (err) {
    log('Agent run error:', err);
    sendEvent({ type: 'error', error: createError('ERR_INTERNAL', String(err)) });
  } finally {
    streamingRequests.delete(requestId);
  }
}

function handleAgentRunAbort(requestId: string): void {
  const req = streamingRequests.get(requestId);
  if (req) {
    req.aborted = true;
  }
}

// =============================================================================
// Message Router
// =============================================================================

function handleProviderMessage(
  port: browser.Runtime.Port,
  message: ProviderMessage & { origin: string; href?: string }
): void {
  const { type, requestId, payload, origin } = message;
  
  log('Handling message:', type, 'from', origin);
  
  switch (type) {
    case 'ping':
      sendResponse(port, 'pong', requestId, { version: '1.0.0' });
      break;
      
    case 'request_permissions':
      handleRequestPermissions(port, requestId, origin, payload as { scopes: PermissionScope[]; reason?: string });
      break;
      
    case 'list_permissions':
      handleListPermissions(port, requestId, origin);
      break;
      
    case 'create_text_session':
      handleCreateTextSession(port, requestId, origin, payload as { options?: TextSessionOptions });
      break;
      
    case 'text_session_prompt':
    case 'text_session_prompt_streaming':
      handleTextSessionPrompt(port, requestId, origin, payload as { sessionId: string; input: string; streaming: boolean });
      break;
      
    case 'text_session_destroy':
      handleTextSessionDestroy(port, requestId, origin, payload as { sessionId: string });
      break;
      
    case 'tools_list':
      handleToolsList(port, requestId, origin);
      break;
      
    case 'tools_call':
      handleToolsCall(port, requestId, origin, payload as { tool: string; args: Record<string, unknown> });
      break;
      
    case 'active_tab_read':
      handleActiveTabRead(port, requestId, origin);
      break;
      
    case 'agent_run':
      handleAgentRun(port, requestId, origin, payload as { task: string; tools?: string[]; requireCitations?: boolean; maxToolCalls?: number });
      break;
      
    case 'agent_run_abort':
      handleAgentRunAbort((payload as { requestId: string }).requestId);
      break;
      
    default:
      sendError(port, requestId, createError('ERR_NOT_IMPLEMENTED', `Unknown message type: ${type}`));
  }
}

// =============================================================================
// Port Connection Handler
// =============================================================================

export function setupProviderRouter(): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'provider-bridge') return;
    
    log('Provider bridge connected');
    
    port.onMessage.addListener((message: ProviderMessage & { origin: string }) => {
      if (message.namespace !== 'harbor-provider') return;
      handleProviderMessage(port, message);
    });
    
    port.onDisconnect.addListener(() => {
      log('Provider bridge disconnected');
      // Clean up any pending requests for this port
      for (const [promptId, pending] of pendingPermissionRequests) {
        if (pending.port === port) {
          pendingPermissionRequests.delete(promptId);
        }
      }
    });
  });
  
  // Clean up temporary grants when tabs close
  browser.tabs.onRemoved.addListener((tabId) => {
    clearTabGrants(tabId);
  });
  
  log('Provider router initialized');
}

// Export for permission prompt to use
export { pendingPermissionRequests };

