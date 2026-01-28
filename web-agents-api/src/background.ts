/**
 * Web Agents API - Background Script
 *
 * Routes messages from content scripts to Harbor extension.
 * Handles permissions and session management.
 */

import {
  harborRequest,
  harborStreamRequest,
  discoverHarbor,
  setHarborExtensionId,
  getHarborState,
  type StreamEvent,
} from './harbor-client';
import { getFeatureFlags, type FeatureFlags } from './policy/feature-flags';
import type {
  TransportResponse,
  TransportStreamEvent,
  PermissionScope,
  PermissionGrantType,
  StreamToken,
  CreateSessionOptions,
  SessionSummary,
} from './types';

console.log('[Web Agents API] Extension starting...');

// =============================================================================
// Browser Compatibility Layer
// =============================================================================

// Firefox uses `browser.*` APIs, Chrome uses `chrome.*`
// This provides a unified interface for script execution
const browserAPI = (typeof browser !== 'undefined' ? browser : chrome) as typeof chrome;

/**
 * Execute a script in a tab, compatible with both Chrome and Firefox.
 */
async function executeScriptInTab<T>(
  tabId: number,
  func: (...args: unknown[]) => T,
  args: unknown[] = []
): Promise<T | undefined> {
  // Try chrome.scripting first (Chrome MV3, Firefox MV3 with scripting)
  if (chrome?.scripting?.executeScript) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: func as () => T,
      args,
    });
    return results?.[0]?.result as T | undefined;
  }
  
  // Try browser.scripting (Firefox MV3)
  if (typeof browser !== 'undefined' && browser?.scripting?.executeScript) {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: func as () => T,
      args,
    });
    return results?.[0]?.result as T | undefined;
  }

  // Fallback: browser.tabs.executeScript (Firefox MV2 style, but still works)
  if (typeof browser !== 'undefined' && browser?.tabs?.executeScript) {
    // For this fallback, we need to serialize the function
    const code = `(${func.toString()}).apply(null, ${JSON.stringify(args)})`;
    const results = await browser.tabs.executeScript(tabId, { code });
    return results?.[0] as T | undefined;
  }

  throw new Error('No script execution API available');
}

// =============================================================================
// State Management
// =============================================================================

// Permission storage key prefix
const PERMISSION_KEY_PREFIX = 'permissions:';

// Active text sessions (sessionId -> session info)
const textSessions = new Map<string, {
  sessionId: string;
  origin: string;
  options: Record<string, unknown>;
  history: Array<{ role: string; content: string }>;
  createdAt: number;
}>();

let sessionIdCounter = 0;

function generateSessionId(): string {
  return `session-${Date.now()}-${++sessionIdCounter}`;
}

// Track tabs spawned by each origin (origin -> Set<tabId>)
const spawnedTabs = new Map<string, Set<number>>();

function trackSpawnedTab(origin: string, tabId: number): void {
  if (!spawnedTabs.has(origin)) {
    spawnedTabs.set(origin, new Set());
  }
  spawnedTabs.get(origin)!.add(tabId);
}

function untrackSpawnedTab(origin: string, tabId: number): boolean {
  const tabs = spawnedTabs.get(origin);
  if (tabs) {
    return tabs.delete(tabId);
  }
  return false;
}

function isSpawnedTab(origin: string, tabId: number): boolean {
  return spawnedTabs.get(origin)?.has(tabId) ?? false;
}

// Clean up spawned tabs when they are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const tabs of spawnedTabs.values()) {
    tabs.delete(tabId);
  }
});

// =============================================================================
// Permission Management
// =============================================================================

interface StoredPermissions {
  scopes: Record<PermissionScope, { type: PermissionGrantType; expiresAt?: number; grantedAt: number }>;
  allowedTools?: string[];
}

interface PermissionStatusEntry {
  origin: string;
  scopes: Record<string, PermissionGrantType>;
  allowedTools?: string[];
}

async function getPermissions(origin: string): Promise<StoredPermissions> {
  const key = PERMISSION_KEY_PREFIX + origin;
  const result = await chrome.storage.local.get(key);
  return result[key] || { scopes: {} };
}

async function savePermissions(origin: string, permissions: StoredPermissions): Promise<void> {
  const key = PERMISSION_KEY_PREFIX + origin;
  await chrome.storage.local.set({ [key]: permissions });
}

async function listAllPermissions(): Promise<PermissionStatusEntry[]> {
  const result = await chrome.storage.local.get(null);
  const entries: PermissionStatusEntry[] = [];

  for (const [key, value] of Object.entries(result)) {
    if (!key.startsWith(PERMISSION_KEY_PREFIX)) continue;
    const origin = key.slice(PERMISSION_KEY_PREFIX.length);
    const permissions = (value || { scopes: {} }) as StoredPermissions;
    const scopes: Record<string, PermissionGrantType> = {};

    for (const [scope, grant] of Object.entries(permissions.scopes || {})) {
      if (grant.type === 'granted-once' && grant.expiresAt && Date.now() > grant.expiresAt) {
        scopes[scope] = 'not-granted';
      } else {
        scopes[scope] = grant.type;
      }
    }

    entries.push({
      origin,
      scopes,
      allowedTools: permissions.allowedTools,
    });
  }

  return entries;
}

async function revokeOriginPermissions(origin: string): Promise<void> {
  const key = PERMISSION_KEY_PREFIX + origin;
  await chrome.storage.local.remove(key);
}

async function checkPermission(origin: string, scope: PermissionScope): Promise<PermissionGrantType> {
  const permissions = await getPermissions(origin);
  const grant = permissions.scopes[scope];
  
  if (!grant) {
    return 'not-granted';
  }
  
  // Check expiration for granted-once
  if (grant.type === 'granted-once' && grant.expiresAt) {
    if (Date.now() > grant.expiresAt) {
      return 'not-granted';
    }
  }
  
  return grant.type;
}

async function hasPermission(origin: string, scope: PermissionScope): Promise<boolean> {
  const status = await checkPermission(origin, scope);
  return status === 'granted-once' || status === 'granted-always';
}

// =============================================================================
// Permission Prompt
// =============================================================================

interface PermissionPromptResponse {
  promptId: string;
  granted: boolean;
  grantType?: 'granted-once' | 'granted-always';
  allowedTools?: string[];
  explicitDeny?: boolean;
}

interface PendingPrompt {
  resolve: (response: PermissionPromptResponse) => void;
  windowId?: number;
}

const pendingPermissionPrompts = new Map<string, PendingPrompt>();
let promptIdCounter = 0;

function generatePromptId(): string {
  return `prompt-${Date.now()}-${++promptIdCounter}`;
}

function resolvePromptClosed(windowId: number): void {
  for (const [promptId, pending] of pendingPermissionPrompts.entries()) {
    if (pending.windowId === windowId) {
      pendingPermissionPrompts.delete(promptId);
      pending.resolve({ promptId, granted: false });
      return;
    }
  }
}

