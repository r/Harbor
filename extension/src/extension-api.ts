/**
 * Harbor Extension API
 * 
 * This module handles external messages from other extensions.
 * It provides a typed API for LLM, MCP, and system operations.
 * 
 * Only the Web Agents API extension may call it (see known-extensions.ts):
 *   chrome.runtime.sendMessage(HARBOR_EXTENSION_ID, { type: '...', payload: {...} })
 */

import { bridgeChat, type BridgeChatRequest } from './llm/chat';
import { browserAPI } from './browser-compat';
import { bridgeRequest, bridgeStreamRequest, getBridgeConnectionState, checkBridgeHealth } from './llm/bridge-client';
import { listServersWithStatus, callTool, startServer, stopServer, listTools } from './mcp/host';
import { isNativeBridgeReady } from './llm/native-bridge';
import { listAllProviders, getRuntimeCapabilities } from './llm/provider-registry';
import { SessionRegistry } from './sessions';
import type { CreateSessionOptions, SessionSummary } from './sessions';
import { routeExternalMessage } from './agents/background-router';
import { Audit } from './policy/audit';
import { simulate, replay } from './policy/simulator';
import { Watchdog } from './policy/watchdog';
import { isTrustedExtensionSender } from './known-extensions';
import { requireAction } from './agents/handlers/helpers';
import type { RequestContext, ResponseSender } from './agents/handlers/router-types';
import { promptActionForModel, type TypedAction } from './policy/actions';
import type { PolicyResource } from './policy/engine';
import { getPermissionStatus, requestPermissions, SCOPE_DESCRIPTIONS } from './policy/permissions';
import type { PermissionScope } from './agents/types';

// =============================================================================
// Types
// =============================================================================

export interface ExtensionApiRequest {
  type: string;
  payload?: unknown;
  requestId?: string; // For correlating streaming responses
}

export interface ExtensionApiResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface StreamChunk {
  type: 'stream';
  requestId: string;
  event: {
    type: 'token' | 'done' | 'error';
    token?: string;
    finish_reason?: string;
    model?: string;
    error?: { code: number; message: string };
  };
}

// Message types for the extension API
type MessageType =
  // LLM Operations
  | 'llm.chat'
  | 'llm.chatStream'
  | 'llm.listProviders'
  | 'llm.getActiveProvider'
  | 'llm.configureProvider'
  | 'llm.listModels'
  | 'llm.listConfiguredModels'
  | 'llm.getConfiguredModelsMetadata'
  // MCP Operations
  | 'mcp.listServers'
  | 'mcp.listTools'
  | 'mcp.callTool'
  | 'mcp.startServer'
  | 'mcp.stopServer'
  // Session Operations
  | 'session.create'
  | 'session.createImplicit'
  | 'session.get'
  | 'session.list'
  | 'session.terminate'
  | 'session.upgrade'
  | 'session.recordUsage'
  // Policy / audit
  | 'audit.query'
  | 'audit.summarize'
  | 'audit.clear'
  | 'policy.simulate'
  | 'policy.replay'
  | 'watchdog.snapshot'
  | 'watchdog.resetOrigin'
  // System
  | 'system.health'
  | 'system.getCapabilities'
  | 'system.getVersion'
  // Permissions (Harbor holds the only store)
  | 'permissions.check'
  | 'permissions.request';

// =============================================================================
// Helpers
// =============================================================================

function log(...args: unknown[]): void {
  console.log('[Harbor ExtAPI]', ...args);
}

function error(...args: unknown[]): void {
  console.error('[Harbor ExtAPI]', ...args);
}

function success(result?: unknown): ExtensionApiResponse {
  return { ok: true, result };
}

function failure(err: unknown): ExtensionApiResponse {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: message };
}

// =============================================================================
// Handlers
// =============================================================================

async function handleLlmChat(payload: unknown): Promise<ExtensionApiResponse> {
  const { messages, model, max_tokens, temperature, system, tools } = payload as {
    messages?: Array<{ role: string; content: string }>;
    model?: string;
    max_tokens?: number;
    temperature?: number;
    system?: string;
    tools?: Array<{ name: string; description: string; input_schema: unknown }>;
  };

  if (!messages || messages.length === 0) {
    return failure('Missing messages');
  }

  try {
    // Build request with optional tools
    const request: BridgeChatRequest = { messages, model, max_tokens, temperature, system_prompt: system };
    if (tools && tools.length > 0) {
      request.tools = tools;
      log('LLM chat with tools:', tools.map(t => t.name));
    }

    const result = await bridgeChat(request);

    log('LLM chat result:', JSON.stringify(result).substring(0, 500));

    return success({ content: result.content, model: result.model, choices: result.choices });
  } catch (e) {
    return failure(e);
  }
}

