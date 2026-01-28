/**
 * Background Router
 *
 * Routes messages from content scripts to appropriate handlers.
 * Handles the Web Agent API (window.ai/window.agent) requests from web pages.
 */

import { browserAPI } from '../browser-compat';
import type {
  MessageType,
  TransportResponse,
  TransportStreamEvent,
  PermissionScope,
  PermissionGrantResult,
  PermissionStatus,
  RequestPermissionsOptions,
  ToolDescriptor,
  RunEvent,
  StreamToken,
  ApiError,
} from './types';
import {
  getPermissionStatus,
  checkPermissions,
  requestPermissions,
  handlePermissionPromptResponse,
  isToolAllowed,
  SCOPE_DESCRIPTIONS,
} from '../policy/permissions';
import { isFeatureEnabled } from '../policy/feature-flags';
import { listServersWithStatus, callTool } from '../mcp/host';
import {
  getTabReadability,
  clickElement,
  fillInput,
  selectOption,
  scrollPage,
  getElementInfo,
  waitForSelector,
  takeScreenshot,
} from './browser-api';
import {
  initializeTabManager,
  listTabs,
  getTab,
  createTab,
  closeTab,
  navigateTab,
  waitForNavigation,
  canOriginControlTab,
} from '../tabs/manager';
import {
  initializeAgentRegistry,
  registerAgent,
  unregisterAgent,
  getAgent,
  getAgentsByOrigin,
  getAgentUsage,
  discoverAgents,
} from '../multi-agent/registry';
import {
  sendMessage as sendAgentMessage,
  invokeAgent as invokeAgentHandler,
  registerMessageHandler,
  unregisterMessageHandler,
  registerInvocationHandler,
  unregisterInvocationHandler,
  subscribeToEvent,
  unsubscribeFromEvent,
} from '../multi-agent/messaging';
import {
  executePipeline,
  executeParallel,
  executeRouter,
  executeSupervisor,
} from '../multi-agent/orchestration';
import {
  connectRemoteAgent,
  disconnectRemoteAgent,
  listRemoteAgents,
  pingRemoteAgent,
  discoverRemoteAgents,
} from '../multi-agent/remote';
import type {
  AgentRegistrationOptions,
  Pipeline,
  ParallelExecution,
  AgentRouter,
  RemoteAgentEndpoint,
  Supervisor,
  SupervisorTask,
} from '../multi-agent/types';
import { bridgeRequest } from '../llm/bridge-client';
import { isNativeBridgeReady } from '../llm/native-bridge';
import { getRuntimeCapabilities, listAllProviders } from '../llm/provider-registry';

const DEBUG = true;

function log(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[Harbor Router]', ...args);
  }
}

/**
 * Check if a feature flag is enabled. If not, send an error response.
 * Returns true if the feature is enabled, false if it was rejected.
 * Used for browserControl and multiAgent flags.
 */
async function requireExtensionFeature(
  feature: 'browserControl' | 'multiAgent',
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<boolean> {
  const enabled = await isFeatureEnabled(feature);
  if (!enabled) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_FEATURE_DISABLED',
        message: `Feature "${feature}" is not enabled. Enable it in Harbor settings.`,
      },
    });
    return false;
  }
  return true;
}

// =============================================================================
// State Management
// =============================================================================

// Active text sessions
const textSessions = new Map<string, {
  sessionId: string;
  origin: string;
  options: Record<string, unknown>;
  history: Array<{ role: string; content: string }>;
  createdAt: number;
}>();

// Active page chats
const activeChats = new Map<string, {
  chatId: string;
  tabId: number;
  origin: string;
  config: {
    initialMessage?: string;
    systemPrompt?: string;
    tools?: string[];
    style?: {
      theme?: 'light' | 'dark' | 'auto';
      accentColor?: string;
      position?: 'right' | 'left' | 'center';
    };
  };
  createdAt: number;
}>();

// Session/Chat ID counter
let sessionIdCounter = 0;

function generateSessionId(): string {
  return `session-${Date.now()}-${++sessionIdCounter}`;
}

// =============================================================================
// Message Types
// =============================================================================

interface RequestContext {
  id: string;
  type: MessageType;
  payload: unknown;
  origin: string;
  tabId?: number;
}

type ResponseSender = {
  sendResponse: (response: TransportResponse) => void;
  sendStreamEvent: (event: TransportStreamEvent) => void;
};

// =============================================================================
// Permission Helpers
// =============================================================================

async function requirePermission(
  ctx: RequestContext,
  sender: ResponseSender,
  scope: PermissionScope,
): Promise<boolean> {
  const result = await checkPermissions(ctx.origin, [scope], ctx.tabId);
  if (result.granted) {
    return true;
  }

  sender.sendResponse({
    id: ctx.id,
    ok: false,
    error: {
      code: 'ERR_SCOPE_REQUIRED',
      message: `Permission "${scope}" is required. Call agent.requestPermissions() first.`,
      details: { requiredScope: scope, missingScopes: result.missingScopes },
    },
  });
  return false;
}

type FeatureFlagName = 'browserInteraction' | 'screenshots' | 'experimental';

async function requireFeature(
  ctx: RequestContext,
  sender: ResponseSender,
  feature: FeatureFlagName,
  featureDescription: string,
): Promise<boolean> {
  const enabled = await isFeatureEnabled(feature);
  if (enabled) {
    return true;
  }

  sender.sendResponse({
    id: ctx.id,
    ok: false,
    error: {
      code: 'ERR_FEATURE_DISABLED',
      message: `${featureDescription} is disabled. Enable "${feature}" in Harbor settings.`,
      details: { feature },
    },
  });
  return false;
}

// =============================================================================
// Request Handlers
// =============================================================================

async function handleRequestPermissions(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const payload = ctx.payload as RequestPermissionsOptions;
  log('handleRequestPermissions:', ctx.origin, payload);

  const result = await requestPermissions(ctx.origin, payload, ctx.tabId);
  log('Permission result:', result);

  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result,
  });
}

async function handleListPermissions(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const status = await getPermissionStatus(ctx.origin, ctx.tabId);
  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: status,
  });
}

/**
 * Handle agent.capabilities() - Returns comprehensive capabilities report.
 * This is the unified way to discover what the agent can do.
 */