async function openPermissionPrompt(options: {
  origin: string;
  scopes: PermissionScope[];
  reason?: string;
  tools?: string[];
}): Promise<PermissionPromptResponse> {
  const promptId = generatePromptId();

  const url = new URL(chrome.runtime.getURL('dist/permission-prompt.html'));
  url.searchParams.set('promptId', promptId);
  url.searchParams.set('origin', options.origin);
  if (options.scopes.length > 0) {
    url.searchParams.set('scopes', options.scopes.join(','));
  }
  if (options.reason) {
    url.searchParams.set('reason', options.reason);
  }
  if (options.tools && options.tools.length > 0) {
    url.searchParams.set('tools', options.tools.join(','));
  }

  return new Promise((resolve) => {
    pendingPermissionPrompts.set(promptId, { resolve });

    chrome.windows.create(
      {
        url: url.toString(),
        type: 'popup',
        width: 480,
        height: 640,
      },
      (createdWindow) => {
        if (chrome.runtime.lastError || !createdWindow?.id) {
          pendingPermissionPrompts.delete(promptId);
          resolve({ promptId, granted: false });
          return;
        }

        const pending = pendingPermissionPrompts.get(promptId);
        if (pending) {
          pending.windowId = createdWindow.id;
        }
      },
    );
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'permission_prompt_response') {
    return false;
  }

  const response = message.response as PermissionPromptResponse | undefined;
  if (!response) {
    sendResponse({ ok: false });
    return true;
  }

  let promptId = response.promptId;
  if (!promptId && pendingPermissionPrompts.size === 1) {
    promptId = Array.from(pendingPermissionPrompts.keys())[0];
  }

  const pending = promptId ? pendingPermissionPrompts.get(promptId) : undefined;
  if (!pending) {
    sendResponse({ ok: false });
    return true;
  }

  pendingPermissionPrompts.delete(promptId);
  if (pending.windowId) {
    chrome.windows.remove(pending.windowId);
  }

  pending.resolve({ ...response, promptId });
  sendResponse({ ok: true });
  return true;
});

chrome.windows.onRemoved.addListener((windowId) => {
  resolvePromptClosed(windowId);
});

function handleWebAgentsPermissionsMessage(
  message: { type?: string; origin?: string },
  sendResponse: (response?: unknown) => void,
): boolean {
  if (message?.type === 'web_agents_permissions.list_all') {
    (async () => {
      const permissions = await listAllPermissions();
      sendResponse({ ok: true, permissions });
    })().catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }

  if (message?.type === 'web_agents_permissions.revoke_origin') {
    const { origin } = message as { origin?: string };
    if (!origin) {
      sendResponse({ ok: false, error: 'Missing origin' });
      return true;
    }

    (async () => {
      await revokeOriginPermissions(origin);
      sendResponse({ ok: true });
    })().catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
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

async function showPermissionPrompt(
  origin: string,
  scopes: PermissionScope[],
  reason?: string,
  tools?: string[],
): Promise<{ granted: boolean; scopes: Record<PermissionScope, PermissionGrantType>; allowedTools?: string[] }> {
  const permissions = await getPermissions(origin);
  const result: Record<PermissionScope, PermissionGrantType> = {};
  const scopesToRequest: PermissionScope[] = [];
  const requestedTools = tools && tools.length > 0 ? tools : [];
  const existingAllowedTools = permissions.allowedTools || [];
  const missingTools = requestedTools.filter((tool) => !existingAllowedTools.includes(tool));
  
  for (const scope of scopes) {
    // Check if already granted
    const existing = await checkPermission(origin, scope);
    if (existing === 'granted-once' || existing === 'granted-always') {
      result[scope] = existing;
      continue;
    }
    
    if (existing === 'denied') {
      result[scope] = 'denied';
      continue;
    }

    scopesToRequest.push(scope);
  }

  let didUpdatePermissions = false;

  if (scopesToRequest.length > 0) {
    const promptResponse = await openPermissionPrompt({ origin, scopes: scopesToRequest, reason, tools });

    if (promptResponse.granted) {
      const grantType = promptResponse.grantType || 'granted-once';
      for (const scope of scopesToRequest) {
        const grant = {
          type: grantType as PermissionGrantType,
          grantedAt: Date.now(),
          expiresAt: grantType === 'granted-once' ? Date.now() + 10 * 60 * 1000 : undefined,
        };
        permissions.scopes[scope] = grant;
        result[scope] = grant.type;
      }

      if (promptResponse.allowedTools && promptResponse.allowedTools.length > 0) {
        permissions.allowedTools = [
          ...new Set([...(permissions.allowedTools || []), ...promptResponse.allowedTools]),
        ];
      }

      didUpdatePermissions = true;
    } else {
      for (const scope of scopesToRequest) {
        if (promptResponse.explicitDeny) {
          permissions.scopes[scope] = { type: 'denied', grantedAt: Date.now() };
          result[scope] = 'denied';
          didUpdatePermissions = true;
        } else {
          result[scope] = 'not-granted';
        }
      }
    }
  }

  if (scopesToRequest.length === 0 && missingTools.length > 0) {
    const promptResponse = await openPermissionPrompt({
      origin,
      scopes: ['mcp:tools.call'],
      reason,
      tools: missingTools,
    });

    if (promptResponse.granted && promptResponse.allowedTools && promptResponse.allowedTools.length > 0) {
      permissions.allowedTools = [
        ...new Set([...(permissions.allowedTools || []), ...promptResponse.allowedTools]),
      ];
      didUpdatePermissions = true;
    }
  }

  if (didUpdatePermissions) {
    await savePermissions(origin, permissions);
  }
  
  const allGranted = scopes.every(s => result[s] === 'granted-once' || result[s] === 'granted-always');
  
  return {
    granted: allGranted,
    scopes: result,
    allowedTools: permissions.allowedTools,
  };
}

// =============================================================================
// Message Handlers
// =============================================================================

interface RequestContext {
  id: string;
  type: string;
  payload: unknown;
  origin: string;
  tabId?: number;
}

type HandlerResponse = Promise<TransportResponse>;

async function handleAiCanCreateTextSession(ctx: RequestContext): HandlerResponse {
  try {
    const harborState = getHarborState();
    if (!harborState.connected) {
      await discoverHarbor();
    }
    
    const capabilities = await harborRequest<{ bridgeReady: boolean }>('system.getCapabilities');
    return { id: ctx.id, ok: true, result: capabilities.bridgeReady ? 'readily' : 'no' };
  } catch {
    return { id: ctx.id, ok: true, result: 'no' };
  }
}

async function handleAiCreateTextSession(ctx: RequestContext): HandlerResponse {
  // Check permission
  if (!await hasPermission(ctx.origin, 'model:prompt')) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission model:prompt required' },
    };
  }

  const options = (ctx.payload || {}) as Record<string, unknown>;
  const sessionId = generateSessionId();
  
  textSessions.set(sessionId, {
    sessionId,
    origin: ctx.origin,
    options,
    history: [],
    createdAt: Date.now(),
  });

  return { id: ctx.id, ok: true, result: sessionId };
}

async function handleSessionPrompt(ctx: RequestContext): HandlerResponse {
  const { sessionId, input } = ctx.payload as { sessionId: string; input: string };
  
  const session = textSessions.get(sessionId);
  if (!session) {
    return { id: ctx.id, ok: false, error: { code: 'ERR_SESSION_NOT_FOUND', message: 'Session not found' } };
  }
  
  if (session.origin !== ctx.origin) {
    return { id: ctx.id, ok: false, error: { code: 'ERR_PERMISSION_DENIED', message: 'Session belongs to different origin' } };
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
    
    // Call Harbor
    const result = await harborRequest<{ content: string; model?: string }>('llm.chat', {
      messages,
      model: session.options.model,
      temperature: session.options.temperature,
    });
    
    // Add assistant response to history
    session.history.push({ role: 'assistant', content: result.content });
    
    return { id: ctx.id, ok: true, result: result.content };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_MODEL_FAILED', message: e instanceof Error ? e.message : 'LLM request failed' },
    };
  }
}

async function handleSessionDestroy(ctx: RequestContext): HandlerResponse {
  const { sessionId } = ctx.payload as { sessionId: string };
  textSessions.delete(sessionId);
  return { id: ctx.id, ok: true, result: null };
}

async function handleLanguageModelCapabilities(ctx: RequestContext): HandlerResponse {
  try {
    const harborState = getHarborState();
    if (!harborState.connected) {
      await discoverHarbor();
    }
    
    const capabilities = await harborRequest<{ bridgeReady: boolean }>('system.getCapabilities');
    return {
      id: ctx.id,
      ok: true,
      result: {
        available: capabilities.bridgeReady ? 'readily' : 'no',
        defaultTemperature: 0.7,
        defaultTopK: 40,
        maxTopK: 100,
      },
    };
  } catch {
    return { id: ctx.id, ok: true, result: { available: 'no' } };
  }
}