async function handleLlmListProviders(): Promise<ExtensionApiResponse> {
  try {
    const result = await bridgeRequest<{ providers: unknown[]; default_provider?: string }>('llm.list_providers');
    return success({ providers: result.providers, default_provider: result.default_provider });
  } catch (e) {
    return failure(e);
  }
}

async function handleLlmGetActiveProvider(): Promise<ExtensionApiResponse> {
  try {
    const result = await bridgeRequest<{ default_model?: string; providers: Record<string, unknown> }>('llm.get_config');
    return success({ default_model: result.default_model, providers: result.providers });
  } catch (e) {
    return failure(e);
  }
}

async function handleLlmConfigureProvider(payload: unknown): Promise<ExtensionApiResponse> {
  const { id, provider, name, api_key, base_url, enabled } = payload as {
    id?: string;
    provider?: string;
    name?: string;
    api_key?: string;
    base_url?: string;
    enabled?: boolean;
  };

  if (!provider && !id) {
    return failure('Missing provider or id');
  }

  try {
    const result = await bridgeRequest<{ ok: boolean; id: string }>('llm.configure_provider', {
      id, provider, name, api_key, base_url, enabled,
    });
    return success({ id: result.id });
  } catch (e) {
    return failure(e);
  }
}

async function handleLlmListModels(): Promise<ExtensionApiResponse> {
  try {
    const result = await bridgeRequest<{ models: unknown[] }>('llm.list_models');
    return success({ models: result.models });
  } catch (e) {
    return failure(e);
  }
}

async function handleLlmListConfiguredModels(): Promise<ExtensionApiResponse> {
  try {
    const result = await bridgeRequest<{ models: unknown[] }>('llm.list_configured_models');
    return success({ models: result.models });
  } catch (e) {
    return failure(e);
  }
}

async function handleLlmGetConfiguredModelsMetadata(): Promise<ExtensionApiResponse> {
  try {
    const result = await bridgeRequest<{ metadata: Array<{ model_id: string; is_local: boolean }> }>(
      'llm.get_configured_models_metadata'
    );
    return success({ metadata: result.metadata });
  } catch (e) {
    return failure(e);
  }
}

async function handleMcpListServers(): Promise<ExtensionApiResponse> {
  try {
    const servers = await listServersWithStatus();
    return success({ servers });
  } catch (e) {
    return failure(e);
  }
}

async function handleMcpListTools(payload: unknown): Promise<ExtensionApiResponse> {
  const { serverId } = (payload || {}) as { serverId?: string };

  try {
    if (serverId) {
      // List tools from specific server
      const tools = await listTools(serverId);
      return success({ tools });
    } else {
      // List tools from all running servers
      const servers = await listServersWithStatus();
      const allTools: Array<{ serverId: string; name: string; description?: string; inputSchema?: unknown }> = [];
      
      for (const server of servers) {
        if (server.running && server.tools) {
          for (const tool of server.tools) {
            allTools.push({
              serverId: server.id,
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            });
          }
        }
      }
      
      return success({ tools: allTools });
    }
  } catch (e) {
    return failure(e);
  }
}

async function handleMcpCallTool(payload: unknown): Promise<ExtensionApiResponse> {
  const { serverId, toolName, args } = payload as {
    serverId?: string;
    toolName?: string;
    args?: Record<string, unknown>;
  };

  if (!serverId || !toolName) {
    return failure('Missing serverId or toolName');
  }

  try {
    const result = await callTool(serverId, toolName, args || {});
    if (!result.ok) {
      return failure(result.error || 'Tool call failed');
    }
    return success({ result: result.result });
  } catch (e) {
    return failure(e);
  }
}

async function handleMcpStartServer(payload: unknown): Promise<ExtensionApiResponse> {
  const { serverId } = payload as { serverId?: string };

  if (!serverId) {
    return failure('Missing serverId');
  }

  try {
    const started = await startServer(serverId);
    return success({ started });
  } catch (e) {
    return failure(e);
  }
}