async function handleAgentCapabilities(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  try {
    // Get permission status
    const permStatus = await getPermissionStatus(ctx.origin, ctx.tabId);
    
    // Get runtime capabilities (LLM info)
    const runtimeCaps = await getRuntimeCapabilities();
    
    // Get available tools
    let toolCount = 0;
    const serverIds: string[] = [];
    try {
      const servers = await listServersWithStatus();
      for (const server of servers) {
        if (server.running) {
          serverIds.push(server.id);
          toolCount += server.tools?.length || 0;
        }
      }
    } catch {
      // MCP not available
    }
    
    // Get feature flags
    const browserInteractionEnabled = await isFeatureEnabled('browserInteraction');
    const screenshotsEnabled = await isFeatureEnabled('screenshots');
    const browserControlEnabled = await isFeatureEnabled('browserControl');
    const multiAgentEnabled = await isFeatureEnabled('multiAgent');
    
    // Determine best runtime
    let bestRuntime: 'firefox' | 'chrome' | 'harbor' | null = null;
    if (runtimeCaps.firefox?.available && runtimeCaps.firefox.hasWllama) {
      bestRuntime = 'firefox';
    } else if (runtimeCaps.chrome?.available) {
      bestRuntime = 'chrome';
    } else if (runtimeCaps.harbor?.bridgeConnected) {
      bestRuntime = 'harbor';
    }
    
    // Build the capabilities report
    const report = {
      version: '1.0.0',
      
      llm: {
        available: runtimeCaps.harbor?.bridgeConnected || 
                   runtimeCaps.firefox?.available || 
                   runtimeCaps.chrome?.available || false,
        streaming: true, // All our providers support streaming
        toolCalling: runtimeCaps.harbor?.bridgeConnected || 
                     runtimeCaps.firefox?.supportsTools || 
                     runtimeCaps.chrome?.supportsTools || false,
        providers: runtimeCaps.harbor?.providers || [],
        bestRuntime,
      },
      
      tools: {
        available: toolCount > 0,
        count: toolCount,
        servers: serverIds,
      },
      
      browser: {
        readActiveTab: true, // Always supported
        interact: browserInteractionEnabled,
        screenshot: screenshotsEnabled,
        // Extension 2 features (requires browserControl flag)
        navigate: browserControlEnabled,
        readTabs: browserControlEnabled,
        createTabs: browserControlEnabled,
      },
      
      // Extension 3 features (requires multiAgent flag)
      agents: {
        register: multiAgentEnabled,
        discover: multiAgentEnabled,
        invoke: multiAgentEnabled,
        message: multiAgentEnabled,
        crossOrigin: multiAgentEnabled,
        remote: multiAgentEnabled,
      },
      
      permissions: {
        llm: {
          prompt: permStatus.scopes['model:prompt'] || 'not-granted',
          tools: permStatus.scopes['model:tools'] || 'not-granted',
          list: permStatus.scopes['model:list'] || 'not-granted',
        },
        mcp: {
          list: permStatus.scopes['mcp:tools.list'] || 'not-granted',
          call: permStatus.scopes['mcp:tools.call'] || 'not-granted',
          register: permStatus.scopes['mcp:servers.register'] || 'not-granted',
        },
        browser: {
          read: permStatus.scopes['browser:activeTab.read'] || 'not-granted',
          interact: permStatus.scopes['browser:activeTab.interact'] || 'not-granted',
          screenshot: permStatus.scopes['browser:activeTab.screenshot'] || 'not-granted',
          // Extension 2 scopes
          navigate: permStatus.scopes['browser:navigate'] || 'not-granted',
          tabsRead: permStatus.scopes['browser:tabs.read'] || 'not-granted',
          tabsCreate: permStatus.scopes['browser:tabs.create'] || 'not-granted',
        },
        // Extension 3 scopes
        agents: {
          register: permStatus.scopes['agents:register'] || 'not-granted',
          discover: permStatus.scopes['agents:discover'] || 'not-granted',
          invoke: permStatus.scopes['agents:invoke'] || 'not-granted',
          message: permStatus.scopes['agents:message'] || 'not-granted',
          crossOrigin: permStatus.scopes['agents:crossOrigin'] || 'not-granted',
          remote: permStatus.scopes['agents:remote'] || 'not-granted',
        },
        web: {
          fetch: permStatus.scopes['web:fetch'] || 'not-granted',
        },
      },
      
      allowedTools: permStatus.allowedTools || [],
      
      features: {
        browserInteraction: browserInteractionEnabled,
        screenshots: screenshotsEnabled,
        // Extension 2 & 3 feature flags
        browserControl: browserControlEnabled,
        multiAgent: multiAgentEnabled,
        remoteTabs: browserControlEnabled, // Part of browserControl
        webFetch: browserControlEnabled,   // Part of browserControl
      },
    };
    
    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: report,
    });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to get capabilities',
      },
    });
  }
}

async function handleToolsList(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'mcp:tools.list'))) {
    return;
  }

  try {
    const servers = await listServersWithStatus();
    const tools: ToolDescriptor[] = [];

    for (const server of servers) {
      if (server.running && server.tools) {
        for (const tool of server.tools) {
          tools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            serverId: server.id,
          });
        }
      }
    }

    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: tools,
    });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to list tools',
      },
    });
  }
}

async function handleToolsCall(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'mcp:tools.call'))) {
    return;
  }

  const payload = ctx.payload as { tool: string; args: Record<string, unknown> };

  // Check if tool is allowed
  const allowed = await isToolAllowed(ctx.origin, payload.tool);
  if (!allowed) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_TOOL_NOT_ALLOWED',
        message: `Tool "${payload.tool}" is not in the allowed list`,
      },
    });
    return;
  }

  try {
    // Parse tool name to get serverId
    const parts = payload.tool.split('/');
    let serverId: string;
    let toolName: string;

    if (parts.length >= 2) {
      serverId = parts[0];
      toolName = parts.slice(1).join('/');
    } else {
      // Try to find the tool in any server
      const servers = await listServersWithStatus();
      const found = servers.find(s => s.running && s.tools?.some(t => t.name === payload.tool));
      if (!found) {
        sender.sendResponse({
          id: ctx.id,
          ok: false,
          error: {
            code: 'ERR_TOOL_NOT_ALLOWED',
            message: `Tool "${payload.tool}" not found in any running server`,
          },
        });
        return;
      }
      serverId = found.id;
      toolName = payload.tool;
    }

    const result = await callTool(serverId, toolName, payload.args);
    sender.sendResponse({
      id: ctx.id,
      ok: result.ok,
      result: result.result,
      error: result.error ? { code: 'ERR_TOOL_FAILED', message: result.error } : undefined,
    });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Tool call failed',
      },
    });
  }
}