async function handleProviderslist(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'model:list')) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission model:list required' },
    };
  }

  try {
    const result = await harborRequest<{ providers: unknown[] }>('llm.listProviders');
    return { id: ctx.id, ok: true, result: result.providers };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Failed to list providers' },
    };
  }
}

async function handleProvidersGetActive(ctx: RequestContext): HandlerResponse {
  try {
    const result = await harborRequest<{ default_model?: string }>('llm.getActiveProvider');
    return { id: ctx.id, ok: true, result: { provider: null, model: result.default_model || null } };
  } catch {
    return { id: ctx.id, ok: true, result: { provider: null, model: null } };
  }
}

async function handleRequestPermissions(ctx: RequestContext): HandlerResponse {
  const { scopes, reason, tools } = ctx.payload as {
    scopes: PermissionScope[];
    reason?: string;
    tools?: string[];
  };

  const result = await showPermissionPrompt(ctx.origin, scopes, reason, tools);
  return { id: ctx.id, ok: true, result };
}

async function handlePermissionsList(ctx: RequestContext): HandlerResponse {
  const permissions = await getPermissions(ctx.origin);
  const scopes: Record<string, PermissionGrantType> = {};
  
  for (const [scope, grant] of Object.entries(permissions.scopes)) {
    // Check expiration
    if (grant.type === 'granted-once' && grant.expiresAt && Date.now() > grant.expiresAt) {
      scopes[scope] = 'not-granted';
    } else {
      scopes[scope] = grant.type;
    }
  }
  
  return {
    id: ctx.id,
    ok: true,
    result: {
      origin: ctx.origin,
      scopes,
      allowedTools: permissions.allowedTools,
    },
  };
}

async function handleToolsList(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'mcp:tools.list')) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission mcp:tools.list required' },
    };
  }

  try {
    const result = await harborRequest<{ tools: unknown[] }>('mcp.listTools', {});
    return { id: ctx.id, ok: true, result: result.tools };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Failed to list tools' },
    };
  }
}

async function handleToolsCall(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'mcp:tools.call')) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission mcp:tools.call required' },
    };
  }

  const { tool, args } = ctx.payload as { tool: string; args?: Record<string, unknown> };
  
  // Check tool allowlist
  const permissions = await getPermissions(ctx.origin);
  if (permissions.allowedTools && !permissions.allowedTools.includes(tool)) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_TOOL_NOT_ALLOWED', message: `Tool ${tool} not in allowlist` },
    };
  }

  // Parse tool name (may be "serverId/toolName" or just "toolName")
  let serverId: string;
  let toolName: string;
  
  if (tool.includes('/')) {
    [serverId, toolName] = tool.split('/', 2);
  } else {
    // Need to find which server has this tool
    const toolsResult = await harborRequest<{ tools: Array<{ serverId: string; name: string }> }>('mcp.listTools', {});
    const found = toolsResult.tools.find(t => t.name === tool);
    if (!found) {
      return {
        id: ctx.id,
        ok: false,
        error: { code: 'ERR_TOOL_NOT_FOUND', message: `Tool ${tool} not found` },
      };
    }
    serverId = found.serverId;
    toolName = tool;
  }

  try {
    const result = await harborRequest<{ result: unknown }>('mcp.callTool', {
      serverId,
      toolName,
      args: args || {},
    });
    return { id: ctx.id, ok: true, result: result.result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_TOOL_FAILED', message: e instanceof Error ? e.message : 'Tool call failed' },
    };
  }
}

// =============================================================================
// Session Handlers (Explicit Sessions via Harbor)
// =============================================================================

/**
 * Create an explicit session with specified capabilities.
 * This proxies to Harbor's session.create endpoint.
 */
async function handleSessionsCreate(ctx: RequestContext): HandlerResponse {
  const options = ctx.payload as CreateSessionOptions;
  
  if (!options || !options.capabilities) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INVALID_REQUEST', message: 'Missing capabilities in session options' },
    };
  }

  // Check required permissions based on requested capabilities
  const requiredScopes: PermissionScope[] = [];
  if (options.capabilities.llm) {
    requiredScopes.push('model:prompt');
  }
  if (options.capabilities.tools && options.capabilities.tools.length > 0) {
    requiredScopes.push('mcp:tools.call');
  }
  // TODO: Add browser permission checks when those scopes are supported

  // Check permissions
  for (const scope of requiredScopes) {
    if (!await hasPermission(ctx.origin, scope)) {
      return {
        id: ctx.id,
        ok: false,
        error: { code: 'ERR_PERMISSION_DENIED', message: `Permission ${scope} required` },
      };
    }
  }

  // Get allowed tools for this origin
  const permissions = await getPermissions(ctx.origin);
  const allowedTools = permissions.allowedTools || [];

  try {
    const result = await harborRequest<{
      sessionId: string;
      capabilities: unknown;
    }>('session.create', {
      origin: ctx.origin,
      tabId: ctx.tabId,
      options,
    });

    return {
      id: ctx.id,
      ok: true,
      result: {
        success: true,
        sessionId: result.sessionId,
        capabilities: result.capabilities,
      },
    };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Session creation failed' },
    };
  }
}

/**
 * Get a session by ID.
 */
async function handleSessionsGet(ctx: RequestContext): HandlerResponse {
  const { sessionId } = ctx.payload as { sessionId: string };

  if (!sessionId) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INVALID_REQUEST', message: 'Missing sessionId' },
    };
  }

  try {
    const result = await harborRequest<{ session: SessionSummary | null }>('session.get', {
      sessionId,
      origin: ctx.origin,
    });

    return { id: ctx.id, ok: true, result: result.session };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_SESSION_NOT_FOUND', message: e instanceof Error ? e.message : 'Session not found' },
    };
  }
}

/**
 * List sessions for the requesting origin.
 */
async function handleSessionsList(ctx: RequestContext): HandlerResponse {
  try {
    const result = await harborRequest<{ sessions: SessionSummary[] }>('session.list', {
      origin: ctx.origin,
      activeOnly: true,
    });

    return { id: ctx.id, ok: true, result: result.sessions };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Failed to list sessions' },
    };
  }
}

/**
 * Terminate a session.
 */
async function handleSessionsTerminate(ctx: RequestContext): HandlerResponse {
  const { sessionId } = ctx.payload as { sessionId: string };

  if (!sessionId) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INVALID_REQUEST', message: 'Missing sessionId' },
    };
  }

  try {
    const result = await harborRequest<{ terminated: boolean }>('session.terminate', {
      sessionId,
      origin: ctx.origin,
    });

    return { id: ctx.id, ok: true, result: { terminated: result.terminated } };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_SESSION_NOT_FOUND', message: e instanceof Error ? e.message : 'Session not found' },
    };
  }
}

// =============================================================================
// Multi-Agent Handlers
// =============================================================================

// Track registered agents from this extension
const registeredAgents = new Map<string, {
  agentId: string;
  origin: string;
  tabId: number;
  name: string;
  capabilities: string[];
}>();