async function handleMcpStopServer(payload: unknown): Promise<ExtensionApiResponse> {
  const { serverId } = payload as { serverId?: string };

  if (!serverId) {
    return failure('Missing serverId');
  }

  try {
    const stopped = stopServer(serverId);
    return success({ stopped });
  } catch (e) {
    return failure(e);
  }
}

async function handleSystemHealth(): Promise<ExtensionApiResponse> {
  try {
    const bridgeState = getBridgeConnectionState();
    const bridgeHealthy = await checkBridgeHealth();
    
    return success({
      healthy: bridgeHealthy,
      bridge: {
        connected: bridgeState.connected,
        ready: bridgeState.bridgeReady,
        error: bridgeState.error,
      },
    });
  } catch (e) {
    return failure(e);
  }
}

async function handleSystemGetCapabilities(): Promise<ExtensionApiResponse> {
  try {
    const capabilities = await getRuntimeCapabilities();
    const bridgeReady = isNativeBridgeReady();
    
    return success({
      bridgeReady,
      capabilities,
      features: {
        llm: bridgeReady,
        mcp: true,
        oauth: bridgeReady,
        streaming: bridgeReady,
      },
    });
  } catch (e) {
    return failure(e);
  }
}

function handleSystemGetVersion(): ExtensionApiResponse {
  return success({
    version: '0.1.0',
    extensionId: browserAPI.runtime.id,
  });
}

// =============================================================================
// Permission Handlers
// =============================================================================

/**
 * Harbor holds the only store of per-origin grants and the only consent
 * prompt. The Web Agents API asks here for every check and request instead
 * of keeping a copy, so a grant revoked in Harbor stops the next page call.
 */
const KNOWN_SCOPES = new Set<string>(Object.keys(SCOPE_DESCRIPTIONS));

function readPermissionOrigin(p: Record<string, unknown>): string | null {
  return typeof p.origin === 'string' && p.origin ? p.origin : null;
}

function readTabId(p: Record<string, unknown>): number | undefined {
  return typeof p.tabId === 'number' ? p.tabId : undefined;
}

async function handlePermissionsCheck(payload: unknown): Promise<ExtensionApiResponse> {
  const p = (payload || {}) as Record<string, unknown>;
  const origin = readPermissionOrigin(p);
  if (!origin) {
    return failure('permissions.check requires the calling page\'s origin');
  }
  try {
    const status = await getPermissionStatus(origin, readTabId(p));
    return success({ ...status, allowedTools: status.allowedTools ?? [] });
  } catch (e) {
    return failure(e);
  }
}

async function handlePermissionsRequest(payload: unknown): Promise<ExtensionApiResponse> {
  const p = (payload || {}) as Record<string, unknown>;
  const origin = readPermissionOrigin(p);
  if (!origin) {
    return failure('permissions.request requires the calling page\'s origin');
  }
  const { scopes, reason, tools } = p;
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every(s => typeof s === 'string' && KNOWN_SCOPES.has(s))) {
    return failure('permissions.request requires a non-empty list of known scopes');
  }
  if (reason !== undefined && typeof reason !== 'string') {
    return failure('permissions.request: reason must be a string');
  }
  if (tools !== undefined && (!Array.isArray(tools) || !tools.every(t => typeof t === 'string'))) {
    return failure('permissions.request: tools must be a list of tool names');
  }
  try {
    const result = await requestPermissions(
      origin,
      {
        scopes: scopes as PermissionScope[],
        reason: reason as string | undefined,
        tools: tools as string[] | undefined,
      },
      readTabId(p),
    );
    return success({ ...result, allowedTools: result.allowedTools ?? [] });
  } catch (e) {
    return failure(e);
  }
}

// =============================================================================
// Session Handlers
// =============================================================================

/**
 * Create an explicit session with specified capabilities.
 */
async function handleSessionCreate(payload: unknown): Promise<ExtensionApiResponse> {
  const { origin, tabId, options, allowedTools } = payload as {
    origin?: string;
    tabId?: number;
    options?: CreateSessionOptions;
    /** Tools the origin was granted, as recorded by the Web Agents API. */
    allowedTools?: string[];
  };

  if (!origin) {
    return failure('Missing origin');
  }

  if (!options) {
    return failure('Missing session options');
  }

  try {
    // The caller checks the origin's scopes and sends the tools it was
    // granted. The session gets only requested tools that are also granted;
    // with no grant, it gets no tools.
    const result = SessionRegistry.createExplicitSession(
      origin,
      options,
      Array.isArray(allowedTools) ? allowedTools : [],
      tabId,
    );
    
    if (result.success) {
      return success({
        sessionId: result.sessionId,
        capabilities: result.capabilities,
      });
    } else {
      return failure(result.error?.message || 'Session creation failed');
    }
  } catch (e) {
    return failure(e);
  }
}

