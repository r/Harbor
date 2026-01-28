/**
 * Harbor Extension - Background Script
 *
 * Main entry point for the extension's background service worker.
 * Initializes all modules and sets up message routing.
 */

import { browserAPI, getBrowserName, isServiceWorker, serviceWorkerLifecycle, getFeatureSummary } from './browser-compat';
import { initializePolicyStore } from './policy/store';
import { initializeBridgeClient, getBridgeConnectionState, checkBridgeHealth, bridgeRequest } from './llm/bridge-client';
import { getConnectionState as getNativeConnectionState } from './llm/native-bridge';
import { initializeMcpHost, addServer, startServer, stopServer, validateAndStartServer, removeServer, listServersWithStatus, callTool } from './mcp/host';
import { cleanupExpiredGrants, listAllPermissions, revokePermissions } from './policy/permissions';
import { getFeatureFlags, setFeatureFlags, type FeatureFlags } from './policy/feature-flags';
import { initializeExtensionApi } from './extension-api';
import { SessionRegistry } from './sessions';
import { initializeRouter } from './agents/background-router';

console.log(`[Harbor] Extension starting on ${getBrowserName()}...`);
console.log('[Harbor] Browser features:', getFeatureSummary());

// =============================================================================
// Service Worker Lifecycle (Chrome MV3)
// =============================================================================

// Handle extension startup (Chrome MV3 service worker restart)
serviceWorkerLifecycle.onStartup(() => {
  console.log('[Harbor] Service worker startup - restoring state...');
  // Re-initialize connections that may have been lost
  initializeBridgeClient();
});

// Handle extension install/update
serviceWorkerLifecycle.onInstalled((details) => {
  console.log(`[Harbor] Extension ${details.reason}${details.previousVersion ? ` from ${details.previousVersion}` : ''}`);
  if (details.reason === 'install') {
    // First-time setup
    console.log('[Harbor] First install - initializing...');
  } else if (details.reason === 'update') {
    // Handle migration if needed
    console.log('[Harbor] Extension updated');
  }
});

// Handle service worker suspend (Chrome MV3)
serviceWorkerLifecycle.onSuspend(() => {
  console.log('[Harbor] Service worker suspending - saving state...');
  // Save any in-memory state that needs to persist
});

// Initialize modules
initializePolicyStore();

// Connect to native bridge (all communication goes through stdio)
initializeBridgeClient();
initializeMcpHost();

// Initialize extension API for other extensions to call Harbor
initializeExtensionApi();

// Initialize agent router for web page API (content script transport)
initializeRouter();

// Cleanup expired permission grants on startup
cleanupExpiredGrants();

// =============================================================================
// Legacy Message Handlers (for sidebar and other internal UIs)
// =============================================================================

// Debug: log all incoming messages
browserAPI.runtime.onMessage.addListener((message) => {
  console.log('[Harbor] Incoming message:', message?.type, message);
  return false; // Don't handle, let other listeners process
});