// Track pending invocations waiting for responses
const pendingInvocations = new Map<string, {
  resolve: (response: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

/**
 * Register an agent.
 */
async function handleAgentsRegister(ctx: RequestContext): HandlerResponse {
  const options = ctx.payload as {
    name: string;
    description?: string;
    capabilities?: string[];
    tags?: string[];
    acceptsInvocations?: boolean;
    acceptsMessages?: boolean;
  };

  if (!options.name) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INVALID_REQUEST', message: 'Missing name' },
    };
  }

  try {
    const result = await harborRequest<{
      id: string;
      name: string;
      description?: string;
      capabilities: string[];
      tags: string[];
      status: string;
      origin: string;
      acceptsInvocations: boolean;
      acceptsMessages: boolean;
      registeredAt: number;
      lastActiveAt: number;
    }>('agents.register', {
      ...options,
      origin: ctx.origin,
      tabId: ctx.tabId,
    });

    // Track locally
    if (ctx.tabId) {
      registeredAgents.set(result.id, {
        agentId: result.id,
        origin: ctx.origin,
        tabId: ctx.tabId,
        name: result.name,
        capabilities: result.capabilities,
      });
    }

    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Registration failed' },
    };
  }
}

/**
 * Unregister an agent.
 */
async function handleAgentsUnregister(ctx: RequestContext): HandlerResponse {
  const { agentId } = ctx.payload as { agentId: string };

  if (!agentId) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INVALID_REQUEST', message: 'Missing agentId' },
    };
  }

  try {
    await harborRequest('agents.unregister', { agentId, origin: ctx.origin });
    registeredAgents.delete(agentId);
    return { id: ctx.id, ok: true, result: null };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Unregistration failed' },
    };
  }
}

/**
 * Get agent info.
 */
async function handleAgentsGetInfo(ctx: RequestContext): HandlerResponse {
  const { agentId } = ctx.payload as { agentId: string };

  if (!agentId) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INVALID_REQUEST', message: 'Missing agentId' },
    };
  }

  try {
    const result = await harborRequest('agents.getInfo', { agentId, origin: ctx.origin });
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_AGENT_NOT_FOUND', message: e instanceof Error ? e.message : 'Agent not found' },
    };
  }
}

/**
 * Discover agents.
 */
async function handleAgentsDiscover(ctx: RequestContext): HandlerResponse {
  const query = ctx.payload as {
    name?: string;
    capabilities?: string[];
    tags?: string[];
    includeSameOrigin?: boolean;
    includeCrossOrigin?: boolean;
  };

  try {
    const result = await harborRequest<{ agents: unknown[]; total: number }>('agents.discover', {
      ...query,
      origin: ctx.origin,
    });
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Discovery failed' },
    };
  }
}

/**
 * List all agents.
 */
async function handleAgentsList(ctx: RequestContext): HandlerResponse {
  try {
    const result = await harborRequest<{ agents: unknown[] }>('agents.list', { origin: ctx.origin });
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'List failed' },
    };
  }
}

/**
 * Invoke an agent.
 */
async function handleAgentsInvoke(ctx: RequestContext): HandlerResponse {
  const { agentId, request } = ctx.payload as {
    agentId: string;
    request: { task: string; input?: unknown; timeout?: number };
  };

  if (!agentId || !request) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INVALID_REQUEST', message: 'Missing agentId or request' },
    };
  }

  try {
    const result = await harborRequest<{
      success: boolean;
      result?: unknown;
      error?: { code: string; message: string };
      executionTime?: number;
    }>('agents.invoke', {
      agentId,
      request,
      origin: ctx.origin,
      tabId: ctx.tabId,
    });

    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Invocation failed' },
    };
  }
}

/**
 * Send a message to an agent.
 */
async function handleAgentsSend(ctx: RequestContext): HandlerResponse {
  const { agentId, payload } = ctx.payload as { agentId: string; payload: unknown };

  if (!agentId) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INVALID_REQUEST', message: 'Missing agentId' },
    };
  }

  try {
    const result = await harborRequest<{ delivered: boolean }>('agents.send', {
      agentId,
      payload,
      origin: ctx.origin,
      tabId: ctx.tabId,
    });

    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Send failed' },
    };
  }
}

/**
 * Subscribe to events.
 */
async function handleAgentsSubscribe(ctx: RequestContext): HandlerResponse {
  const { eventType } = ctx.payload as { eventType: string };

  if (!eventType) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INVALID_REQUEST', message: 'Missing eventType' },
    };
  }

  try {
    await harborRequest('agents.subscribe', {
      eventType,
      origin: ctx.origin,
      tabId: ctx.tabId,
    });

    return { id: ctx.id, ok: true, result: null };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Subscribe failed' },
    };
  }
}

/**
 * Unsubscribe from events.
 */
async function handleAgentsUnsubscribe(ctx: RequestContext): HandlerResponse {
  const { eventType } = ctx.payload as { eventType: string };

  if (!eventType) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INVALID_REQUEST', message: 'Missing eventType' },
    };
  }

  try {
    await harborRequest('agents.unsubscribe', {
      eventType,
      origin: ctx.origin,
      tabId: ctx.tabId,
    });

    return { id: ctx.id, ok: true, result: null };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Unsubscribe failed' },
    };
  }
}

/**
 * Broadcast an event.
 */
async function handleAgentsBroadcast(ctx: RequestContext): HandlerResponse {
  const { eventType, data } = ctx.payload as { eventType: string; data: unknown };

  if (!eventType) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INVALID_REQUEST', message: 'Missing eventType' },
    };
  }

  try {
    const result = await harborRequest<{ delivered: number }>('agents.broadcast', {
      eventType,
      data,
      origin: ctx.origin,
      tabId: ctx.tabId,
    });

    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Broadcast failed' },
    };
  }
}

/**
 * Execute a pipeline.
 */
async function handleAgentsPipeline(ctx: RequestContext): HandlerResponse {
  const { config, initialInput } = ctx.payload as {
    config: { steps: Array<{ agentId: string; task: string; inputTransform?: string; outputTransform?: string }> };
    initialInput: unknown;
  };

  if (!config?.steps?.length) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INVALID_REQUEST', message: 'Missing pipeline steps' },
    };
  }

  try {
    const result = await harborRequest<{
      success: boolean;
      result: unknown;
      stepResults: unknown[];
    }>('agents.orchestrate.pipeline', {
      config,
      initialInput,
      origin: ctx.origin,
    });

    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Pipeline failed' },
    };
  }
}

/**
 * Execute parallel tasks.
 */
async function handleAgentsParallel(ctx: RequestContext): HandlerResponse {
  const { config } = ctx.payload as {
    config: {
      tasks: Array<{ agentId: string; task: string; input?: unknown }>;
      combineStrategy?: 'array' | 'merge' | 'first';
    };
  };

  if (!config?.tasks?.length) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INVALID_REQUEST', message: 'Missing parallel tasks' },
    };
  }

  try {
    const result = await harborRequest<{
      success: boolean;
      results: unknown[];
      combined: unknown;
    }>('agents.orchestrate.parallel', {
      config,
      origin: ctx.origin,
    });

    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Parallel execution failed' },
    };
  }
}

/**
 * Route to an agent.
 */
async function handleAgentsRoute(ctx: RequestContext): HandlerResponse {
  const { config, input, task } = ctx.payload as {
    config: {
      routes: Array<{ condition: string; agentId: string }>;
      defaultAgentId?: string;
    };
    input: unknown;
    task: string;
  };

  if (!config?.routes?.length) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INVALID_REQUEST', message: 'Missing routes' },
    };
  }

  try {
    const result = await harborRequest<{
      success: boolean;
      result?: unknown;
      error?: { code: string; message: string };
    }>('agents.orchestrate.route', {
      config,
      input,
      task,
      origin: ctx.origin,
    });

    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Routing failed' },
    };
  }
}

// Clean up agents when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [agentId, agent] of registeredAgents.entries()) {
    if (agent.tabId === tabId) {
      registeredAgents.delete(agentId);
      // Notify Harbor of cleanup
      harborRequest('agents.unregister', { agentId, origin: agent.origin }).catch(() => {});
    }
  }
});

// =============================================================================
// Agent Run Handler (Agentic Loop)
// =============================================================================