/**
 * Create an implicit session (from ai.createTextSession).
 */
async function handleSessionCreateImplicit(payload: unknown): Promise<ExtensionApiResponse> {
  const { origin, tabId, options } = payload as {
    origin?: string;
    tabId?: number;
    options?: { systemPrompt?: string; temperature?: number };
  };

  if (!origin) {
    return failure('Missing origin');
  }

  try {
    const session = SessionRegistry.createImplicitSession(origin, options || {}, tabId);
    return success({
      sessionId: session.sessionId,
      capabilities: session.capabilities,
    });
  } catch (e) {
    return failure(e);
  }
}

/**
 * Get a session by ID.
 */
async function handleSessionGet(payload: unknown): Promise<ExtensionApiResponse> {
  const { sessionId, origin } = payload as {
    sessionId?: string;
    origin?: string;
  };

  if (!sessionId) {
    return failure('Missing sessionId');
  }

  try {
    if (origin) {
      // Validate session belongs to origin
      const session = SessionRegistry.getValidatedSession(sessionId, origin);
      return success({ session: sessionToResponse(session) });
    } else {
      // Return session without origin validation (for internal use)
      const session = SessionRegistry.getSession(sessionId);
      if (!session) {
        return failure('Session not found');
      }
      return success({ session: sessionToResponse(session) });
    }
  } catch (e) {
    return failure(e);
  }
}

/**
 * List sessions with optional filters.
 */
async function handleSessionList(payload: unknown): Promise<ExtensionApiResponse> {
  const { origin, status, type, activeOnly } = (payload || {}) as {
    origin?: string;
    status?: 'active' | 'suspended' | 'terminated';
    type?: 'implicit' | 'explicit';
    activeOnly?: boolean;
  };

  try {
    const sessions = SessionRegistry.listSessions({ origin, status, type, activeOnly });
    return success({ sessions });
  } catch (e) {
    return failure(e);
  }
}

/**
 * Terminate a session.
 */
async function handleSessionTerminate(payload: unknown): Promise<ExtensionApiResponse> {
  const { sessionId, origin } = payload as {
    sessionId?: string;
    origin?: string;
  };

  if (!sessionId || !origin) {
    return failure('Missing sessionId or origin');
  }

  try {
    const terminated = SessionRegistry.terminateSession(sessionId, origin);
    return success({ terminated });
  } catch (e) {
    return failure(e);
  }
}

/**
 * Change the mode of an existing session. Re-mints the capability token
 * with the new mode. Cannot widen — plan→execute requests fall back to
 * an `upgraded: false` response so the page can prompt the user to
 * recreate the session with the broader mode.
 */
async function handleSessionUpgrade(payload: unknown): Promise<ExtensionApiResponse> {
  const { sessionId, origin, mode } = payload as {
    sessionId?: string;
    origin?: string;
    mode?: 'plan' | 'execute' | 'watch';
  };

  if (!sessionId || !origin || !mode) {
    return failure('Missing sessionId, origin, or mode');
  }

  try {
    const upgraded = SessionRegistry.setMode(sessionId, origin, mode);
    return success({ upgraded });
  } catch (e) {
    return failure(e);
  }
}

/**
 * Record usage for a session (prompt, tool call, etc.).
 */
async function handleSessionRecordUsage(payload: unknown): Promise<ExtensionApiResponse> {
  const { sessionId, origin, type, detail } = payload as {
    sessionId?: string;
    origin?: string;
    type?: 'prompt' | 'tool' | 'browser';
    detail?: unknown;
  };

  if (!sessionId || !origin || !type) {
    return failure('Missing sessionId, origin or type');
  }

  try {
    // Only the owning origin may record against a live session.
    SessionRegistry.getValidatedSession(sessionId, origin);

    switch (type) {
      case 'prompt': {
        const { userMessage, assistantMessage } = detail as {
          userMessage?: string;
          assistantMessage?: string;
        };
        if (userMessage && assistantMessage) {
          SessionRegistry.recordPrompt(sessionId, userMessage, assistantMessage);
        }
        break;
      }
      case 'tool': {
        const { toolName } = detail as { toolName?: string };
        if (toolName) {
          const allowed = SessionRegistry.recordToolCall(sessionId, toolName);
          if (!allowed) {
            return failure('Tool call budget exceeded');
          }
        }
        break;
      }
      case 'browser': {
        const { action } = detail as { action?: 'read' | 'interact' | 'screenshot' };
        if (action) {
          SessionRegistry.recordBrowserAccess(sessionId, action);
        }
        break;
      }
    }
    
    // Touch the session to update lastActiveAt
    SessionRegistry.touchSession(sessionId);
    
    return success({ recorded: true });
  } catch (e) {
    return failure(e);
  }
}