// Debug: expose callTool for console testing
(globalThis as Record<string, unknown>).debugCallTool = callTool;

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'sidebar_get_servers') {
    return false;
  }
  (async () => {
    const servers = await listServersWithStatus();
    sendResponse({ ok: true, servers });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'sidebar_start_server') {
    return false;
  }
  const serverId = message.serverId as string | undefined;
  if (!serverId) {
    sendResponse({ ok: false, error: 'Missing serverId' });
    return true;
  }
  (async () => {
    const started = await startServer(serverId);
    sendResponse({ ok: started });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'sidebar_stop_server') {
    return false;
  }
  const serverId = message.serverId as string | undefined;
  if (!serverId) {
    sendResponse({ ok: false, error: 'Missing serverId' });
    return true;
  }
  try {
    const stopped = stopServer(serverId);
    sendResponse({ ok: stopped });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'sidebar_install_server') {
    return false;
  }
  const manifest = message.manifest as { id?: string };
  if (!manifest?.id) {
    sendResponse({ ok: false, error: 'Missing manifest id' });
    return true;
  }
  (async () => {
    await addServer(message.manifest);
    sendResponse({ ok: true });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'sidebar_validate_server') {
    return false;
  }
  const serverId = message.serverId as string | undefined;
  if (!serverId) {
    sendResponse({ ok: false, error: 'Missing serverId' });
    return true;
  }
  (async () => {
    const result = await validateAndStartServer(serverId);
    sendResponse(result);
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'sidebar_remove_server') {
    return false;
  }
  const serverId = message.serverId as string | undefined;
  if (!serverId) {
    sendResponse({ ok: false, error: 'Missing serverId' });
    return true;
  }
  (async () => {
    await removeServer(serverId);
    sendResponse({ ok: true });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

// =============================================================================
// Bridge Status Handlers
// =============================================================================

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'bridge_get_status') {
    return false;
  }
  const state = getBridgeConnectionState();
  sendResponse({ ok: true, ...state });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'bridge_check_health') {
    return false;
  }
  (async () => {
    await checkBridgeHealth();
    const state = getBridgeConnectionState();
    sendResponse({ ok: true, ...state });
  })().catch((error) => {
    sendResponse({
      ok: false,
      connected: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

// =============================================================================
// LLM Configuration Handlers
// =============================================================================

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_list_providers') {
    return false;
  }
  (async () => {
    const result = await bridgeRequest<{ providers: unknown[]; default_provider?: string }>('llm.list_providers');
    sendResponse({ ok: true, providers: result.providers, default_provider: result.default_provider });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_list_provider_types') {
    return false;
  }
  (async () => {
    const result = await bridgeRequest<{ provider_types: unknown[] }>('llm.list_provider_types');
    sendResponse({ ok: true, provider_types: result.provider_types });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_get_config') {
    return false;
  }
  (async () => {
    const result = await bridgeRequest<{ default_model?: string; providers: Record<string, unknown> }>('llm.get_config');
    sendResponse({ ok: true, config: result });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_configure_provider') {
    return false;
  }
  const { id, provider, name, api_key, base_url, enabled } = message as {
    id?: string;
    provider?: string;
    name?: string;
    api_key?: string;
    base_url?: string;
    enabled?: boolean;
  };
  if (!provider && !id) {
    sendResponse({ ok: false, error: 'Missing provider or id' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{ ok: boolean; id: string }>('llm.configure_provider', {
      id,
      provider,
      name,
      api_key,
      base_url,
      enabled,
    });
    sendResponse({ ok: result.ok, id: result.id });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_set_default_provider') {
    return false;
  }
  const { id } = message as { id?: string };
  if (!id) {
    sendResponse({ ok: false, error: 'Missing id' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{ ok: boolean; default_provider: string }>('llm.set_default_provider', { id });
    sendResponse({ ok: result.ok, default_provider: result.default_provider });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_remove_provider') {
    return false;
  }
  const { id } = message as { id?: string };
  if (!id) {
    sendResponse({ ok: false, error: 'Missing id' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{ ok: boolean }>('llm.remove_provider', { id });
    sendResponse({ ok: result.ok });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_check_provider') {
    return false;
  }
  const { provider } = message as { provider?: string };
  if (!provider) {
    sendResponse({ ok: false, error: 'Missing provider' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{ provider: string; available: boolean; error?: string }>('llm.check_provider', { provider });
    sendResponse({ ok: true, status: result });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_list_models') {
    return false;
  }
  (async () => {
    const result = await bridgeRequest<{ models: unknown[] }>('llm.list_models');
    sendResponse({ ok: true, models: result.models });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_set_default_model') {
    return false;
  }
  const { model } = message as { model?: string };
  if (!model) {
    sendResponse({ ok: false, error: 'Missing model' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{ ok: boolean; default_model: string }>('llm.set_default_model', { model });
    sendResponse({ ok: result.ok, default_model: result.default_model });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

// =============================================================================
// Configured Models Handlers
// =============================================================================

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_list_configured_models') {
    return false;
  }
  (async () => {
    const result = await bridgeRequest<{ models: unknown[] }>('llm.list_configured_models');
    sendResponse({ ok: true, models: result.models });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_add_configured_model') {
    return false;
  }
  const { model_id, name } = message as { model_id?: string; name?: string };
  if (!model_id) {
    sendResponse({ ok: false, error: 'Missing model_id' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{ ok: boolean; name: string; model_id: string }>('llm.add_configured_model', { model_id, name });
    sendResponse({ ok: result.ok, name: result.name, model_id: result.model_id });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_remove_configured_model') {
    return false;
  }
  const { name } = message as { name?: string };
  if (!name) {
    sendResponse({ ok: false, error: 'Missing name' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{ ok: boolean }>('llm.remove_configured_model', { name });
    sendResponse({ ok: result.ok });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_set_configured_model_default') {
    return false;
  }
  const { name } = message as { name?: string };
  if (!name) {
    sendResponse({ ok: false, error: 'Missing name' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{ ok: boolean; default: string }>('llm.set_configured_model_default', { name });
    sendResponse({ ok: result.ok, default: result.default });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_test_model') {
    return false;
  }
  const { model } = message as { model?: string };
  if (!model) {
    sendResponse({ ok: false, error: 'Missing model' });
    return true;
  }
  (async () => {
    console.log('[Harbor] Testing model:', model);
    const result = await bridgeRequest<{ message?: { content?: string }; content?: string }>('llm.chat', {
      model,
      messages: [{ role: 'user', content: 'Say "hello" in exactly one word.' }],
      max_tokens: 10,
    });
    const response = result.message?.content || result.content || '';
    console.log('[Harbor] Test result:', response);
    sendResponse({ ok: true, response });
  })().catch((error) => {
    console.error('[Harbor] Test failed:', error);
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

// Generic bridge RPC passthrough (used by demo-bootstrap)
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'bridge_rpc') {
    return false;
  }
  const { method, params } = message as { method?: string; params?: unknown };
  if (!method) {
    sendResponse({ ok: false, error: 'Missing method' });
    return true;
  }
  (async () => {
    console.log('[Harbor] bridge_rpc:', method);
    const result = await bridgeRequest(method, params);
    sendResponse({ ok: true, result });
  })().catch((error) => {
    console.error('[Harbor] bridge_rpc error:', error);
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'sidebar_call_tool') {
    return false;
  }
  const { serverId, toolName, args } = message as { serverId?: string; toolName?: string; args?: Record<string, unknown> };
  console.log('[Harbor] sidebar_call_tool:', serverId, toolName, args);
  if (!serverId || !toolName) {
    sendResponse({ ok: false, error: 'Missing serverId or toolName' });
    return true;
  }
  (async () => {
    console.log('[Harbor] Calling tool...');
    const result = await callTool(serverId, toolName, args || {});
    console.log('[Harbor] Tool result:', result);
    sendResponse(result);
  })().catch((error) => {
    console.error('[Harbor] Tool error:', error);
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

// Handler for calling MCP methods directly (e.g., tools/list)
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'mcp_call_method') {
    return false;
  }
  const { serverId, method, params } = message as { serverId?: string; method?: string; params?: Record<string, unknown> };
  console.log('[Harbor] mcp_call_method:', serverId, method, params);
  if (!serverId || !method) {
    sendResponse({ ok: false, error: 'Missing serverId or method' });
    return true;
  }
  (async () => {
    const { callMcpMethod } = await import('./wasm/runtime');
    const result = await callMcpMethod(serverId, method, params);
    console.log('[Harbor] MCP method result:', result);
    if (result.error) {
      sendResponse({ ok: false, error: result.error.message });
    } else {
      sendResponse({ ok: true, result: result.result });
    }
  })().catch((error) => {
    console.error('[Harbor] MCP method error:', error);
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'llm_chat') {
    return false;
  }
  const { messages, model } = message as { 
    messages?: Array<{ role: string; content: string }>;
    model?: string;
  };
  if (!messages || messages.length === 0) {
    sendResponse({ ok: false, error: 'Missing messages' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{ 
      response: { role: string; content: string };
      model: string;
    }>('llm.chat', { messages, model });
    sendResponse({ ok: true, response: result.response, model: result.model });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

// =============================================================================
// Native Bridge Status Handler
// =============================================================================

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'native_bridge_status') {
    return false;
  }
  const state = getNativeConnectionState();
  sendResponse({ ok: true, ...state });
  return true;
});

// =============================================================================
// Permission Management Handlers
// =============================================================================

const WEB_AGENTS_API_EXTENSION_ID = 'web-agents-api@mozilla.org';

type ExternalPermissionStatusEntry = {
  origin: string;
  scopes: Record<string, string>;
  allowedTools?: string[];
  source?: 'harbor' | 'web-agents-api';
};

async function fetchWebAgentsPermissions(): Promise<ExternalPermissionStatusEntry[]> {
  try {
    const response = await browserAPI.runtime.sendMessage(WEB_AGENTS_API_EXTENSION_ID, {
      type: 'web_agents_permissions.list_all',
    }) as { ok?: boolean; permissions?: ExternalPermissionStatusEntry[] };

    if (!response?.ok || !response.permissions) {
      return [];
    }

    return response.permissions.map((entry) => ({
      ...entry,
      source: 'web-agents-api',
    }));
  } catch {
    return [];
  }
}

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'list_all_permissions') {
    return false;
  }
  (async () => {
    const permissions = await listAllPermissions();
    const webAgentsPermissions = await fetchWebAgentsPermissions();
    const merged: ExternalPermissionStatusEntry[] = [
      ...permissions.map((entry) => ({ ...entry, source: 'harbor' as const })),
      ...webAgentsPermissions,
    ];
    sendResponse({ type: 'list_all_permissions_result', permissions: merged });
  })().catch((error) => {
    sendResponse({
      type: 'list_all_permissions_result',
      permissions: [],
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'revoke_origin_permissions') {
    return false;
  }
  const { origin, source } = message as { origin?: string; source?: 'harbor' | 'web-agents-api' };
  if (!origin) {
    sendResponse({ ok: false, error: 'Missing origin' });
    return true;
  }
  (async () => {
    if (source === 'web-agents-api') {
      await browserAPI.runtime.sendMessage(WEB_AGENTS_API_EXTENSION_ID, {
        type: 'web_agents_permissions.revoke_origin',
        origin,
      });
    } else {
      await revokePermissions(origin);
    }

    // Notify sidebar to refresh
    browserAPI.runtime.sendMessage({ type: 'permissions_changed' }).catch(() => {});
    sendResponse({ ok: true });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

// =============================================================================
// OAuth Handlers
// =============================================================================

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'oauth_start_flow') {
    return false;
  }
  const { provider, server_id, scopes } = message as {
    provider?: string;
    server_id?: string;
    scopes?: string[];
  };
  if (!provider || !server_id || !scopes?.length) {
    sendResponse({ ok: false, error: 'Missing provider, server_id, or scopes' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{ auth_url: string; state: string }>('oauth.start_flow', {
      provider,
      server_id,
      scopes,
    });
    // Open the auth URL in a new tab
    browserAPI.tabs.create({ url: result.auth_url });
    sendResponse({ ok: true, state: result.state });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'oauth_status') {
    return false;
  }
  const { server_id } = message as { server_id?: string };
  if (!server_id) {
    sendResponse({ ok: false, error: 'Missing server_id' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{
      authenticated: boolean;
      provider?: string;
      scopes?: string[];
      is_expired?: boolean;
      expires_at?: number;
      has_refresh_token?: boolean;
    }>('oauth.status', { server_id });
    sendResponse({ ok: true, ...result });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'oauth_get_tokens') {
    return false;
  }
  const { server_id } = message as { server_id?: string };
  if (!server_id) {
    sendResponse({ ok: false, error: 'Missing server_id' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{
      has_tokens: boolean;
      access_token?: string;
      expires_at?: number;
      provider?: string;
      scopes?: string[];
    }>('oauth.get_tokens', { server_id });
    sendResponse({ ok: true, ...result });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'oauth_revoke') {
    return false;
  }
  const { server_id } = message as { server_id?: string };
  if (!server_id) {
    sendResponse({ ok: false, error: 'Missing server_id' });
    return true;
  }
  (async () => {
    await bridgeRequest<{ success: boolean }>('oauth.revoke', { server_id });
    sendResponse({ ok: true });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'oauth_list_providers') {
    return false;
  }
  (async () => {
    const result = await bridgeRequest<{
      providers: Array<{
        id: string;
        name: string;
        configured: boolean;
        scopes?: Record<string, string>;
      }>;
    }>('oauth.list_providers');
    sendResponse({ ok: true, providers: result.providers });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

// OAuth Credentials Management
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'oauth_get_credentials_status') {
    return false;
  }
  (async () => {
    const result = await bridgeRequest<{
      providers: Record<string, {
        configured: boolean;
        client_id_preview?: string;
      }>;
    }>('oauth.get_credentials_status');
    sendResponse({ ok: true, ...result });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'oauth_set_credentials') {
    return false;
  }
  const { provider, client_id, client_secret } = message as {
    provider?: string;
    client_id?: string;
    client_secret?: string;
  };
  if (!provider || !client_id || !client_secret) {
    sendResponse({ ok: false, error: 'Missing required fields' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{
      success: boolean;
      provider: string;
    }>('oauth.set_credentials', { provider, client_id, client_secret });
    sendResponse({ ok: true, ...result });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'oauth_remove_credentials') {
    return false;
  }
  const { provider } = message as { provider?: string };
  if (!provider) {
    sendResponse({ ok: false, error: 'Missing provider' });
    return true;
  }
  (async () => {
    const result = await bridgeRequest<{
      success: boolean;
      provider: string;
    }>('oauth.remove_credentials', { provider });
    sendResponse({ ok: true, ...result });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

// =============================================================================
// Feature Flags Handlers
// =============================================================================

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'getFeatureFlags') {
    return false;
  }
  (async () => {
    const flags = await getFeatureFlags();
    sendResponse(flags);
  })().catch((error) => {
    console.error('[Harbor] getFeatureFlags error:', error);
    // Return safe defaults on error
    sendResponse({
      browserInteraction: false,
      screenshots: false,
      experimental: false,
      browserControl: false,
      multiAgent: false,
    });
  });
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'setFeatureFlags') {
    return false;
  }
  const flags = message.flags as Partial<FeatureFlags> | undefined;
  if (!flags) {
    sendResponse({ ok: false, error: 'Missing flags' });
    return true;
  }
  (async () => {
    await setFeatureFlags(flags);
    const updated = await getFeatureFlags();
    sendResponse({ ok: true, flags: updated });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
});

// =============================================================================
// Session Handlers (for sidebar)
// =============================================================================

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'session.list') {
    return false;
  }
  const { origin, status, type, activeOnly } = message as {
    origin?: string;
    status?: 'active' | 'suspended' | 'terminated';
    type?: 'implicit' | 'explicit';
    activeOnly?: boolean;
  };
  try {
    const sessions = SessionRegistry.listSessions({ origin, status, type, activeOnly });
    sendResponse({ ok: true, sessions });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'session.terminate') {
    return false;
  }
  const { sessionId, origin } = message as { sessionId?: string; origin?: string };
  if (!sessionId || !origin) {
    sendResponse({ ok: false, error: 'Missing sessionId or origin' });
    return true;
  }
  try {
    const terminated = SessionRegistry.terminateSession(sessionId, origin);
    sendResponse({ ok: true, terminated });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
});

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'session.get') {
    return false;
  }
  const { sessionId } = message as { sessionId?: string };
  if (!sessionId) {
    sendResponse({ ok: false, error: 'Missing sessionId' });
    return true;
  }
  try {
    const session = SessionRegistry.getSession(sessionId);
    if (!session) {
      sendResponse({ ok: false, error: 'Session not found' });
    } else {
      sendResponse({ ok: true, session });
    }
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
});

// =============================================================================
// Page Chat Message Handler
// =============================================================================

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'page_chat_message') {
    return false;
  }
  
  const { chatId, message: userMessage, systemPrompt, tools, pageContext } = message as {
    chatId?: string;
    message?: string;
    systemPrompt?: string;
    tools?: string[];
    pageContext?: { url: string; title: string };
  };

  console.log('[Harbor] page_chat_message:', chatId, userMessage?.slice(0, 50));

  if (!userMessage) {
    sendResponse({ type: 'error', error: { message: 'Missing message' } });
    return true;
  }

  (async () => {
    try {
      // Build messages array
      const messages = [
        { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
        { role: 'user', content: userMessage },
      ];

      // If tools are requested, we could add them here
      // For now, do a simple chat request
      const toolsUsed: Array<{ name: string }> = [];

      // Call the LLM via bridge
      const result = await bridgeRequest<{
        choices?: Array<{ message?: { content?: string; role?: string } }>;
        message?: { content?: string };
        content?: string;
      }>('llm.chat', {
        messages,
        max_tokens: 2000,
      });

      // Extract response text
      let responseText = result.choices?.[0]?.message?.content
        || result.message?.content
        || result.content
        || '';

      console.log('[Harbor] page_chat_message response:', responseText.slice(0, 100));

      sendResponse({
        type: 'page_chat_response',
        response: responseText,
        toolsUsed,
      });
    } catch (err) {
      console.error('[Harbor] page_chat_message error:', err);
      sendResponse({
        type: 'error',
        error: { message: err instanceof Error ? err.message : 'Unknown error' },
      });
    }
  })();

  return true;
});

// =============================================================================
// Open Page Chat Handler (for sidebar button)
// =============================================================================

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'open_page_chat') {
    return false;
  }
  const tabId = message.tabId as number | undefined;
  if (!tabId) {
    sendResponse({ ok: false, error: 'Missing tabId' });
    return true;
  }
  (async () => {
    try {
      // Inject page-chat.js into the tab
      await browserAPI.scripting.executeScript({
        target: { tabId },
        files: ['dist/page-chat.js'],
      });
      console.log('[Harbor] Page chat injected into tab', tabId);
      sendResponse({ ok: true });
    } catch (err) {
      console.error('[Harbor] Failed to inject page chat:', err);
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to open page chat',
      });
    }
  })();
  return true;
});

console.log('[Harbor] Extension initialized.');