async function handleCanCreateTextSession(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  // Check if bridge is connected
  try {
    const result = await bridgeRequest<{ models: unknown[] }>('llm.list_configured_models');
    const available = result.models && result.models.length > 0 ? 'readily' : 'no';
    sender.sendResponse({ id: ctx.id, ok: true, result: available });
  } catch {
    sender.sendResponse({ id: ctx.id, ok: true, result: 'no' });
  }
}

async function handleCreateTextSession(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'model:prompt'))) {
    return;
  }

  const payload = (ctx.payload || {}) as Record<string, unknown>;
  const sessionId = generateSessionId();

  textSessions.set(sessionId, {
    sessionId,
    origin: ctx.origin,
    options: payload,
    history: payload.systemPrompt
      ? [{ role: 'system', content: payload.systemPrompt as string }]
      : [],
    createdAt: Date.now(),
  });

  sender.sendResponse({ id: ctx.id, ok: true, result: sessionId });
}

async function handleSessionPrompt(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'model:prompt'))) {
    return;
  }

  const payload = ctx.payload as { sessionId: string; input: string };
  const session = textSessions.get(payload.sessionId);

  if (!session) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_SESSION_NOT_FOUND', message: 'Session not found' },
    });
    return;
  }

  if (session.origin !== ctx.origin) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Session belongs to different origin' },
    });
    return;
  }

  try {
    // Add user message to history
    session.history.push({ role: 'user', content: payload.input });

    // Call LLM
    const result = await bridgeRequest<{
      choices?: Array<{ message?: { role: string; content: string } }>;
      response?: { role: string; content: string };
      message?: { role: string; content: string };
      content?: string;
    }>('llm.chat', {
      messages: session.history,
      model: session.options.model,
    });

    // Extract content - bridge returns in choices[0].message.content format
    const content = result.choices?.[0]?.message?.content 
      || result.response?.content 
      || result.message?.content 
      || result.content 
      || '';

    log('Session prompt result:', content.slice(0, 100));

    // Add assistant response to history
    session.history.push({ role: 'assistant', content });

    sender.sendResponse({ id: ctx.id, ok: true, result: content });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_MODEL_FAILED',
        message: error instanceof Error ? error.message : 'Model request failed',
      },
    });
  }
}

async function handleSessionDestroy(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const payload = ctx.payload as { sessionId: string };
  const session = textSessions.get(payload.sessionId);

  if (session && session.origin === ctx.origin) {
    textSessions.delete(payload.sessionId);
  }

  sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
}

async function handleLanguageModelCapabilities(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  try {
    const result = await bridgeRequest<{ models: unknown[] }>('llm.list_configured_models');
    const available = result.models && result.models.length > 0 ? 'readily' : 'no';
    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: {
        available,
        defaultTemperature: 0.7,
        defaultTopK: 40,
        maxTopK: 100,
      },
    });
  } catch {
    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: { available: 'no' },
    });
  }
}

async function handleProviderslist(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'model:list'))) {
    return;
  }

  try {
    // Use the provider registry which includes native browser providers
    const providers = await listAllProviders();
    sender.sendResponse({ id: ctx.id, ok: true, result: providers });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to list providers',
      },
    });
  }
}

async function handleRuntimeGetCapabilities(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  try {
    const capabilities = await getRuntimeCapabilities();
    sender.sendResponse({ id: ctx.id, ok: true, result: capabilities });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to get runtime capabilities',
      },
    });
  }
}

// =============================================================================
// Agent Run Handler
// =============================================================================

async function handleAgentRun(
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

// =============================================================================
// Browser API Handlers (Same-Tab Only)
// =============================================================================

async function handleActiveTabReadability(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:activeTab.read'))) {
    return;
  }

  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'No tab ID available' },
    });
    return;
  }

  try {
    const result = await getTabReadability(ctx.tabId);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code || 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to read tab',
      },
    });
  }
}

async function handleActiveTabClick(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  // Feature flag check first
  if (!(await requireFeature(ctx, sender, 'browserInteraction', 'Browser interaction'))) {
    return;
  }

  if (!(await requirePermission(ctx, sender, 'browser:activeTab.interact'))) {
    return;
  }

  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'No tab ID available' },
    });
    return;
  }

  const payload = ctx.payload as { selector: string; options?: { button?: string; clickCount?: number } };

  try {
    await clickElement(ctx.tabId, payload.selector, payload.options);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code || 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Click failed',
      },
    });
  }
}

async function handleActiveTabFill(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireFeature(ctx, sender, 'browserInteraction', 'Browser interaction'))) {
    return;
  }

  if (!(await requirePermission(ctx, sender, 'browser:activeTab.interact'))) {
    return;
  }

  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'No tab ID available' },
    });
    return;
  }

  const payload = ctx.payload as { selector: string; value: string };

  try {
    await fillInput(ctx.tabId, payload.selector, payload.value);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code || 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Fill failed',
      },
    });
  }
}

async function handleActiveTabSelect(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireFeature(ctx, sender, 'browserInteraction', 'Browser interaction'))) {
    return;
  }

  if (!(await requirePermission(ctx, sender, 'browser:activeTab.interact'))) {
    return;
  }

  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'No tab ID available' },
    });
    return;
  }

  const payload = ctx.payload as { selector: string; value: string };

  try {
    await selectOption(ctx.tabId, payload.selector, payload.value);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code || 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Select failed',
      },
    });
  }
}

async function handleActiveTabScroll(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireFeature(ctx, sender, 'browserInteraction', 'Browser interaction'))) {
    return;
  }

  if (!(await requirePermission(ctx, sender, 'browser:activeTab.interact'))) {
    return;
  }

  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'No tab ID available' },
    });
    return;
  }

  const payload = ctx.payload as { x?: number; y?: number; selector?: string; behavior?: 'auto' | 'smooth' };

  try {
    await scrollPage(ctx.tabId, payload);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code || 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Scroll failed',
      },
    });
  }
}