interface AgentRunEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'final' | 'error';
  content?: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  output?: string;
  error?: string;
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
    console.log('[Web Agents API] agent.run: Missing model:prompt permission');
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
    
    const hasToolsListPerm = await hasPermission(ctx.origin, 'mcp:tools.list');
    console.log('[Web Agents API] agent.run: mcp:tools.list permission:', hasToolsListPerm);
    
    if (hasToolsListPerm) {
      const toolsResult = await harborRequest<{ tools: typeof tools }>('mcp.listTools', {});
      tools = toolsResult.tools || [];
      console.log('[Web Agents API] agent.run: Found', tools.length, 'tools');
      
      // Filter to allowed tools (only if there's an explicit allowlist)
      const permissions = await getPermissions(ctx.origin);
      if (permissions.allowedTools && permissions.allowedTools.length > 0) {
        tools = tools.filter(t => 
          permissions.allowedTools!.includes(t.name) || 
          permissions.allowedTools!.includes(`${t.serverId}/${t.name}`)
        );
        console.log('[Web Agents API] agent.run: After filtering:', tools.length, 'tools');
      }
    }

    // Build tool definitions for the LLM (bridge expects {name, description, input_schema})
    const llmTools = tools.map(t => ({
      name: `${t.serverId}_${t.name}`.replace(/[^a-zA-Z0-9_]/g, '_'), // LLM-safe name
      description: t.description || `Tool: ${t.serverId}/${t.name}`,
      input_schema: t.inputSchema || { type: 'object', properties: {} },
      // Keep original info for later
      _serverId: t.serverId,
      _toolName: t.name,
    }));

    console.log('[Web Agents API] agent.run: LLM tools:', llmTools.map(t => t.name));

    // Send thinking event with available tools
    if (llmTools.length > 0) {
      sendEvent({
        id: ctx.id,
        event: { type: 'token', token: JSON.stringify({ 
          type: 'thinking', 
          content: `Available tools: ${tools.map(t => `${t.serverId}/${t.name}`).join(', ')}` 
        }) },
      });
    } else {
      sendEvent({
        id: ctx.id,
        event: { type: 'token', token: JSON.stringify({ 
          type: 'thinking', 
          content: 'No tools available (check mcp:tools.list permission)' 
        }) },
      });
    }

    // Agentic loop - use native tool calling
    const messages: Array<{ role: string; content: string }> = [];
    const fullSystemPrompt = systemPrompt || 'You are a helpful assistant that can use tools to help users.';

    messages.push({ role: 'system', content: fullSystemPrompt });
    messages.push({ role: 'user', content: task });

    let toolCallCount = 0;

    while (toolCallCount < maxToolCalls) {
      // Call LLM with tools (native tool calling)
      console.log('[Web Agents API] agent.run: Calling LLM with', messages.length, 'messages and', llmTools.length, 'tools');
      
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
        console.log('[Web Agents API] agent.run: LLM result:', JSON.stringify(result).substring(0, 500));
      } catch (e) {
        console.error('[Web Agents API] agent.run: LLM request failed:', e);
        sendEvent({
          id: ctx.id,
          event: { type: 'token', token: JSON.stringify({ type: 'error', error: `LLM request failed: ${e}` }) },
        });
        sendEvent({ id: ctx.id, event: { type: 'done' }, done: true });
        return;
      }

      // Extract response - handle both formats (direct content or choices array)
      const choice = result.choices?.[0];
      const responseContent = choice?.message?.content || result.content || '';
      const toolCalls = choice?.message?.tool_calls;
      
      console.log('[Web Agents API] agent.run: Response content:', responseContent?.substring(0, 200));
      console.log('[Web Agents API] agent.run: Tool calls:', toolCalls);

      // If there are tool calls, execute them
      if (toolCalls && toolCalls.length > 0) {
        // Check if we can call tools
        const hasToolsCallPerm = await hasPermission(ctx.origin, 'mcp:tools.call');
        if (!hasToolsCallPerm) {
          messages.push({ role: 'assistant', content: responseContent || 'I need to use tools but permission was denied.' });
          messages.push({ role: 'user', content: 'Tool calling is not permitted. Please provide an answer without using tools.' });
          continue;
        }

        // Process each tool call
        for (const tc of toolCalls) {
          const llmToolName = tc.function.name;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            args = {};
          }

          // Find the original tool info
          const toolInfo = llmTools.find(t => t.name === llmToolName);
          const serverId = toolInfo?._serverId || '';
          const actualToolName = toolInfo?._toolName || llmToolName;
          const displayName = `${serverId}/${actualToolName}`;

          console.log('[Web Agents API] agent.run: Calling tool:', displayName, 'with args:', args);

          // Send tool_call event
          sendEvent({
            id: ctx.id,
            event: { type: 'token', token: JSON.stringify({ type: 'tool_call', tool: displayName, args }) },
          });

          // Call the tool
          let toolResult: unknown;
          try {
            const callResult = await harborRequest<{ result: unknown }>('mcp.callTool', {
              serverId,
              toolName: actualToolName,
              args,
            });
            toolResult = callResult.result;
            console.log('[Web Agents API] agent.run: Tool result:', toolResult);
          } catch (e) {
            console.error('[Web Agents API] agent.run: Tool call failed:', e);
            toolResult = { error: e instanceof Error ? e.message : 'Tool call failed' };
          }

          // Send tool_result event
          sendEvent({
            id: ctx.id,
            event: { type: 'token', token: JSON.stringify({ type: 'tool_result', tool: displayName, result: toolResult }) },
          });

          // Add tool call and result to messages
          // WORKAROUND: Encode tool call info in assistant message since some bridges don't support tool_calls
          messages.push({ 
            role: 'assistant', 
            content: `[Called tool: ${displayName}(${JSON.stringify(args)})]` 
          });
          messages.push({ 
            role: 'user', 
            content: `Tool "${displayName}" returned: ${JSON.stringify(toolResult)}` 
          });

          toolCallCount++;
        }
      } else {
        // No tool calls, this is the final response
        console.log('[Web Agents API] agent.run: Final response (no tool calls)');
        sendEvent({
          id: ctx.id,
          event: { type: 'token', token: JSON.stringify({ type: 'final', output: responseContent }) },
        });
        sendEvent({ id: ctx.id, event: { type: 'done' }, done: true });
        return;
      }
    }

    // Max tool calls reached, get final answer
    console.log('[Web Agents API] agent.run: Max tool calls reached, getting final answer');
    messages.push({ role: 'user', content: 'Please provide your final answer based on the information gathered.' });
    const finalResult = await harborRequest<{ content?: string; choices?: Array<{ message: { content: string } }> }>('llm.chat', { messages });
    const finalContent = finalResult.choices?.[0]?.message?.content || finalResult.content || '';
    
    sendEvent({
      id: ctx.id,
      event: { type: 'token', token: JSON.stringify({ type: 'final', output: finalContent }) },
    });
    sendEvent({ id: ctx.id, event: { type: 'done' }, done: true });

  } catch (e) {
    console.error('[Web Agents API] agent.run: Error:', e);
    sendEvent({
      id: ctx.id,
      event: { type: 'error', error: { code: 'ERR_AGENT_FAILED', message: e instanceof Error ? e.message : 'Agent run failed' } },
      done: true,
    });
  }
}

// =============================================================================
// Streaming Handler
// =============================================================================