/**
 * Convert internal session to external response format.
 */
function sessionToResponse(session: ReturnType<typeof SessionRegistry.getSession>): SessionSummary | null {
  if (!session) return null;
  
  return {
    sessionId: session.sessionId,
    type: session.type,
    origin: session.origin,
    status: session.status,
    name: session.name,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    capabilities: {
      hasLLM: session.capabilities.llm.allowed,
      toolCount: session.capabilities.tools.allowedTools.length,
      hasBrowserAccess:
        session.capabilities.browser.readActiveTab ||
        session.capabilities.browser.interact ||
        session.capabilities.browser.screenshot,
    },
    usage: session.usage,
  };
}

// =============================================================================
// Page-call gate
// =============================================================================

/**
 * Only the Web Agents API can reach this router (see `isTrustedExtensionSender`),
 * so the page-facing calls below are page calls it forwarded, carrying the
 * page's origin. Each goes through the PolicyEngine via `requireAction`:
 * the decision is audited, and `deny` (safety floor, rules, origin deny,
 * watchdog) is enforced. The Web Agents API has already asked the user with
 * its own grant store, so a grant-level ask or preview proceeds without a
 * second Harbor prompt and the audit records that consent. A watchdog
 * restriction or a policy rule that asks still prompts.
 */
interface PageCheck {
  action: TypedAction;
  resource?: PolicyResource;
}

type PagePayload = Record<string, unknown>;

const BROWSER_CAPABILITY_ACTIONS: Record<'read' | 'interact' | 'screenshot', TypedAction> = {
  read: 'browser.read.activeTab',
  interact: 'browser.write.interact',
  screenshot: 'browser.read.screenshot',
};

const PAGE_GATES: Partial<Record<MessageType, (payload: PagePayload) => PageCheck[]>> = {
  'llm.chat': (p) => [{ action: promptActionForModel(p.model) }],
  'llm.chatStream': (p) => [{ action: promptActionForModel(p.model) }],
  'mcp.listTools': () => [{ action: 'tool.list' }],
  'mcp.callTool': (p) => [
    {
      action: 'tool.call',
      resource: {
        server: typeof p.serverId === 'string' ? p.serverId : undefined,
        tool: typeof p.toolName === 'string' ? p.toolName : undefined,
      },
    },
  ],
  'session.create': (p) => {
    const options = (p.options || {}) as CreateSessionOptions;
    const checks: PageCheck[] = [];
    const caps = options.capabilities;
    if (caps?.llm) checks.push({ action: promptActionForModel(caps.llm.model) });
    if (caps?.tools?.length) checks.push({ action: 'tool.call' });
    for (const access of caps?.browser ?? []) {
      checks.push({ action: BROWSER_CAPABILITY_ACTIONS[access] });
    }
    return checks;
  },
};

/**
 * Returns `null` when the call may proceed, or the failure to send back.
 */
async function gatePageCall(
  type: MessageType,
  payload: unknown,
  requestId?: string,
): Promise<ExtensionApiResponse | null> {
  const checksFor = PAGE_GATES[type];
  if (!checksFor) return null;

  const p = (payload || {}) as PagePayload;
  if (typeof p.origin !== 'string' || !p.origin) {
    return failure(`${type} requires the calling page's origin`);
  }

  const ctx: RequestContext = {
    id: requestId ?? crypto.randomUUID(),
    type: type as RequestContext['type'],
    payload,
    origin: p.origin,
    tabId: typeof p.tabId === 'number' ? p.tabId : undefined,
  };
  let denied: ExtensionApiResponse | null = null;
  const sender: ResponseSender = {
    sendResponse: (response) => {
      const err = (response as { error?: { code?: string; message?: string } }).error;
      denied = failure(err?.message ?? 'Permission denied');
    },
    sendStreamEvent: () => {},
  };

  for (const check of checksFor(p)) {
    const allowed = await requireAction(ctx, sender, check.action, {
      resource: check.resource,
      upstreamConsent: 'web-agents-api',
    });
    if (!allowed) return denied ?? failure('Permission denied');
  }
  return null;
}