async function handleActiveTabGetElement(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:activeTab.read'))) {
    return;
  }

  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'No tab ID available' },
    });
    return;
  }

  const payload = ctx.payload as { selector: string };

  try {
    const result = await getElementInfo(ctx.tabId, payload.selector);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code || 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Get element failed',
      },
    });
  }
}

async function handleActiveTabWaitForSelector(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:activeTab.read'))) {
    return;
  }

  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'No tab ID available' },
    });
    return;
  }

  const payload = ctx.payload as { selector: string; options?: { timeout?: number; visible?: boolean } };

  try {
    const result = await waitForSelector(ctx.tabId, payload.selector, payload.options);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code || 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Wait failed',
      },
    });
  }
}

async function handleActiveTabScreenshot(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireFeature(ctx, sender, 'screenshots', 'Screenshots'))) {
    return;
  }

  if (!(await requirePermission(ctx, sender, 'browser:activeTab.screenshot'))) {
    return;
  }

  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'No tab ID available' },
    });
    return;
  }

  const payload = ctx.payload as { format?: 'png' | 'jpeg'; quality?: number } | undefined;

  try {
    const result = await takeScreenshot(ctx.tabId, payload);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code || 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Screenshot failed',
      },
    });
  }
}

// =============================================================================
// Extension 2: Navigation and Tabs Handlers
// =============================================================================

async function handleBrowserNavigate(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('browserControl', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'browser:navigate'))) {
    return;
  }

  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'No tab ID available' },
    });
    return;
  }

  const payload = ctx.payload as { url: string };

  try {
    await navigateTab(ctx.origin, ctx.tabId, payload.url, true);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Navigation failed',
      },
    });
  }
}

async function handleBrowserWaitForNavigation(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('browserControl', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'browser:navigate'))) {
    return;
  }

  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'No tab ID available' },
    });
    return;
  }

  const payload = ctx.payload as { timeout?: number } | undefined;

  try {
    await waitForNavigation(ctx.tabId, payload?.timeout);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_TIMEOUT',
        message: error instanceof Error ? error.message : 'Navigation timeout',
      },
    });
  }
}

async function handleTabsList(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('browserControl', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'browser:tabs.read'))) {
    return;
  }

  try {
    const tabs = await listTabs(ctx.origin);
    sender.sendResponse({ id: ctx.id, ok: true, result: tabs });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to list tabs',
      },
    });
  }
}

async function handleTabsGet(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('browserControl', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'browser:tabs.read'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number };

  try {
    const tab = await getTab(ctx.origin, payload.tabId);
    sender.sendResponse({ id: ctx.id, ok: true, result: tab });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to get tab',
      },
    });
  }
}

async function handleTabsCreate(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('browserControl', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { url: string; active?: boolean; index?: number; windowId?: number };

  try {
    const tab = await createTab(ctx.origin, payload, ctx.tabId);
    sender.sendResponse({ id: ctx.id, ok: true, result: tab });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to create tab',
      },
    });
  }
}

async function handleTabsClose(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('browserControl', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number };

  // Check if origin can control this tab
  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Cannot close tab: origin did not create this tab',
      },
    });
    return;
  }

  try {
    const result = await closeTab(ctx.origin, payload.tabId);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to close tab',
      },
    });
  }
}

// Spawned tab operations (operations on tabs the origin created)
async function handleSpawnedTabReadability(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('browserControl', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number };

  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Cannot read tab: origin did not create this tab',
      },
    });
    return;
  }

  try {
    const result = await getTabReadability(payload.tabId);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to read tab',
      },
    });
  }
}

async function handleSpawnedTabClick(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('browserControl', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number; selector: string; options?: { button?: string; clickCount?: number } };

  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Cannot interact with tab: origin did not create this tab',
      },
    });
    return;
  }

  try {
    await clickElement(payload.tabId, payload.selector, payload.options);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Click failed',
      },
    });
  }
}

async function handleSpawnedTabFill(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('browserControl', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number; selector: string; value: string };

  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Cannot interact with tab: origin did not create this tab',
      },
    });
    return;
  }

  try {
    await fillInput(payload.tabId, payload.selector, payload.value);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Fill failed',
      },
    });
  }
}

async function handleSpawnedTabScroll(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('browserControl', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number; x?: number; y?: number; selector?: string; behavior?: 'auto' | 'smooth' };

  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Cannot interact with tab: origin did not create this tab',
      },
    });
    return;
  }

  try {
    await scrollPage(payload.tabId, payload);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Scroll failed',
      },
    });
  }
}

async function handleSpawnedTabScreenshot(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('browserControl', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number; format?: 'png' | 'jpeg'; quality?: number };

  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Cannot screenshot tab: origin did not create this tab',
      },
    });
    return;
  }

  try {
    const result = await takeScreenshot(payload.tabId, payload);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Screenshot failed',
      },
    });
  }
}

async function handleSpawnedTabNavigate(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('browserControl', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number; url: string };

  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Cannot navigate tab: origin did not create this tab',
      },
    });
    return;
  }

  try {
    await navigateTab(ctx.origin, payload.tabId, payload.url, false);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Navigation failed',
      },
    });
  }
}

async function handleSpawnedTabWaitForNavigation(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('browserControl', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number; timeout?: number };

  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Cannot wait on tab: origin did not create this tab',
      },
    });
    return;
  }

  try {
    await waitForNavigation(payload.tabId, payload.timeout);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_TIMEOUT',
        message: error instanceof Error ? error.message : 'Navigation timeout',
      },
    });
  }
}

// =============================================================================
// Extension 2: Web Fetch Handler
// =============================================================================

// Allowed domains for web fetch (user configurable in the future)
const FETCH_ALLOWED_DOMAINS: string[] = [];

async function handleAgentFetch(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('browserControl', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'web:fetch'))) {
    return;
  }

  const payload = ctx.payload as {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };

  try {
    const url = new URL(payload.url);
    
    // Check domain allowlist (for now, allow all - user will configure)
    // In production, this should check against user's configured allowlist
    if (FETCH_ALLOWED_DOMAINS.length > 0 && !FETCH_ALLOWED_DOMAINS.includes(url.hostname)) {
      sender.sendResponse({
        id: ctx.id,
        ok: false,
        error: {
          code: 'ERR_PERMISSION_DENIED',
          message: `Domain ${url.hostname} is not in the allowed list`,
        },
      });
      return;
    }

    const response = await fetch(payload.url, {
      method: payload.method || 'GET',
      headers: payload.headers,
      body: payload.body,
    });

    const text = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers,
        text,
      },
    });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Fetch failed',
      },
    });
  }
}