async function handleSessionPromptStreaming(
  ctx: RequestContext,
  sendEvent: (event: TransportStreamEvent) => void,
): Promise<void> {
  const { sessionId, input } = ctx.payload as { sessionId: string; input: string };
  
  const session = textSessions.get(sessionId);
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
    const { stream, cancel } = harborStreamRequest('llm.chatStream', {
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
        // Add assistant response to history
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

// =============================================================================
// Browser Interaction Handlers
// =============================================================================

/**
 * Find an element by selector/ref and click it.
 */
async function handleBrowserClick(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'browser:activeTab.interact')) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission browser:activeTab.interact required' },
    };
  }

  const { ref } = ctx.payload as { ref: string };
  if (!ref) {
    return { id: ctx.id, ok: false, error: { code: 'ERR_INVALID_REQUEST', message: 'Missing ref parameter' } };
  }

  if (!ctx.tabId) {
    return { id: ctx.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'No tab context available' } };
  }

  try {
    const result = await executeScriptInTab<{ success: boolean; error?: string }>(
      ctx.tabId,
      (selector: string) => {
        const el = document.querySelector(selector);
        if (!el) {
          return { success: false, error: `Element not found: ${selector}` };
        }
        if (el instanceof HTMLElement) {
          el.click();
          return { success: true };
        }
        return { success: false, error: 'Element is not clickable' };
      },
      [ref]
    );

    if (!result) {
      return { id: ctx.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'Script execution failed' } };
    }
    if (!result.success) {
      return { id: ctx.id, ok: false, error: { code: 'ERR_ELEMENT_NOT_FOUND', message: result.error || 'Click failed' } };
    }
    return { id: ctx.id, ok: true, result: { success: true } };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Click failed' },
    };
  }
}

/**
 * Find an element by selector/ref and fill it with a value.
 */
async function handleBrowserFill(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'browser:activeTab.interact')) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission browser:activeTab.interact required' },
    };
  }

  const { ref, value } = ctx.payload as { ref: string; value: string };
  if (!ref) {
    return { id: ctx.id, ok: false, error: { code: 'ERR_INVALID_REQUEST', message: 'Missing ref parameter' } };
  }

  if (!ctx.tabId) {
    return { id: ctx.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'No tab context available' } };
  }

  try {
    const result = await executeScriptInTab<{ success: boolean; error?: string }>(
      ctx.tabId,
      (selector: string, fillValue: string) => {
        const el = document.querySelector(selector);
        if (!el) {
          return { success: false, error: `Element not found: ${selector}` };
        }
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.value = fillValue;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true };
        }
        if (el instanceof HTMLElement && el.isContentEditable) {
          el.textContent = fillValue;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return { success: true };
        }
        return { success: false, error: 'Element is not fillable' };
      },
      [ref, value ?? '']
    );

    if (!result) {
      return { id: ctx.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'Script execution failed' } };
    }
    if (!result.success) {
      return { id: ctx.id, ok: false, error: { code: 'ERR_ELEMENT_NOT_FOUND', message: result.error || 'Fill failed' } };
    }
    return { id: ctx.id, ok: true, result: { success: true } };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Fill failed' },
    };
  }
}

/**
 * Select an option from a dropdown by selector/ref.
 */
async function handleBrowserSelect(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'browser:activeTab.interact')) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission browser:activeTab.interact required' },
    };
  }

  const { ref, value } = ctx.payload as { ref: string; value: string };
  if (!ref) {
    return { id: ctx.id, ok: false, error: { code: 'ERR_INVALID_REQUEST', message: 'Missing ref parameter' } };
  }

  if (!ctx.tabId) {
    return { id: ctx.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'No tab context available' } };
  }

  try {
    const result = await executeScriptInTab<{ success: boolean; error?: string }>(
      ctx.tabId,
      (selector: string, selectValue: string) => {
        const el = document.querySelector(selector);
        if (!el) {
          return { success: false, error: `Element not found: ${selector}` };
        }
        if (el instanceof HTMLSelectElement) {
          el.value = selectValue;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true };
        }
        return { success: false, error: 'Element is not a select' };
      },
      [ref, value ?? '']
    );

    if (!result) {
      return { id: ctx.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'Script execution failed' } };
    }
    if (!result.success) {
      return { id: ctx.id, ok: false, error: { code: 'ERR_ELEMENT_NOT_FOUND', message: result.error || 'Select failed' } };
    }
    return { id: ctx.id, ok: true, result: { success: true } };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Select failed' },
    };
  }
}

/**
 * Scroll the page in a direction.
 */
async function handleBrowserScroll(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'browser:activeTab.interact')) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission browser:activeTab.interact required' },
    };
  }

  const { direction, amount } = ctx.payload as { direction: 'up' | 'down' | 'left' | 'right'; amount?: number };
  if (!direction) {
    return { id: ctx.id, ok: false, error: { code: 'ERR_INVALID_REQUEST', message: 'Missing direction parameter' } };
  }

  if (!ctx.tabId) {
    return { id: ctx.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'No tab context available' } };
  }

  try {
    const result = await executeScriptInTab<{ success: boolean }>(
      ctx.tabId,
      (dir: string, scrollAmount: number) => {
        const px = scrollAmount || 300;
        switch (dir) {
          case 'up':
            window.scrollBy(0, -px);
            break;
          case 'down':
            window.scrollBy(0, px);
            break;
          case 'left':
            window.scrollBy(-px, 0);
            break;
          case 'right':
            window.scrollBy(px, 0);
            break;
        }
        return { success: true };
      },
      [direction, amount ?? 300]
    );

    if (!result) {
      return { id: ctx.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'Script execution failed' } };
    }
    return { id: ctx.id, ok: true, result: { success: true } };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Scroll failed' },
    };
  }
}

/**
 * Take a screenshot of the active tab.
 */
async function handleBrowserScreenshot(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'browser:activeTab.screenshot')) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission browser:activeTab.screenshot required' },
    };
  }

  if (!ctx.tabId) {
    return { id: ctx.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'No tab context available' } };
  }

  try {
    // Use browser-compatible API
    const tabsApi = (typeof browser !== 'undefined' ? browser.tabs : chrome.tabs);
    const dataUrl = await tabsApi.captureVisibleTab({ format: 'png' });
    return { id: ctx.id, ok: true, result: { dataUrl } };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Screenshot failed' },
    };
  }
}

/**
 * Get interactive elements on the page.
 */
async function handleBrowserGetElements(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'browser:activeTab.read')) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission browser:activeTab.read required' },
    };
  }

  if (!ctx.tabId) {
    return { id: ctx.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'No tab context available' } };
  }

  type ElementInfo = {
    ref: string;
    tag: string;
    type?: string;
    text?: string;
    placeholder?: string;
    value?: string;
    role?: string;
  };

  try {
    const result = await executeScriptInTab<ElementInfo[]>(
      ctx.tabId,
      () => {
        const elements: Array<{
          ref: string;
          tag: string;
          type?: string;
          text?: string;
          placeholder?: string;
          value?: string;
          role?: string;
        }> = [];

        // Find interactive elements
        const selectors = [
          'a[href]',
          'button',
          'input',
          'select',
          'textarea',
          '[role="button"]',
          '[role="link"]',
          '[onclick]',
          '[contenteditable="true"]',
        ];

        const seen = new Set<Element>();
        
        for (const selector of selectors) {
          for (const el of document.querySelectorAll(selector)) {
            if (seen.has(el)) continue;
            seen.add(el);

            // Skip hidden elements
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;

            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;

            // Generate a unique ref (prefer id, then create a path)
            let ref = '';
            if (el.id) {
              ref = `#${el.id}`;
            } else {
              // Generate a simple CSS path
              const parts: string[] = [];
              let current: Element | null = el;
              while (current && current !== document.body) {
                let pathSelector = current.tagName.toLowerCase();
                if (current.id) {
                  pathSelector = `#${current.id}`;
                  parts.unshift(pathSelector);
                  break;
                }
                const parent = current.parentElement;
                if (parent) {
                  const siblings = Array.from(parent.children).filter(c => c.tagName === current!.tagName);
                  if (siblings.length > 1) {
                    const index = siblings.indexOf(current) + 1;
                    pathSelector += `:nth-of-type(${index})`;
                  }
                }
                parts.unshift(pathSelector);
                current = parent;
              }
              ref = parts.join(' > ');
            }

            const info: typeof elements[0] = {
              ref,
              tag: el.tagName.toLowerCase(),
            };

            if (el instanceof HTMLInputElement) {
              info.type = el.type;
              if (el.placeholder) info.placeholder = el.placeholder;
              if (el.value && el.type !== 'password') info.value = el.value;
            } else if (el instanceof HTMLTextAreaElement) {
              if (el.placeholder) info.placeholder = el.placeholder;
            } else if (el instanceof HTMLSelectElement) {
              info.value = el.value;
            }

            const text = el.textContent?.trim().slice(0, 100);
            if (text) info.text = text;

            const role = el.getAttribute('role');
            if (role) info.role = role;

            elements.push(info);
          }
        }

        return elements;
      },
      []
    );

    if (!result) {
      return { id: ctx.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'Script execution failed' } };
    }
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'GetElements failed' },
    };
  }
}