// =============================================================================
// Main Router
// =============================================================================

/**
 * Route an external API message to the appropriate handler.
 * Exported for use by Firefox compatibility handler in background.ts.
 */
export async function routeExtensionApiMessage(
  message: ExtensionApiRequest,
  sender: { id?: string; url?: string; tab?: { id?: number } },
): Promise<ExtensionApiResponse> {
  const { type, payload } = message;
  
  log(`Request from ${sender.id}: ${type}`);

  const gateFailure = await gatePageCall(type as MessageType, payload);
  if (gateFailure) return gateFailure;

  switch (type as MessageType) {
    // LLM Operations
    case 'llm.chat':
      return handleLlmChat(payload);
    case 'llm.listProviders':
      return handleLlmListProviders();
    case 'llm.getActiveProvider':
      return handleLlmGetActiveProvider();
    case 'llm.configureProvider':
      return handleLlmConfigureProvider(payload);
    case 'llm.listModels':
      return handleLlmListModels();
    case 'llm.listConfiguredModels':
      return handleLlmListConfiguredModels();
    case 'llm.getConfiguredModelsMetadata':
      return handleLlmGetConfiguredModelsMetadata();

    // MCP Operations
    case 'mcp.listServers':
      return handleMcpListServers();
    case 'mcp.listTools':
      return handleMcpListTools(payload);
    case 'mcp.callTool':
      return handleMcpCallTool(payload);
    case 'mcp.startServer':
      return handleMcpStartServer(payload);
    case 'mcp.stopServer':
      return handleMcpStopServer(payload);

    // Session Operations
    case 'session.create':
      return handleSessionCreate(payload);
    case 'session.createImplicit':
      return handleSessionCreateImplicit(payload);
    case 'session.get':
      return handleSessionGet(payload);
    case 'session.list':
      return handleSessionList(payload);
    case 'session.terminate':
      return handleSessionTerminate(payload);
    case 'session.upgrade':
      return handleSessionUpgrade(payload);
    case 'session.recordUsage':
      return handleSessionRecordUsage(payload);

    // Policy / audit
    case 'audit.query':
      return handleAuditQuery(payload);
    case 'audit.summarize':
      return handleAuditSummarize(payload);
    case 'audit.clear':
      return handleAuditClear();
    case 'policy.simulate':
      return handlePolicySimulate(payload);
    case 'policy.replay':
      return handlePolicyReplay(payload);
    case 'watchdog.snapshot':
      return handleWatchdogSnapshot(payload);
    case 'watchdog.resetOrigin':
      return handleWatchdogResetOrigin(payload);

    // Permissions (Harbor holds the only store)
    case 'permissions.check':
      return handlePermissionsCheck(payload);
    case 'permissions.request':
      return handlePermissionsRequest(payload);

    // System
    case 'system.health':
      return handleSystemHealth();
    case 'system.getCapabilities':
      return handleSystemGetCapabilities();
    case 'system.getVersion':
      return handleSystemGetVersion();

    default:
      return failure(`Unknown message type: ${type}`);
  }
}

// =============================================================================
// Policy / audit handlers
// =============================================================================

/**
 * Read recent audit records. Filters mirror Audit.query's signature so a
 * sidebar caller can ask for "everything from this origin in the last
 * minute" or "every label-egress denial."
 */
async function handleAuditQuery(payload: unknown): Promise<ExtensionApiResponse> {
  const filters = (payload || {}) as {
    origin?: string;
    sinceMs?: number;
    until?: number;
    label?: string;
    limit?: number;
  };
  try {
    const records = Audit.query({
      origin: filters.origin,
      sinceMs: filters.sinceMs,
      until: filters.until,
      label: filters.label,
      limit: filters.limit,
    });
    return success({ records });
  } catch (e) {
    return failure(e);
  }
}

async function handleAuditSummarize(payload: unknown): Promise<ExtensionApiResponse> {
  const { sinceMs } = (payload || {}) as { sinceMs?: number };
  try {
    return success(Audit.summarize({ sinceMs }));
  } catch (e) {
    return failure(e);
  }
}