// =============================================================================
// Extension 3: Multi-Agent Handlers
// =============================================================================

// Track which agent each origin has registered (origin -> agentId)
const originAgents = new Map<string, string>();

async function handleAgentsRegister(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('multiAgent', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'agents:register'))) {
    return;
  }

  const options = ctx.payload as AgentRegistrationOptions;

  try {
    const agent = registerAgent(options, ctx.origin, ctx.tabId);
    originAgents.set(ctx.origin, agent.id);

    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: {
        id: agent.id,
        name: agent.name,
        capabilities: agent.capabilities,
        tags: agent.tags,
      },
    });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Registration failed',
      },
    });
  }
}

async function handleAgentsUnregister(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('multiAgent', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'agents:register'))) {
    return;
  }

  const payload = ctx.payload as { agentId: string };

  const result = unregisterAgent(payload.agentId, ctx.origin);
  if (result) {
    originAgents.delete(ctx.origin);
  }

  sender.sendResponse({ id: ctx.id, ok: true, result });
}

async function handleAgentsGetInfo(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('multiAgent', ctx, sender))) {
    return;
  }
  const payload = ctx.payload as { agentId?: string } | undefined;
  const agentId = payload?.agentId || originAgents.get(ctx.origin);

  if (!agentId) {
    sender.sendResponse({ id: ctx.id, ok: true, result: null });
    return;
  }

  const agent = getAgent(agentId);
  if (!agent) {
    sender.sendResponse({ id: ctx.id, ok: true, result: null });
    return;
  }

  // Only return info if same origin or has crossOrigin permission
  if (agent.origin !== ctx.origin) {
    const check = await checkPermissions(ctx.origin, ['agents:crossOrigin']);
    if (!check.granted) {
      sender.sendResponse({ id: ctx.id, ok: true, result: null });
      return;
    }
  }

  const usage = getAgentUsage(agentId);

  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      origin: agent.origin,
      capabilities: agent.capabilities,
      tags: agent.tags,
      status: agent.status,
      usage: usage || {
        promptCount: 0,
        tokensUsed: 0,
        toolCallCount: 0,
        messagesSent: 0,
        invocationsMade: 0,
        invocationsReceived: 0,
      },
    },
  });
}

async function handleAgentsDiscover(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('multiAgent', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'agents:discover'))) {
    return;
  }

  const payload = ctx.payload as {
    name?: string;
    capabilities?: string[];
    tags?: string[];
    includeSameOrigin?: boolean;
    includeCrossOrigin?: boolean;
    includeRemote?: boolean;
  } | undefined;

  // Check if cross-origin discovery is allowed
  let allowCrossOrigin = false;
  if (payload?.includeCrossOrigin) {
    const check = await checkPermissions(ctx.origin, ['agents:crossOrigin']);
    allowCrossOrigin = check.granted;
  }

  const agents = discoverAgents(ctx.origin, payload || {}, allowCrossOrigin);

  sender.sendResponse({ id: ctx.id, ok: true, result: agents });
}

async function handleAgentsList(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('multiAgent', ctx, sender))) {
    return;
  }
  const agents = getAgentsByOrigin(ctx.origin);

  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: agents.map(a => ({
      id: a.id,
      name: a.name,
      status: a.status,
    })),
  });
}

async function handleAgentsInvoke(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('multiAgent', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'agents:invoke'))) {
    return;
  }

  const payload = ctx.payload as {
    agentId: string;
    task: string;
    input?: unknown;
    timeout?: number;
  };

  const fromAgentId = originAgents.get(ctx.origin);
  if (!fromAgentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_NOT_REGISTERED',
        message: 'Must register as an agent before invoking others',
      },
    });
    return;
  }

  const result = await invokeAgentHandler(
    {
      agentId: payload.agentId,
      task: payload.task,
      input: payload.input,
      timeout: payload.timeout,
    },
    fromAgentId,
    ctx.origin,
  );

  sender.sendResponse({ id: ctx.id, ok: true, result });
}

async function handleAgentsSend(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('multiAgent', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'agents:message'))) {
    return;
  }

  const payload = ctx.payload as { to: string; payload: unknown };

  const fromAgentId = originAgents.get(ctx.origin);
  if (!fromAgentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_NOT_REGISTERED',
        message: 'Must register as an agent before sending messages',
      },
    });
    return;
  }

  const result = await sendAgentMessage(fromAgentId, payload.to, payload.payload, ctx.origin);

  sender.sendResponse({ id: ctx.id, ok: true, result });
}

async function handleAgentsSubscribe(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('multiAgent', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'agents:message'))) {
    return;
  }

  const payload = ctx.payload as { eventType: string };
  const agentId = originAgents.get(ctx.origin);

  if (agentId) {
    subscribeToEvent(agentId, payload.eventType);
  }

  sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
}

async function handleAgentsUnsubscribe(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('multiAgent', ctx, sender))) {
    return;
  }
  const payload = ctx.payload as { eventType: string };
  const agentId = originAgents.get(ctx.origin);

  if (agentId) {
    unsubscribeFromEvent(agentId, payload.eventType);
  }

  sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
}

function handleAgentsRegisterMessageHandler(ctx: RequestContext, sender: ResponseSender): void {
  const agentId = originAgents.get(ctx.origin);
  if (!agentId) {
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
    return;
  }

  // The actual handler is in the page, we just track registration
  registerMessageHandler(agentId, (message) => {
    // Forward message to the page
    if (ctx.tabId) {
      browserAPI.tabs.sendMessage(ctx.tabId, {
        type: 'harbor_agent_message',
        message,
      }).catch(() => {});
    }
  });

  sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
}

function handleAgentsUnregisterMessageHandler(ctx: RequestContext, sender: ResponseSender): void {
  const agentId = originAgents.get(ctx.origin);
  if (agentId) {
    unregisterMessageHandler(agentId);
  }
  sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
}