/**
 * Get page content using readability-like extraction.
 */
async function handleBrowserReadability(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'browser:activeTab.read')) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission browser:activeTab.read required' },
    };
  }

  if (!ctx.tabId) {
    return { id: ctx.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'No tab context available' } };
  }

  type ReadabilityResult = {
    title: string;
    url: string;
    content: string;
    length: number;
  };

  try {
    const result = await executeScriptInTab<ReadabilityResult>(
      ctx.tabId,
      () => {
        // Simple text extraction (a full readability implementation would be more complex)
        const title = document.title;
        const url = window.location.href;
        
        // Try to find main content
        const mainSelectors = ['main', 'article', '[role="main"]', '.content', '#content', '.post', '.article'];
        let content = '';
        
        for (const selector of mainSelectors) {
          const el = document.querySelector(selector);
          if (el) {
            content = el.textContent?.trim() || '';
            break;
          }
        }
        
        // Fallback to body text
        if (!content) {
          content = document.body.textContent?.trim() || '';
        }
        
        // Clean up whitespace
        content = content.replace(/\s+/g, ' ').trim();
        
        return {
          title,
          url,
          content: content.slice(0, 50000), // Limit size
          length: content.length,
        };
      },
      []
    );

    if (!result) {
      return { id: ctx.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'Script execution failed' } };
    }
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Readability extraction failed' },
    };
  }
}

// =============================================================================
// Tab Management (Extension 2)
// =============================================================================

/**
 * Create a new tab.
 */
async function handleTabsCreate(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'browser:tabs.create')) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission browser:tabs.create required' },
    };
  }

  const payload = ctx.payload as { url: string; active?: boolean; index?: number; windowId?: number };
  
  if (!payload.url) {
    return { id: ctx.id, ok: false, error: { code: 'ERR_INVALID_REQUEST', message: 'Missing url parameter' } };
  }

  try {
    const tab = await chrome.tabs.create({
      url: payload.url,
      active: payload.active ?? false,
      index: payload.index,
      windowId: payload.windowId,
    });

    if (!tab.id) {
      return { id: ctx.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'Failed to create tab' } };
    }

    // Track this tab as spawned by this origin
    trackSpawnedTab(ctx.origin, tab.id);

    return {
      id: ctx.id,
      ok: true,
      result: {
        id: tab.id,
        url: tab.url || payload.url,
        title: tab.title || '',
        active: tab.active,
        index: tab.index,
        windowId: tab.windowId,
        canControl: true,
      },
    };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Failed to create tab' },
    };
  }
}

/**
 * List all tabs.
 */
async function handleTabsList(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'browser:tabs.read')) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission browser:tabs.read required' },
    };
  }

  try {
    const tabs = await chrome.tabs.query({});
    const result = tabs.map(tab => ({
      id: tab.id!,
      url: tab.url || '',
      title: tab.title || '',
      active: tab.active,
      index: tab.index,
      windowId: tab.windowId,
      favIconUrl: tab.favIconUrl,
      status: tab.status as 'loading' | 'complete' | undefined,
      canControl: tab.id ? isSpawnedTab(ctx.origin, tab.id) : false,
    }));

    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Failed to list tabs' },
    };
  }
}

/**
 * Close a tab that this origin created.
 */
async function handleTabsClose(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'browser:tabs.create')) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission browser:tabs.create required' },
    };
  }

  const { tabId } = ctx.payload as { tabId: number };
  
  if (typeof tabId !== 'number') {
    return { id: ctx.id, ok: false, error: { code: 'ERR_INVALID_REQUEST', message: 'Missing tabId parameter' } };
  }

  // Only allow closing tabs that this origin created
  if (!isSpawnedTab(ctx.origin, tabId)) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Can only close tabs created by this origin' },
    };
  }

  try {
    await chrome.tabs.remove(tabId);
    untrackSpawnedTab(ctx.origin, tabId);
    return { id: ctx.id, ok: true, result: true };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Failed to close tab' },
    };
  }
}

/**
 * Get readability content from a spawned tab.
 */
async function handleSpawnedTabReadability(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'browser:tabs.create')) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission browser:tabs.create required' },
    };
  }

  const { tabId } = ctx.payload as { tabId: number };
  
  if (typeof tabId !== 'number') {
    return { id: ctx.id, ok: false, error: { code: 'ERR_INVALID_REQUEST', message: 'Missing tabId parameter' } };
  }

  // Only allow reading from tabs that this origin created
  if (!isSpawnedTab(ctx.origin, tabId)) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Can only read from tabs created by this origin' },
    };
  }

  type ReadabilityResult = {
    title: string;
    url: string;
    content: string;
    text: string;
    length: number;
  };

  try {
    const result = await executeScriptInTab<ReadabilityResult>(
      tabId,
      () => {
        const title = document.title;
        const url = window.location.href;
        
        // Try to find main content
        const mainSelectors = ['main', 'article', '[role="main"]', '.content', '#content', '.post', '.article'];
        let content = '';
        
        for (const selector of mainSelectors) {
          const el = document.querySelector(selector);
          if (el) {
            content = el.textContent?.trim() || '';
            break;
          }
        }
        
        // Fallback to body text
        if (!content) {
          content = document.body.textContent?.trim() || '';
        }
        
        // Clean up whitespace
        content = content.replace(/\s+/g, ' ').trim();
        
        return {
          title,
          url,
          content: content.slice(0, 50000),
          text: content.slice(0, 50000), // Alias for compatibility
          length: content.length,
        };
      },
      []
    );

    if (!result) {
      return { id: ctx.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'Script execution failed' } };
    }
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Readability extraction failed' },
    };
  }
}

/**
 * Get HTML content from a spawned tab.
 */
async function handleSpawnedTabGetHtml(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'browser:tabs.create')) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission browser:tabs.create required' },
    };
  }

  const { tabId, selector } = ctx.payload as { tabId: number; selector?: string };
  
  if (typeof tabId !== 'number') {
    return { id: ctx.id, ok: false, error: { code: 'ERR_INVALID_REQUEST', message: 'Missing tabId parameter' } };
  }

  // Only allow reading from tabs that this origin created
  if (!isSpawnedTab(ctx.origin, tabId)) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Can only read from tabs created by this origin' },
    };
  }

  try {
    const result = await executeScriptInTab<{ html: string; url: string; title: string }>(
      tabId,
      (containerSelector: string | null) => {
        const container = containerSelector 
          ? document.querySelector(containerSelector) 
          : document.body;
        
        return {
          html: container?.outerHTML || document.body.outerHTML,
          url: window.location.href,
          title: document.title,
        };
      },
      [selector || null]
    );

    if (!result) {
      return { id: ctx.id, ok: false, error: { code: 'ERR_INTERNAL', message: 'Script execution failed' } };
    }
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Get HTML failed' },
    };
  }
}

/**
 * Wait for a spawned tab to finish loading.
 */