async function handleAuditClear(): Promise<ExtensionApiResponse> {
  try {
    Audit.clear();
    return success({ cleared: true });
  } catch (e) {
    return failure(e);
  }
}

/**
 * Run a hypothetical request through the engine without side effects.
 * The sidebar's "What if?" affordance uses this to preview what would
 * happen if the user changed a rule or turned off a feature flag.
 */
async function handlePolicySimulate(payload: unknown): Promise<ExtensionApiResponse> {
  const input = (payload || {}) as Parameters<typeof simulate>[0];
  try {
    const result = await simulate(input);
    return success(result);
  } catch (e) {
    return failure(e);
  }
}

/**
 * Replay an audit record under modified context. Powers the "Why?"
 * deep-link in the activity feed.
 */
async function handlePolicyReplay(payload: unknown): Promise<ExtensionApiResponse> {
  const { recordId, modifications } = (payload || {}) as {
    recordId?: string;
    modifications?: Parameters<typeof replay>[1];
  };
  if (!recordId) return failure('Missing recordId');
  try {
    const result = await replay(recordId, modifications);
    return success(result);
  } catch (e) {
    return failure(e);
  }
}

async function handleWatchdogSnapshot(payload: unknown): Promise<ExtensionApiResponse> {
  const { origin } = (payload || {}) as { origin?: string };
  try {
    if (origin) {
      return success(Watchdog.inspect(origin));
    }
    // No origin: fall back to a per-origin tally summary from the audit log.
    const summary = Audit.summarize();
    return success({
      thresholds: Watchdog.getThresholds(),
      origins: Object.entries(summary.byOrigin).map(([o, count]) => ({
        origin: o,
        decisions: count,
        watchdog: Watchdog.inspect(o),
      })),
    });
  } catch (e) {
    return failure(e);
  }
}

async function handleWatchdogResetOrigin(payload: unknown): Promise<ExtensionApiResponse> {
  const { origin } = (payload || {}) as { origin?: string };
  if (!origin) return failure('Missing origin');
  try {
    Watchdog.reset(origin);
    return success({ reset: true });
  } catch (e) {
    return failure(e);
  }
}

// =============================================================================
// Streaming Handler (for llm.chatStream)
// =============================================================================

/** Looser than `StreamChunk['event']`: callers here only ever read `.message`. */
export type ChatStreamEvent = {
  type: 'token' | 'done' | 'error';
  token?: string;
  finish_reason?: string;
  model?: string;
  error?: { code?: number; message: string };
};

/**
 * The gated `llm.chatStream` generator, shared by every caller that needs a
 * live stream of chat events: the cross-extension port handler below (while
 * the Web Agents API extension may still be installed) and page-api's
 * `harbor-core.ts`, which calls this in-process. Runs `gatePageCall` exactly
 * as a forwarded call does, so the policy gate and audit log see the same
 * decision either way.
 */
export async function* streamLlmChat(payload: unknown, requestId?: string): AsyncGenerator<ChatStreamEvent> {
  const { messages, model, max_tokens, temperature, system, tools } = (payload || {}) as {
    messages?: Array<{ role: string; content: string }>;
    model?: string;
    max_tokens?: number;
    temperature?: number;
    system?: string;
    tools?: BridgeChatRequest['tools'];
  };

  if (!messages || messages.length === 0) {
    yield { type: 'error', error: { message: 'Missing messages' } };
    return;
  }

  // Fail closed, so a gate error can't leave the page's stream waiting forever.
  const gateFailure = await gatePageCall('llm.chatStream', payload, requestId).catch((e: unknown) => failure(e));
  if (gateFailure) {
    yield { type: 'error', error: { message: gateFailure.error ?? 'Permission denied' } };
    return;
  }

  try {
    let tokenCount = 0;
    for await (const event of bridgeStreamRequest('llm.chat_stream', { messages, model, max_tokens, temperature, system_prompt: system, tools })) {
      if (event.type === 'token') tokenCount++;
      yield event;
      if (event.type === 'done' || event.type === 'error') {
        log('streamLlmChat: stream ended', { eventType: event.type, tokenCount, error: (event as { error?: { message: string } }).error });
        break;
      }
    }
  } catch (e) {
    yield { type: 'error', error: { message: e instanceof Error ? e.message : String(e) } };
  }
}