function handleAgentsRegisterInvocationHandler(ctx: RequestContext, sender: ResponseSender): void {
  const agentId = originAgents.get(ctx.origin);
  if (!agentId) {
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
    return;
  }

  registerInvocationHandler(agentId, async (request) => {
    // Send invocation to the page and wait for response
    // This is simplified - in production we'd need proper message passing
    return {
      success: false,
      error: { code: 'ERR_NOT_IMPLEMENTED', message: 'Page invocation handlers not fully implemented' },
      executionTime: 0,
    };
  });

  sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
}

function handleAgentsUnregisterInvocationHandler(ctx: RequestContext, sender: ResponseSender): void {
  const agentId = originAgents.get(ctx.origin);
  if (agentId) {
    unregisterInvocationHandler(agentId);
  }
  sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
}

// Orchestration handlers
async function handleOrchestratePipeline(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('multiAgent', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'agents:invoke'))) {
    return;
  }

  const payload = ctx.payload as { pipeline: Pipeline; initialInput: unknown };
  const agentId = originAgents.get(ctx.origin);

  if (!agentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_NOT_REGISTERED', message: 'Must register as an agent first' },
    });
    return;
  }

  const result = await executePipeline(payload.pipeline, payload.initialInput, agentId, ctx.origin);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}

async function handleOrchestrateParallel(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('multiAgent', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'agents:invoke'))) {
    return;
  }

  const payload = ctx.payload as ParallelExecution;
  const agentId = originAgents.get(ctx.origin);

  if (!agentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_NOT_REGISTERED', message: 'Must register as an agent first' },
    });
    return;
  }

  const result = await executeParallel(payload, agentId, ctx.origin);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}

async function handleOrchestrateRoute(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('multiAgent', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'agents:invoke'))) {
    return;
  }

  const payload = ctx.payload as { router: AgentRouter; input: unknown; task: string };
  const agentId = originAgents.get(ctx.origin);

  if (!agentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_NOT_REGISTERED', message: 'Must register as an agent first' },
    });
    return;
  }

  const result = await executeRouter(payload.router, payload.input, payload.task, agentId, ctx.origin);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}

async function handleOrchestrateSupervisor(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('multiAgent', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'agents:invoke'))) {
    return;
  }

  const payload = ctx.payload as { supervisor: Supervisor; tasks: SupervisorTask[] };
  const agentId = originAgents.get(ctx.origin);

  if (!agentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_NOT_REGISTERED', message: 'Must register as an agent first' },
    });
    return;
  }

  const result = await executeSupervisor(payload.supervisor, payload.tasks, agentId, ctx.origin);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}

// Remote A2A handlers
async function handleRemoteConnect(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('multiAgent', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'agents:remote'))) {
    return;
  }

  const payload = ctx.payload as RemoteAgentEndpoint;

  try {
    const agent = await connectRemoteAgent(payload);
    if (agent) {
      sender.sendResponse({
        id: ctx.id,
        ok: true,
        result: {
          id: agent.id,
          name: agent.name,
          description: agent.description,
          capabilities: agent.capabilities,
          reachable: agent.reachable,
        },
      });
    } else {
      sender.sendResponse({
        id: ctx.id,
        ok: true,
        result: null,
      });
    }
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Connection failed',
      },
    });
  }
}

async function handleRemoteDisconnect(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('multiAgent', ctx, sender))) {
    return;
  }
  const payload = ctx.payload as { agentId: string };
  const result = disconnectRemoteAgent(payload.agentId);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}

async function handleRemoteList(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('multiAgent', ctx, sender))) {
    return;
  }
  const agents = listRemoteAgents();
  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: agents.map(a => ({
      id: a.id,
      name: a.name,
      description: a.description,
      capabilities: a.capabilities,
      url: a.endpoint.url,
      reachable: a.reachable,
      lastPing: a.lastPing,
    })),
  });
}

async function handleRemotePing(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('multiAgent', ctx, sender))) {
    return;
  }
  const payload = ctx.payload as { agentId: string };
  const result = await pingRemoteAgent(payload.agentId);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}

async function handleRemoteDiscover(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  if (!(await requireExtensionFeature('multiAgent', ctx, sender))) {
    return;
  }
  if (!(await requirePermission(ctx, sender, 'agents:remote'))) {
    return;
  }

  const payload = ctx.payload as { baseUrl: string };

  try {
    const agents = await discoverRemoteAgents(payload.baseUrl);
    sender.sendResponse({ id: ctx.id, ok: true, result: agents });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Discovery failed',
      },
    });
  }
}

// =============================================================================
// Chat Handlers
// =============================================================================

function handleChatCanOpen(ctx: RequestContext, sender: ResponseSender): void {
  // Chat is available as long as we have the scripting permission
  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: 'readily',
  });
}

async function handleChatOpen(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  const payload = ctx.payload as {
    initialMessage?: string;
    systemPrompt?: string;
    tools?: string[];
    sessionId?: string;
    style?: {
      theme?: 'light' | 'dark' | 'auto';
      accentColor?: string;
      position?: 'right' | 'left' | 'center';
    };
  } | undefined;

  // Check permission
  const hasPermission = await checkPermissions(ctx.origin, ['chat:open']);
  if (!hasPermission) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Permission "chat:open" is required. Call agent.requestPermissions() first.',
      },
    });
    return;
  }

  // Get the tab ID
  const tabId = ctx.tabId;
  if (!tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: 'No tab ID available',
      },
    });
    return;
  }

  // Generate chat ID
  const chatId = `chat-${Date.now()}-${++sessionIdCounter}`;

  // Store chat state
  activeChats.set(chatId, {
    chatId,
    tabId,
    origin: ctx.origin,
    config: {
      initialMessage: payload?.initialMessage,
      systemPrompt: payload?.systemPrompt,
      tools: payload?.tools,
      style: payload?.style,
    },
    createdAt: Date.now(),
  });

  try {
    // Inject config first
    await browserAPI.scripting.executeScript({
      target: { tabId },
      func: (config: unknown) => {
        (window as unknown as { __harborPageChatConfig: unknown }).__harborPageChatConfig = config;
      },
      args: [{
        chatId,
        initialMessage: payload?.initialMessage,
        systemPrompt: payload?.systemPrompt,
        tools: payload?.tools,
        style: payload?.style,
      }],
    });

    // Then inject page-chat.js
    await browserAPI.scripting.executeScript({
      target: { tabId },
      files: ['dist/page-chat.js'],
    });

    log('Page chat injected into tab', tabId, 'with chatId', chatId);

    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: { success: true, chatId },
    });
  } catch (err) {
    log('Failed to inject page chat:', err);
    activeChats.delete(chatId);
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: `Failed to open chat: ${err instanceof Error ? err.message : 'Unknown error'}`,
      },
    });
  }
}