async function handleSpawnedTabWaitForLoad(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'browser:tabs.create')) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission browser:tabs.create required' },
    };
  }

  const { tabId, timeout = 30000 } = ctx.payload as { tabId: number; timeout?: number };
  
  if (typeof tabId !== 'number') {
    return { id: ctx.id, ok: false, error: { code: 'ERR_INVALID_REQUEST', message: 'Missing tabId parameter' } };
  }

  // Only allow waiting for tabs that this origin created
  if (!isSpawnedTab(ctx.origin, tabId)) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message: 'Can only wait for tabs created by this origin' },
    };
  }

  try {
    // Check if tab is already complete
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') {
      return { id: ctx.id, ok: true, result: undefined };
    }

    // Wait for the tab to finish loading
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Navigation timeout'));
      }, timeout);

      const listener = (
        updatedTabId: number,
        changeInfo: chrome.tabs.TabChangeInfo,
      ) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          clearTimeout(timeoutId);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
    });

    return { id: ctx.id, ok: true, result: undefined };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: e instanceof Error ? e.message : 'Wait for load failed' },
    };
  }
}

// =============================================================================
// Message Router
// =============================================================================

async function routeMessage(ctx: RequestContext): HandlerResponse {
  switch (ctx.type) {
    // AI operations
    case 'ai.canCreateTextSession':
      return handleAiCanCreateTextSession(ctx);
    case 'ai.createTextSession':
    case 'ai.languageModel.create':
      return handleAiCreateTextSession(ctx);
    case 'session.prompt':
      return handleSessionPrompt(ctx);
    case 'session.destroy':
      return handleSessionDestroy(ctx);
    case 'ai.languageModel.capabilities':
      return handleLanguageModelCapabilities(ctx);
    case 'ai.providers.list':
      return handleProviderslist(ctx);
    case 'ai.providers.getActive':
      return handleProvidersGetActive(ctx);

    // Permission operations
    case 'agent.requestPermissions':
      return handleRequestPermissions(ctx);
    case 'agent.permissions.list':
      return handlePermissionsList(ctx);

    // Tool operations
    case 'agent.tools.list':
      return handleToolsList(ctx);
    case 'agent.tools.call':
      return handleToolsCall(ctx);

    // Session operations (explicit sessions)
    case 'agent.sessions.create':
      return handleSessionsCreate(ctx);
    case 'agent.sessions.get':
      return handleSessionsGet(ctx);
    case 'agent.sessions.list':
      return handleSessionsList(ctx);
    case 'agent.sessions.terminate':
      return handleSessionsTerminate(ctx);

    // Browser interaction operations
    case 'agent.browser.activeTab.click':
      return handleBrowserClick(ctx);
    case 'agent.browser.activeTab.fill':
      return handleBrowserFill(ctx);
    case 'agent.browser.activeTab.scroll':
      return handleBrowserScroll(ctx);
    case 'agent.browser.activeTab.screenshot':
      return handleBrowserScreenshot(ctx);
    case 'agent.browser.activeTab.getElements':
      return handleBrowserGetElements(ctx);
    case 'agent.browser.activeTab.readability':
      return handleBrowserReadability(ctx);
    case 'agent.browser.activeTab.select':
      return handleBrowserSelect(ctx);

    // Tab management operations
    case 'agent.browser.tabs.create':
      return handleTabsCreate(ctx);
    case 'agent.browser.tabs.list':
      return handleTabsList(ctx);
    case 'agent.browser.tabs.close':
      return handleTabsClose(ctx);

    // Spawned tab operations
    case 'agent.browser.tab.readability':
      return handleSpawnedTabReadability(ctx);
    case 'agent.browser.tab.getHtml':
      return handleSpawnedTabGetHtml(ctx);
    case 'agent.browser.tab.waitForLoad':
      return handleSpawnedTabWaitForLoad(ctx);

    // Multi-agent operations
    case 'agent.agents.register':
      return handleAgentsRegister(ctx);
    case 'agent.agents.unregister':
      return handleAgentsUnregister(ctx);
    case 'agent.agents.getInfo':
      return handleAgentsGetInfo(ctx);
    case 'agent.agents.discover':
      return handleAgentsDiscover(ctx);
    case 'agent.agents.list':
      return handleAgentsList(ctx);
    case 'agent.agents.invoke':
      return handleAgentsInvoke(ctx);
    case 'agent.agents.send':
      return handleAgentsSend(ctx);
    case 'agent.agents.subscribe':
      return handleAgentsSubscribe(ctx);
    case 'agent.agents.unsubscribe':
      return handleAgentsUnsubscribe(ctx);
    case 'agent.agents.broadcast':
      return handleAgentsBroadcast(ctx);
    case 'agent.agents.orchestrate.pipeline':
      return handleAgentsPipeline(ctx);
    case 'agent.agents.orchestrate.parallel':
      return handleAgentsParallel(ctx);
    case 'agent.agents.orchestrate.route':
      return handleAgentsRoute(ctx);

    default:
      return {
        id: ctx.id,
        ok: false,
        error: { code: 'ERR_INTERNAL', message: `Unknown message type: ${ctx.type}` },
      };
  }
}

// =============================================================================
// Port Connection Handler
// =============================================================================

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'web-agent-transport') return;

  port.onMessage.addListener(async (message: RequestContext & { type: string }) => {
    const ctx: RequestContext = {
      id: message.id,
      type: message.type,
      payload: message.payload,
      origin: message.origin || '',
      tabId: port.sender?.tab?.id,
    };

    // Handle streaming requests
    if (ctx.type === 'session.promptStreaming') {
      const sendEvent = (event: TransportStreamEvent) => {
        try {
          port.postMessage(event);
        } catch {
          // Port disconnected
        }
      };
      await handleSessionPromptStreaming(ctx, sendEvent);
      return;
    }

    // Handle agent.run (agentic loop)
    if (ctx.type === 'agent.run') {
      const sendEvent = (event: TransportStreamEvent) => {
        try {
          port.postMessage(event);
        } catch {
          // Port disconnected
        }
      };
      await handleAgentRun(ctx, sendEvent);
      return;
    }

    // Handle regular requests
    const response = await routeMessage(ctx);
    try {
      port.postMessage(response);
    } catch {
      // Port disconnected
    }
  });
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
// Sidebar Message Handlers
// =============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Check Harbor connection status
  if (message?.type === 'checkHarborConnection') {
    (async () => {
      const state = getHarborState();
      if (!state.connected) {
        // Try to discover Harbor
        const id = await discoverHarbor();
        sendResponse({ connected: !!id, extensionId: id });
      } else {
        sendResponse({ connected: true, extensionId: state.extensionId });
      }
    })();
    return true;
  }

  // Get permissions for a specific origin
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

  // List all permissions
  if (message?.type === 'listAllPermissions') {
    (async () => {
      const permissions = await listAllPermissions();
      sendResponse({ permissions });
    })();
    return true;
  }

  // Revoke permissions for an origin
  if (message?.type === 'revokePermissions') {
    const { origin } = message as { origin?: string };
    if (!origin) {
      sendResponse({ ok: false, error: 'Missing origin' });
      return true;
    }

    (async () => {
      await revokeOriginPermissions(origin);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // Revoke all permissions
  if (message?.type === 'revokeAllPermissions') {
    (async () => {
      const result = await chrome.storage.local.get(null);
      const keysToRemove: string[] = [];
      
      for (const key of Object.keys(result)) {
        if (key.startsWith('permissions:')) {
          keysToRemove.push(key);
        }
      }
      
      if (keysToRemove.length > 0) {
        await chrome.storage.local.remove(keysToRemove);
      }
      
      sendResponse({ ok: true });
    })();
    return true;
  }

  // Get feature flags for content script injection
  if (message?.type === 'getFeatureFlags') {
    (async () => {
      const flags = await getFeatureFlags();
      sendResponse(flags);
    })();
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