async function handleStreamingChat(
  message: ExtensionApiRequest,
  sender: { id?: string; url?: string; tab?: { id?: number } },
  port: ReturnType<typeof browserAPI.runtime.connect>,
): Promise<void> {
  log('handleStreamingChat called', {
    senderId: sender.id,
    requestId: message.requestId,
    payloadKeys: message.payload ? Object.keys(message.payload as Record<string, unknown>) : [],
  });

  const { payload, requestId } = message;

  if (!requestId) {
    log('handleStreamingChat: No requestId provided');
    port.postMessage({ type: 'stream', requestId: '', event: { type: 'error', error: { message: 'Missing requestId for streaming' } } });
    return;
  }

  for await (const event of streamLlmChat(payload, requestId)) {
    port.postMessage({ type: 'stream', requestId, event } as StreamChunk);
    if (event.type === 'done' || event.type === 'error') break;
  }
}

// =============================================================================
// Initialization
// =============================================================================

export function initializeExtensionApi(): void {
  log('Initializing extension API...');

  // Subscribe to session events and broadcast to sidebar
  SessionRegistry.subscribe((event) => {
    log('Session event:', event.type);
    // Broadcast to all extension pages (sidebar, etc.)
    browserAPI.runtime.sendMessage({
      type: event.type,
      ...(event.type === 'session_created' ? { session: event.session } : {}),
      ...(event.type === 'session_updated' ? { session: event.session } : {}),
      ...(event.type === 'session_terminated' ? { sessionId: event.sessionId, origin: event.origin } : {}),
    }).catch(() => {
      // Ignore errors - sidebar may not be open
    });
  });

  // Handle ALL one-shot messages from other extensions
  // This is the single entry point for cross-extension communication
  // Routes to appropriate handler based on message type prefix
  browserAPI.runtime.onMessageExternal.addListener(
    (message: ExtensionApiRequest, sender, sendResponse) => {
      // Only the Web Agents API may call Harbor. Check before reading the message.
      if (!isTrustedExtensionSender(sender)) {
        log('Rejected external message from untrusted sender:', sender?.id);
        sendResponse(failure('Unauthorized sender'));
        return false;
      }

      if (!message?.type) {
        sendResponse(failure('Invalid message: missing type'));
        return true;
      }
      
      const msgType = message.type as string;
      log('External message:', msgType, 'from', sender.id);
      
      // Route based on message type prefix:
      // - llm.*, mcp.*, session.*, system.*, permissions.* -> this module (extension API)
      // - agent.*, agents.* -> agent router
      const isExtensionApiMessage = msgType.startsWith('llm.') ||
                                     msgType.startsWith('mcp.') ||
                                     msgType.startsWith('session.') ||
                                     msgType.startsWith('system.') ||
                                     msgType.startsWith('permissions.');
      
      if (isExtensionApiMessage) {
        // Streaming requests need a port connection, not sendMessage
        if (message.type === 'llm.chatStream') {
          sendResponse(failure('Use browser.runtime.connect for streaming requests'));
          return true;
        }

        // Route the message and send response
        routeExtensionApiMessage(message, sender)
          .then(sendResponse)
          .catch((e) => sendResponse(failure(e)));
      } else {
        // Route to agent router for agent.* and agents.* messages
        routeExternalMessage(
          message as { type: string; payload?: unknown; requestId?: string },
          sender,
          sendResponse
        );
      }

      return true; // Keep channel open for async response
    }
  );

  // Handle port connections for streaming
  browserAPI.runtime.onConnectExternal.addListener((port) => {
    if (!isTrustedExtensionSender(port.sender)) {
      log('Rejected external port from untrusted sender:', port.sender?.id);
      port.disconnect();
      return;
    }
    log('External port connection from:', port.sender?.id, 'port name:', port.name);

    port.onMessage.addListener((message: ExtensionApiRequest) => {
      log('Port message received:', message.type, 'requestId:', message.requestId);
      
      if (message.type === 'llm.chatStream') {
        handleStreamingChat(message, port.sender!, port);
      } else {
        log('Non-streaming port message:', message.type);
        // Non-streaming requests via port
        routeExtensionApiMessage(message, port.sender!)
          .then((response) => port.postMessage({ type: 'response', ...response }))
          .catch((e) => port.postMessage({ type: 'response', ok: false, error: String(e) }));
      }
    });
    
    port.onDisconnect.addListener(() => {
      log('External port disconnected:', port.sender?.id);
    });
  });

  log('Extension API initialized');
}