async function handleChatClose(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  const payload = ctx.payload as { chatId?: string } | undefined;
  const chatId = payload?.chatId;

  if (chatId) {
    // Close specific chat
    const chat = activeChats.get(chatId);
    if (chat) {
      try {
        await browserAPI.tabs.sendMessage(chat.tabId, {
          type: 'harbor_chat_close',
          chatId,
        });
      } catch {
        // Tab might be closed
      }
      activeChats.delete(chatId);
    }
  } else {
    // Close all chats for this origin
    for (const [id, chat] of activeChats) {
      if (chat.origin === ctx.origin) {
        try {
          await browserAPI.tabs.sendMessage(chat.tabId, {
            type: 'harbor_chat_close',
            chatId: id,
          });
        } catch {
          // Tab might be closed
        }
        activeChats.delete(id);
      }
    }
  }

  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: { success: true },
  });
}

// =============================================================================

function handleNotImplemented(ctx: RequestContext, sender: ResponseSender): void {
  sender.sendResponse({
    id: ctx.id,
    ok: false,
    error: {
      code: 'ERR_NOT_IMPLEMENTED',
      message: `Method "${ctx.type}" is not yet implemented`,
    },
  });
}

function handleStreamingNotImplemented(ctx: RequestContext, sender: ResponseSender): void {
  // For streaming methods, send an error event with done: true
  sender.sendStreamEvent({
    id: ctx.id,
    event: {
      type: 'error',
      error: {
        code: 'ERR_NOT_IMPLEMENTED',
        message: `Method "${ctx.type}" is not yet implemented`,
      },
    },
    done: true,
  });
}

// =============================================================================
// Message Router
// =============================================================================

async function routeMessage(ctx: RequestContext, sender: ResponseSender): Promise<void> {
  log('Routing message:', ctx.type, 'from', ctx.origin);

  switch (ctx.type) {
    // Permission methods
    case 'agent.requestPermissions':
      return handleRequestPermissions(ctx, sender);
    case 'agent.permissions.list':
      return handleListPermissions(ctx, sender);
    
    // Capabilities discovery
    case 'agent.capabilities':
      return handleAgentCapabilities(ctx, sender);

    // Tool methods
    case 'agent.tools.list':
      return handleToolsList(ctx, sender);
    case 'agent.tools.call':
      return handleToolsCall(ctx, sender);

    // AI/Session methods
    case 'ai.canCreateTextSession':
      return handleCanCreateTextSession(ctx, sender);
    case 'ai.createTextSession':
    case 'ai.languageModel.create':
      return handleCreateTextSession(ctx, sender);
    case 'ai.languageModel.capabilities':
      return handleLanguageModelCapabilities(ctx, sender);
    case 'session.prompt':
      return handleSessionPrompt(ctx, sender);
    case 'session.destroy':
      return handleSessionDestroy(ctx, sender);

    // Provider methods
    case 'ai.providers.list':
      return handleProviderslist(ctx, sender);

    // Agent run (streaming)
    case 'agent.run':
      return handleAgentRun(ctx, sender);

    // Streaming methods not yet implemented
    case 'session.promptStreaming':
      return handleStreamingNotImplemented(ctx, sender);

    // Chat API
    case 'agent.chat.canOpen':
      return handleChatCanOpen(ctx, sender);
    case 'agent.chat.open':
      return handleChatOpen(ctx, sender);
    case 'agent.chat.close':
      return handleChatClose(ctx, sender);

    // Runtime capabilities
    case 'ai.runtime.getCapabilities':
      return handleRuntimeGetCapabilities(ctx, sender);

    // Browser API (same-tab only)
    case 'agent.browser.activeTab.readability':
      return handleActiveTabReadability(ctx, sender);
    case 'agent.browser.activeTab.click':
      return handleActiveTabClick(ctx, sender);
    case 'agent.browser.activeTab.fill':
      return handleActiveTabFill(ctx, sender);
    case 'agent.browser.activeTab.select':
      return handleActiveTabSelect(ctx, sender);
    case 'agent.browser.activeTab.scroll':
      return handleActiveTabScroll(ctx, sender);
    case 'agent.browser.activeTab.getElement':
      return handleActiveTabGetElement(ctx, sender);
    case 'agent.browser.activeTab.waitForSelector':
      return handleActiveTabWaitForSelector(ctx, sender);
    case 'agent.browser.activeTab.screenshot':
      return handleActiveTabScreenshot(ctx, sender);

    // Extension 2: Navigation
    case 'agent.browser.navigate':
      return handleBrowserNavigate(ctx, sender);
    case 'agent.browser.waitForNavigation':
      return handleBrowserWaitForNavigation(ctx, sender);

    // Extension 2: Tabs
    case 'agent.browser.tabs.list':
      return handleTabsList(ctx, sender);
    case 'agent.browser.tabs.get':
      return handleTabsGet(ctx, sender);
    case 'agent.browser.tabs.create':
      return handleTabsCreate(ctx, sender);
    case 'agent.browser.tabs.close':
      return handleTabsClose(ctx, sender);

    // Extension 2: Spawned tab operations
    case 'agent.browser.tab.readability':
      return handleSpawnedTabReadability(ctx, sender);
    case 'agent.browser.tab.click':
      return handleSpawnedTabClick(ctx, sender);
    case 'agent.browser.tab.fill':
      return handleSpawnedTabFill(ctx, sender);
    case 'agent.browser.tab.scroll':
      return handleSpawnedTabScroll(ctx, sender);
    case 'agent.browser.tab.screenshot':
      return handleSpawnedTabScreenshot(ctx, sender);
    case 'agent.browser.tab.navigate':
      return handleSpawnedTabNavigate(ctx, sender);
    case 'agent.browser.tab.waitForNavigation':
      return handleSpawnedTabWaitForNavigation(ctx, sender);

    // Extension 2: Web Fetch
    case 'agent.fetch':
      return handleAgentFetch(ctx, sender);

    // Extension 3: Multi-Agent
    case 'agents.register':
      return handleAgentsRegister(ctx, sender);
    case 'agents.unregister':
      return handleAgentsUnregister(ctx, sender);
    case 'agents.getInfo':
      return handleAgentsGetInfo(ctx, sender);
    case 'agents.discover':
      return handleAgentsDiscover(ctx, sender);
    case 'agents.list':
      return handleAgentsList(ctx, sender);
    case 'agents.invoke':
      return handleAgentsInvoke(ctx, sender);
    case 'agents.send':
      return handleAgentsSend(ctx, sender);
    case 'agents.subscribe':
      return handleAgentsSubscribe(ctx, sender);
    case 'agents.unsubscribe':
      return handleAgentsUnsubscribe(ctx, sender);
    case 'agents.registerMessageHandler':
      return handleAgentsRegisterMessageHandler(ctx, sender);
    case 'agents.unregisterMessageHandler':
      return handleAgentsUnregisterMessageHandler(ctx, sender);
    case 'agents.registerInvocationHandler':
      return handleAgentsRegisterInvocationHandler(ctx, sender);
    case 'agents.unregisterInvocationHandler':
      return handleAgentsUnregisterInvocationHandler(ctx, sender);
    case 'agents.orchestrate.pipeline':
      return handleOrchestratePipeline(ctx, sender);
    case 'agents.orchestrate.parallel':
      return handleOrchestrateParallel(ctx, sender);
    case 'agents.orchestrate.route':
      return handleOrchestrateRoute(ctx, sender);
    case 'agents.orchestrate.supervisor':
      return handleOrchestrateSupervisor(ctx, sender);

    // Extension 3: Remote A2A
    case 'agents.remote.connect':
      return handleRemoteConnect(ctx, sender);
    case 'agents.remote.disconnect':
      return handleRemoteDisconnect(ctx, sender);
    case 'agents.remote.list':
      return handleRemoteList(ctx, sender);
    case 'agents.remote.ping':
      return handleRemotePing(ctx, sender);
    case 'agents.remote.discover':
      return handleRemoteDiscover(ctx, sender);

    // Regular methods not yet implemented
    case 'session.clone':
    case 'ai.providers.getActive':
    case 'ai.providers.add':
    case 'ai.providers.remove':
    case 'ai.providers.setDefault':
    case 'ai.providers.setTypeDefault':
    case 'ai.runtime.getBest':
    case 'agent.mcp.discover':
    case 'agent.mcp.register':
    case 'agent.mcp.unregister':
    case 'agent.addressBar.canProvide':
    case 'agent.addressBar.registerProvider':
    case 'agent.addressBar.registerToolShortcuts':
    case 'agent.addressBar.registerSiteProvider':
    case 'agent.addressBar.discover':
    case 'agent.addressBar.listProviders':
    case 'agent.addressBar.unregisterProvider':
    case 'agent.addressBar.setDefaultProvider':
    case 'agent.addressBar.getDefaultProvider':
    case 'agent.addressBar.query':
    case 'agent.addressBar.select':
      return handleNotImplemented(ctx, sender);

    default:
      sender.sendResponse({
        id: ctx.id,
        ok: false,
        error: {
          code: 'ERR_NOT_IMPLEMENTED',
          message: `Unknown method: ${ctx.type}`,
        },
      });
  }
}

// =============================================================================
// Port Connection Handler
// =============================================================================

function handlePortConnection(port: ReturnType<typeof browserAPI.runtime.connect>): void {
  if (port.name !== 'web-agent-transport') {
    return;
  }

  log('New web-agent-transport connection from tab:', port.sender?.tab?.id);

  const tabId = port.sender?.tab?.id;

  port.onMessage.addListener(async (message: {
    id: string;
    type: string;
    payload?: unknown;
    origin?: string;
  }) => {
    // Handle abort
    if (message.type === 'abort') {
      log('Abort signal received for:', message.id);
      // TODO: Implement abort handling for streaming requests
      return;
    }

    const ctx: RequestContext = {
      id: message.id,
      type: message.type as MessageType,
      payload: message.payload,
      origin: message.origin || 'unknown',
      tabId,
    };

    const sender: ResponseSender = {
      sendResponse: (response) => {
        try {
          port.postMessage(response);
        } catch (error) {
          log('Failed to send response:', error);
        }
      },
      sendStreamEvent: (event) => {
        try {
          port.postMessage(event);
        } catch (error) {
          log('Failed to send stream event:', error);
        }
      },
    };

    try {
      await routeMessage(ctx, sender);
    } catch (error) {
      log('Error routing message:', error);
      sender.sendResponse({
        id: ctx.id,
        ok: false,
        error: {
          code: 'ERR_INTERNAL',
          message: error instanceof Error ? error.message : 'Internal error',
        },
      });
    }
  });

  port.onDisconnect.addListener(() => {
    log('web-agent-transport disconnected from tab:', tabId);
  });
}

// =============================================================================
// Permission Prompt Response Handler
// =============================================================================

function handlePermissionPromptMessage(
  message: {
    type?: string;
    response?: {
      granted: boolean;
      grantType?: 'granted-once' | 'granted-always';
      allowedTools?: string[];
    };
  },
  _sender: { id?: string; url?: string; tab?: { id?: number } },
  sendResponse: (response?: unknown) => void,
): boolean {
  if (message?.type !== 'permission_prompt_response') {
    return false;
  }

  log('Permission prompt response:', message.response);

  if (message.response) {
    handlePermissionPromptResponse(message.response);
  }

  // Close the prompt window
  sendResponse({ ok: true });
  return true;
}

// =============================================================================
// Initialize Router
// =============================================================================

export function initializeRouter(): void {
  log('Initializing router...');

  // Initialize tab manager for Extension 2
  initializeTabManager();

  // Initialize agent registry for Extension 3
  initializeAgentRegistry();

  // Listen for port connections from content scripts
  browserAPI.runtime.onConnect.addListener(handlePortConnection);

  // Listen for permission prompt responses
  browserAPI.runtime.onMessage.addListener(handlePermissionPromptMessage);

  log('Router initialized');
}
